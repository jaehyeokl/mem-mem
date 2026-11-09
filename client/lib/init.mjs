// `memmem init`: ask the four questions of Letta Code's /init (research depth,
// other repositories, communication style, past-session consent), summarize
// the code repo, optionally collect this project's past sessions, and push a
// request to the transcripts repo under bootstrap/<member>/ for the memory
// server. The question wording is adapted from the `initializing-memory` skill
// of Letta Code (Apache-2.0, https://github.com/letta-ai/letta-code).
import fs from "node:fs";
import path from "node:path";
import { discoverSessions, formatBytes, summarize } from "./history.mjs";
import { createPrompter, yesNo } from "./prompt.mjs";
import { VERSION } from "./runtime.mjs";
import { redactString } from "./secrets.mjs";
import { memberAliases, projectInitState, pullTranscripts, readJsonOrNull, readMyRequest } from "./status.mjs";
import {
  commitAndPush, ensureClone, findConfig, git, languageOf, LAYOUT_VERSION, preparePull, projectPaths, repoUrl, stripCredentials, withLock,
} from "./util.mjs";

export const INIT_BOOLEANS = ["dryRun", "yes", "historyOnly", "reinit", "state"];
export const USAGE = `usage: memmem init [--depth standard|deep] [--repos a,b] [--style "<text>"] [--history yes|no] [--history-only] [--reinit] [--dry-run] [--yes]
       memmem init --state                 (JSON: the project's init state and this machine's past sessions)
       memmem init --answer "<text>"`;

export const QUESTIONS = {
  en: {
    depth: "Research depth: standard (docs, manifests, entry points, recent history) or deep (more areas, git-history conventions, end-to-end tracing; slower)",
    repos: "Other repositories the team memory should know about (comma separated org/repo, or none)",
    style: "Communication style you want from coding agents (free text, or none)",
    history: (s) => `Upload ${s} of this project for analysis? Redacted copies go to the team's private transcripts repo (everyone with access can read them), and the memory server's read-only subagents read them (yes/no)`,
    noHistory: "No past Claude Code or Codex sessions of this project were found on this machine.",
  },
  ko: {
    depth: "조사 깊이: standard(문서, 매니페스트, 엔트리 포인트, 최근 기록) 또는 deep(더 많은 영역, git 기록의 관례, 끝까지 추적; 느림)",
    repos: "팀 메모리가 알아야 할 다른 저장소 (쉼표로 구분한 org/repo, 없으면 none)",
    style: "코딩 에이전트에게 원하는 소통 스타일 (자유 입력, 없으면 none)",
    history: (s) => `이 프로젝트의 ${s}을 분석용으로 올릴까요? 비밀값을 지운 사본이 팀의 비공개 트랜스크립트 레포에 올라가고(접근 권한이 있는 모두가 읽을 수 있음), 메모리 서버의 읽기 전용 서브에이전트가 읽습니다 (yes/no)`,
    noHistory: "이 머신에서 이 프로젝트의 과거 Claude Code·Codex 세션을 찾지 못했습니다.",
  },
};

function describeSessions(sum, language) {
  const parts = Object.entries(sum.byTool).map(([t, v]) => `${v.sessions} ${t}`);
  const s = `${parts.join(" + ")} session(s), ${formatBytes(sum.total.bytes)}, ${sum.total.redactions} redaction(s)`;
  return language === "ko" ? `과거 세션 ${s}` : `past sessions (${s})`;
}

const NONE = /^(none|no|n\/a|-|없음)?$/i;

/** Normalize answers from flags / prompts. Returns { answers } or { error }. */
export function normalizeAnswers({ depth, repos, style, history }) {
  const d = depth ?? "standard";
  if (!["standard", "deep"].includes(d)) return { error: "--depth must be standard or deep" };
  const list = Array.isArray(repos) ? repos : String(repos ?? "").split(",");
  const r = list.map((x) => x.trim()).filter((x) => x && !NONE.test(x));
  const st = String(style ?? "").trim();
  const h = history === undefined || history === true || history === false ? history ?? false : yesNo(history);
  if (h === null) return { error: "--history must be yes or no" };
  return { answers: { depth: d, repos: r, style: NONE.test(st) ? "" : st, history: h } };
}

/** Code summary (no code is sent; the server clones the repo itself). */
export function codeSummary(dir, run = git) {
  const g = (args) => { const r = run(args, { cwd: dir, timeout: 20_000 }); return r.ok ? r.stdout : ""; };
  const remote = stripCredentials(g(["remote", "get-url", "origin"]));
  return {
    branch: g(["rev-parse", "--abbrev-ref", "HEAD"]) || null,
    status: g(["status", "--short"]),
    log: g(["log", "--oneline", "-n", "10"]),
    shortlog: g(["shortlog", "-sn", "--all"]).split("\n").slice(0, 5).join("\n"),
    remote: remote || null,
  };
}

/** The request document written to bootstrap/<member>/request.json. */
export function buildRequest({ answers, summary, member, project, language, historyOnly, reinit, sessions, now = new Date() }) {
  const req = {
    layoutVersion: LAYOUT_VERSION,
    memmemVersion: VERSION,
    requestedAt: now.toISOString(),
    project,
    member,
    language,
    historyOnly: Boolean(historyOnly),
    answers,
    codeRepo: summary?.remote ?? null,
    codeSummary: summary ?? null,
    sessions,
  };
  // An explicit re-initialization even after the project is initialized (the server re-runs the code research).
  if (reinit) req.reinit = true;
  return req;
}

async function gatherAnswers(args, { prompter, language, discover }) {
  const Q = QUESTIONS[language];
  const raw = { depth: args.depth, repos: args.repos, style: args.style, history: args.history };
  if (!args.historyOnly) {
    if (raw.depth === undefined && prompter) raw.depth = await prompter.ask(Q.depth, "standard");
    if (raw.repos === undefined && prompter) raw.repos = await prompter.ask(Q.repos, "none");
    if (raw.style === undefined && prompter) raw.style = await prompter.ask(Q.style, "none");
  }
  let discovered = null;
  if (raw.history === undefined && prompter) {
    discovered = await discover();
    const sum = summarize(discovered);
    if (sum.total.sessions === 0) { raw.history = "no"; process.stdout.write(`${Q.noHistory}\n`); }
    else raw.history = await prompter.ask(Q.history(describeSessions(sum, language)), "no");
  }
  // Without an explicit yes nothing is uploaded: --yes alone means history=no.
  return { ...normalizeAnswers(raw), discovered };
}

function printPlan(out, { discovered, request }) {
  const sum = summarize(discovered);
  out.write(`past sessions of this project on this machine: ${sum.total.sessions} (${formatBytes(sum.total.bytes)}, ${sum.total.redactions} redaction(s))\n`);
  for (const [tool, v] of Object.entries(sum.byTool)) out.write(`  ${tool}: ${v.sessions} session(s), ${formatBytes(v.bytes)}, ${v.redactions} redaction(s)\n`);
  for (const s of discovered.sessions) out.write(`    ${s.file}  ${s.userMessages} prompt(s)  ${formatBytes(s.bytes)}  ${s.redactions ? `${s.redactions} redacted  ` : ""}${s.sourcePath}\n`);
  if (sum.skipped) out.write(`  skipped: ${sum.skipped} (${discovered.errors.map((e) => e.error).slice(0, 3).join("; ")})\n`);
  out.write(`request${request.answers.history ? "" : " (sessions would NOT be uploaded: --history is not yes)"}:\n${JSON.stringify(request, null, 2)}\n`);
}

/**
 * `memmem init --state`: one JSON object the skills branch on (pulls the
 * transcripts clone first; uploads nothing):
 * { project, member, projectInit: projectInitState(...), localSessions: {total, byTool, bytes, redactions}, pulled }
 */
async function printState(found, paths, discover, out) {
  const pulled = pullTranscripts(found, paths);
  const aliases = memberAliases(paths.transcripts, paths.member);
  const projectInit = projectInitState({
    initStatus: readJsonOrNull(path.join(paths.transcripts, "bootstrap", "status.json")),
    request: readMyRequest(paths.transcripts, [paths.member, ...aliases]),
    member: paths.member,
    aliases,
  });
  let localSessions = null;
  try {
    const sum = summarize(await discover());
    localSessions = { total: sum.total.sessions, byTool: Object.fromEntries(Object.entries(sum.byTool).map(([t, v]) => [t, v.sessions])), bytes: sum.total.bytes, redactions: sum.total.redactions };
  } catch { /* discovery is best-effort */ }
  out.write(JSON.stringify({ project: paths.project, member: paths.member, projectInit, localSessions, pulled: pulled.pulled }, null, 2) + "\n");
  return 0;
}

/** `memmem init --answer "<text>"`: bootstrap/<member>/answer-<n>.md. */
function sendAnswer(paths, text, out, err) {
  const cl = ensureClone(repoUrl(paths.transcriptsSpec), paths.transcripts);
  if (!cl.ok) { err.write(`memmem init: cannot clone transcripts repo: ${cl.error}\n`); return 1; }
  return withLock(paths.lock, () => {
    preparePull(paths.transcripts, paths.member);
    const dir = path.join(paths.transcripts, "bootstrap", paths.member);
    fs.mkdirSync(dir, { recursive: true });
    let n = 1;
    while (fs.existsSync(path.join(dir, `answer-${n}.md`))) n++;
    const rel = path.posix.join("bootstrap", paths.member, `answer-${n}.md`);
    fs.writeFileSync(path.join(paths.transcripts, rel), `---\nmember: ${paths.member}\ncreated: ${new Date().toISOString()}\n---\n\n${redactString(text).trim()}\n`);
    const res = commitAndPush(paths.transcripts, [rel], `init answer: ${paths.member} #${n}`, { member: paths.member });
    if (!res.ok) { err.write(`memmem init: answer saved locally but push failed: ${res.error}\n`); return 1; }
    out.write(`sent ${rel}\nprogress: memmem status\n`);
    return 0;
  });
}

function readManifest(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    return m && typeof m === "object" && Array.isArray(m.sessions) ? m : null;
  } catch { return null; }
}

/**
 * Pure: merge this export into the manifest already in bootstrap/<member>/
 * (another device of the same member, or an earlier export). Sessions are a
 * union by sessionId: an existing entry is kept unless the new one is larger
 * (`bytes`); a session already uploaded under an alias directory
 * (`aliasIds`) is not uploaded again. Errors are concatenated (exact
 * duplicates dropped) and the per-source counts recomputed.
 * Returns { manifest, write: [sessions to write], remove: [old files], counts: {new, updated, already} }.
 */
export function mergeManifest(existing, { outDir, discovered, member, aliasIds = new Set(), now = new Date() }) {
  const cur = existing && Array.isArray(existing.sessions) ? existing : { sessions: [], errors: [] };
  const byId = new Map(cur.sessions.filter((s) => s && typeof s.sessionId === "string").map((s) => [s.sessionId, s]));
  const usedFiles = new Set([...byId.values()].map((s) => s.file));
  const write = [];
  const remove = [];
  const counts = { new: 0, updated: 0, already: 0 };
  for (const s of discovered.sessions) {
    const { json, ...meta } = s;
    if (aliasIds.has(s.sessionId)) { counts.already += 1; continue; }
    const prev = byId.get(s.sessionId);
    if (prev && !((s.bytes ?? 0) > (prev.bytes ?? 0))) { counts.already += 1; continue; }
    if (prev) { usedFiles.delete(prev.file); if (prev.file !== meta.file) remove.push(prev.file); }
    // Another session's file under the same name (unlikely: names carry the session id): pick a free one.
    let file = meta.file;
    for (let n = 2; usedFiles.has(file); n++) file = meta.file.replace(/(\.json)?$/, `-${n}.json`);
    usedFiles.add(file);
    const entry = { ...meta, file };
    byId.set(s.sessionId, entry);
    write.push({ ...entry, json });
    counts[prev ? "updated" : "new"] += 1;
  }
  const sessions = [...byId.values()].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const seenErr = new Set();
  const errors = [...(Array.isArray(cur.errors) ? cur.errors : []), ...discovered.errors].filter((e) => { const k = JSON.stringify(e); if (seenErr.has(k)) return false; seenErr.add(k); return true; });
  const sources = {};
  for (const src of new Set([...Object.keys(cur.sources ?? {}), ...Object.keys(discovered.sources ?? {})])) sources[src] = { discovered: 0, exported: 0 };
  for (const x of sessions) { const c = (sources[x.source] ||= { discovered: 0, exported: 0 }); c.discovered += 1; c.exported += 1; }
  // A session that was found but not exported (its error names the file) still counts as discovered.
  for (const e of errors) if (e?.source && e.sourcePath) (sources[e.source] ||= { discovered: 0, exported: 0 }).discovered += 1;
  return { manifest: { version: 1, generatedAt: now.toISOString(), outDir, member, sources, errors, sessions }, write, remove, counts };
}

/** Session ids in bootstrap/<alias>/manifest.json for each alias (those directories are left as they are). */
export function aliasSessionIds(transcriptsDir, aliases = []) {
  const ids = new Set();
  for (const a of aliases) {
    for (const s of readManifest(path.join(transcriptsDir, "bootstrap", a, "manifest.json"))?.sessions ?? []) if (typeof s?.sessionId === "string") ids.add(s.sessionId);
  }
  return ids;
}

/**
 * Write bootstrap/<member>/ in the transcripts clone: session files, manifest,
 * request.json. A new request replaces the member's request and answers; the
 * sessions and manifest already there (another device of the same member, an
 * earlier export) are merged with this export (mergeManifest), and sessions
 * already uploaded under one of the member's aliases are not uploaded again.
 * With history, `request.sessions` becomes the merged manifest's session count; a
 * request without history leaves the uploaded sessions in place. Returns the
 * repo-relative base, the paths written, and the session counts.
 */
export function writeBootstrap(transcriptsDir, member, { request, discovered, aliases = [], now = new Date() }) {
  const relBase = path.posix.join("bootstrap", member);
  const base = path.join(transcriptsDir, relBase);
  fs.mkdirSync(base, { recursive: true });
  for (const f of fs.readdirSync(base)) if (f === "request.json" || /^answer-\d+\.md$/.test(f)) fs.rmSync(path.join(base, f), { force: true });
  const existing = readManifest(path.join(base, "manifest.json"));
  const written = [];
  let counts = { new: 0, updated: 0, already: 0 };
  if (discovered && request.answers.history) {
    const m = mergeManifest(existing, { outDir: relBase, discovered, member, aliasIds: aliasSessionIds(transcriptsDir, aliases.filter((a) => a && a !== member)), now });
    counts = m.counts;
    for (const f of m.remove) fs.rmSync(path.join(base, f), { force: true });
    for (const s of m.write) {
      fs.mkdirSync(path.join(base, path.dirname(s.file)), { recursive: true });
      fs.writeFileSync(path.join(base, s.file), s.json);
      written.push(path.posix.join(relBase, s.file));
    }
    if (m.write.length || m.remove.length || !existing) {
      fs.writeFileSync(path.join(base, "manifest.json"), JSON.stringify(m.manifest, null, 2) + "\n");
      written.push(path.posix.join(relBase, "manifest.json"));
    }
    request.sessions = m.manifest.sessions.length;
  }
  fs.writeFileSync(path.join(base, "request.json"), JSON.stringify(request, null, 2) + "\n");
  written.push(path.posix.join(relBase, "request.json"));
  return { relBase, written, counts, total: request.sessions };
}

export async function runInit(args, { out = process.stdout, err = process.stderr, prompter, discover: discoverImpl } = {}) {
  const found = findConfig(args.cwd || process.cwd());
  if (!found) { err.write("memmem init: not a team project (no .memmem/config.json). Run `memmem setup` first.\n"); return 1; }
  const paths = { ...projectPaths(found.config, found.dir), transcriptsSpec: found.config.transcriptsRepo };
  if (paths.member === "unknown") { err.write("memmem init: no member handle; run `memmem setup` (the member is your GitHub login)\n"); return 1; }
  const language = languageOf(found.config);
  if (typeof args.answer === "string") return sendAnswer(paths, args.answer, out, err);
  if (args.answer === true) { err.write(`memmem init: --answer needs text\n${USAGE}\n`); return 2; }

  const discover = discoverImpl || (() => discoverSessions({ projectDir: found.dir }));
  if (args.state) return printState(found, paths, discover, out);
  if (args.reinit && args.historyOnly) { err.write(`memmem init: --reinit and --history-only exclude each other\n${USAGE}\n`); return 2; }
  const ownPrompter = prompter === undefined;
  prompter = ownPrompter ? createPrompter({ yes: args.yes || args.dryRun }) : prompter;
  let gathered;
  try { gathered = await gatherAnswers(args, { prompter, language, discover }); } finally { if (ownPrompter) prompter?.close(); }
  if (gathered.error) { err.write(`memmem init: ${gathered.error}\n${USAGE}\n`); return 2; }
  const { answers } = gathered;
  if (args.historyOnly && !answers.history && !args.dryRun) { err.write("memmem init: --history-only needs --history yes\n"); return 2; }
  const discovered = gathered.discovered || (answers.history || args.dryRun ? await discover() : null);
  const summary = args.historyOnly ? null : codeSummary(found.dir);
  // --history-only (a session contribution) carries no depth, but keeps a style / repos given as flags.
  const hoAnswers = { history: answers.history };
  if (args.historyOnly && args.style !== undefined && answers.style) hoAnswers.style = answers.style;
  if (args.historyOnly && args.repos !== undefined && answers.repos.length) hoAnswers.repos = answers.repos;
  const request = buildRequest({
    answers: args.historyOnly ? hoAnswers : answers,
    summary, member: paths.member, project: paths.project, language, historyOnly: args.historyOnly, reinit: args.reinit,
    sessions: answers.history && discovered ? discovered.sessions.length : 0,
  });

  if (args.dryRun) { printPlan(out, { discovered, request }); return 0; }

  const cl = ensureClone(repoUrl(found.config.transcriptsRepo), paths.transcripts);
  if (!cl.ok) { err.write(`memmem init: cannot clone transcripts repo: ${cl.error}\n`); return 1; }
  return withLock(paths.lock, () => {
    preparePull(paths.transcripts, paths.member);
    const aliases = memberAliases(paths.transcripts, paths.member);
    const { relBase, counts } = writeBootstrap(paths.transcripts, paths.member, { request, discovered, aliases });
    const added = counts.new + counts.updated;
    const res = commitAndPush(paths.transcripts, [relBase], `init request: ${paths.member}${added ? ` (+${added} sessions)` : ""}`, { member: paths.member });
    if (!res.ok) { err.write(`memmem init: request saved in ${path.join(paths.transcripts, relBase)} but push failed: ${res.error}\n`); return 1; }
    const detail = answers.history && discovered
      ? ` and ${counts.new} new session(s)${counts.updated ? `, ${counts.updated} updated (larger)` : ""}, ${counts.already} already uploaded${request.sessions ? ` (${request.sessions} listed under ${relBase})` : ""}`
      : "";
    out.write(`sent ${relBase}/request.json${detail} to ${found.config.transcriptsRepo}\n`);
    out.write(`the memory server commits the initialized memory to ${repoUrl(found.config.memoryRepo)}\nprogress: memmem status\n`);
    return 0;
  });
}
