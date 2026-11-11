// `memmem status [--watch] [--json]`: what the memory server did with my
// sessions (transcripts repo `ingest/log.jsonl`), the init state
// (`bootstrap/status.json`), and the memory repo's latest commits.
import fs from "node:fs";
import path from "node:path";
import { userInstallState } from "./user.mjs";
import { ensureClone, findConfig, git, modeOf, projectPaths, readLocal, repoUrl, sleepSync } from "./util.mjs";

export const STATUS_BOOLEANS = ["watch", "json"];
export const USAGE = "usage: memmem status [--watch] [--json]   ingest, reflection, and init progress (pulls the transcripts and memory clones)";
export const INIT_STATES = ["queued", "running", "waiting_for_answer", "done", "failed"];

/** Member segment of a transcripts-repo path: trajectories/<YYYY-MM>/<member>/..., inbox/<member>/..., bootstrap/<member>/... */
export function memberOfFile(file) {
  const p = String(file || "").split("/");
  if (p[0] === "trajectories") return p[2] || null;
  if (p[0] === "inbox" || p[0] === "bootstrap") return p[1] || null;
  return null;
}

export function readJsonl(file) {
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a bad line */ }
  }
  return out;
}

export function readJsonOrNull(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

const day = (ts) => (typeof ts === "string" && ts ? ts.slice(0, 10) : null);
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : typeof v === "string" && v ? [v] : []);

/**
 * My older handles: `aliases` of members/<member>.json in the transcripts
 * clone (written by `memmem setup`). Paths and status entries under an alias
 * (bootstrap/<alias>/, trajectories/.../<alias>/, members[alias],
 * requestedBy) are mine.
 */
export function memberAliases(transcriptsDir, member) {
  const doc = readJsonOrNull(path.join(transcriptsDir, "members", `${member}.json`));
  const out = Array.isArray(doc?.aliases) ? doc.aliases.filter((a) => typeof a === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(a) && a !== member) : [];
  return [...new Set(out)];
}

/** My newest bootstrap/<name>/request.json over my handle and aliases (null when none). */
export function readMyRequest(transcriptsDir, names) {
  let best = null;
  for (const n of names) {
    const doc = readJsonOrNull(path.join(transcriptsDir, "bootstrap", n, "request.json"));
    if (!doc || typeof doc !== "object") continue;
    if (!best || String(doc.requestedAt ?? "") > String(best.requestedAt ?? "")) best = doc;
  }
  return best;
}

/**
 * Pure: the project's init state as the skills and `memmem init --state` see it,
 * from bootstrap/status.json ({state, depth, initializedBy, initializedAt,
 * members: {handle: {kind, sessions, finishedAt, state, initId}}, lastRun, ...}).
 * A missing status, or one without some of these fields, reads as their
 * defaults. `aliases` are my older handles: their member entries count as mine.
 * `initialized` is true once a project init has finished (state done, or
 * initializedAt recorded while a later run is going).
 * myContribution.state: reflected | not_reflected | requested | <the member
 * entry's own state, e.g. running/failed>.
 */
export function projectInitState({ initStatus, request, member, aliases = [] }) {
  const st = initStatus && typeof initStatus === "object" ? initStatus : null;
  const names = [member, ...aliases.filter((a) => a && a !== member)];
  let state = "not_requested";
  if (st) state = INIT_STATES.includes(st.state) ? st.state : "unknown";
  else if (request) state = "requested";
  const initialized = Boolean(st && (st.state === "done" || st.initializedAt));
  const members = st && st.members && typeof st.members === "object" ? st.members : {};
  const lastRun = st && st.lastRun && typeof st.lastRun === "object" ? st.lastRun : null;
  const mine = names.map((n) => members[n]).find((e) => e && typeof e === "object") || null;
  let my;
  if (mine && (mine.state === undefined || mine.state === "done")) {
    my = { state: "reflected", sessions: Number(mine.sessions) || 0, kind: mine.kind ?? null, finishedAt: mine.finishedAt ?? null };
  } else if (mine) {
    my = { state: String(mine.state), sessions: Number(mine.sessions) || 0, kind: mine.kind ?? null, finishedAt: mine.finishedAt ?? null };
  } else if (request) {
    my = { state: "requested", requestedAt: request.requestedAt ?? null };
  } else {
    my = { state: "not_reflected" };
  }
  const out = {
    state,
    initialized,
    depth: st?.depth ?? null,
    initializedBy: list(st?.initializedBy),
    initializedAt: st?.initializedAt ?? null,
    myContribution: my,
  };
  const commits = Array.isArray(lastRun?.commits) ? lastRun.commits : Array.isArray(st?.commits) ? st.commits : null;
  if (commits) out.commits = commits.length;
  if (lastRun) out.lastRun = { initId: lastRun.initId ?? null, kind: lastRun.kind ?? null, requestedBy: list(lastRun.requestedBy) };
  const question = st?.question ?? lastRun?.question;
  const error = st?.error ?? lastRun?.error;
  if (state === "waiting_for_answer" && question) out.question = question;
  if (state === "failed" && error) out.error = error;
  return out;
}

/** My trajectory files in the clone (to count what the server has not logged yet). */
function myTrajectoryFiles(transcriptsDir, names) {
  const out = [];
  const root = path.join(transcriptsDir, "trajectories");
  let months = [];
  try { months = fs.readdirSync(root); } catch { return out; }
  for (const m of months) for (const member of names) {
    let tools = [];
    try { tools = fs.readdirSync(path.join(root, m, member)); } catch { continue; }
    for (const t of tools) {
      let files = [];
      try { files = fs.readdirSync(path.join(root, m, member, t)); } catch { continue; }
      for (const f of files) if (f.endsWith(".json")) out.push(path.posix.join("trajectories", m, member, t, f));
    }
  }
  return out;
}

const USAGE_KINDS = ["ingest", "reflection", "init"];

/**
 * A log entry's `usage` in the server's normalized shape ({input, output,
 * cacheRead, cacheWrite, reasoning, total, costUsd}); older entries carry the
 * SDK's raw counters (promptTokens, completionTokens, cachedInputTokens,
 * totalTokens). Null when it has no token counts.
 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const pick = (...keys) => { for (const k of keys) if (typeof raw[k] === "number" && Number.isFinite(raw[k])) return raw[k]; return undefined; };
  const input = pick("input", "promptTokens"), output = pick("output", "completionTokens");
  const cacheRead = pick("cacheRead", "cachedInputTokens"), cacheWrite = pick("cacheWrite", "cacheWriteTokens");
  const total = pick("total", "totalTokens");
  if ([input, output, cacheRead, cacheWrite, total].every((v) => v === undefined)) return null;
  const u = { input: input ?? 0, output: output ?? 0, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0, total: 0, costUsd: typeof raw.costUsd === "number" ? raw.costUsd : null };
  u.total = total ?? u.input + u.output + u.cacheRead + u.cacheWrite;
  return u;
}

/**
 * Pure: token usage of the last `days` days from ingest/log.jsonl entries
 * that carry `usage` (ingest: one turn per part; reflection: one run per
 * entry, carried-forward copies skipped; init: the newest entry per initId,
 * whose usage is the run's running total). Null when no entry in range has usage.
 */
export function usageFromLog(log, { now = Date.now(), days = 7 } = {}) {
  const since = now - days * 86_400_000;
  const totals = Object.fromEntries(USAGE_KINDS.map((k) => [k, { turns: 0, total: 0, cacheRead: 0, costUsd: null }]));
  const add = (kind, u, turns) => {
    const t = totals[kind];
    t.turns += turns;
    t.total += u.total;
    t.cacheRead += u.cacheRead;
    if (u.costUsd !== null) t.costUsd = (t.costUsd ?? 0) + u.costUsd;
  };
  const inits = new Map();
  let any = false;
  for (const e of log) {
    const ts = Date.parse(e?.ts ?? "");
    if (!Number.isFinite(ts) || ts < since || ts > now + 60_000 || !USAGE_KINDS.includes(e.event)) continue;
    const u = normalizeUsage(e.usage);
    if (!u) continue;
    if (e.event === "init") { inits.set(e.initId ?? e.ts, u); continue; }
    if (e.event === "reflection" && e.carriedForward) continue;
    any = true;
    add(e.event, u, e.event === "ingest" ? Math.max(1, Number(e.parts) || 1) : 1);
  }
  for (const u of inits.values()) { any = true; add("init", u, 1); }
  return any ? { days, ...totals } : null;
}

/** 950, 12.3k, 4.5M. */
export function compactTokens(n) {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** "usage (7d): ingest N turns / X tokens · reflection N / Y · init N / Z (≈$C)" (the server's status format). */
export function renderUsage(u) {
  const cost = USAGE_KINDS.reduce((acc, k) => (u[k].costUsd === null ? acc : (acc ?? 0) + u[k].costUsd), null);
  const money = cost === null ? "" : ` (≈${cost > 0 && cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`})`;
  return `usage (${u.days}d): ingest ${u.ingest.turns} turns / ${compactTokens(u.ingest.total)} tokens · reflection ${u.reflection.turns} / ${compactTokens(u.reflection.total)} · init ${u.init.turns} / ${compactTokens(u.init.total)}${money}`;
}

/**
 * Pure: build the status object from the repo contents.
 * `log` = parsed ingest/log.jsonl, `initStatus` = bootstrap/status.json or null,
 * `request` = my bootstrap/<member>/request.json or null.
 */
/** User-level install per tool for `status`: "ok" or what is wrong, or null when the tool is absent and nothing is installed. */
export function userInstallSummary(st) {
  const one = (t) => {
    if (t.error) return "invalid settings file";
    if (!t.present && !t.events.length) return null;
    if (t.badPaths.length) return "binary missing";
    if (t.missing.length) return t.events.length ? `missing ${t.missing.join(", ")}` : "not installed";
    return t.skill === "ok" ? "ok" : `skill ${t.skill}`;
  };
  return { "claude-code": one(st.claude), codex: one(st.codex) };
}

export function buildStatus({ project, member, aliases = [], log, initStatus, request, myFiles = [], memoryCommits = [], transcriptsPulled = true, memoryPulled = true, now = Date.now(), install = null }) {
  const names = new Set([member, ...aliases]);
  const mine = log.filter((e) => names.has(memberOfFile(e.file)) || names.has(e.member));
  const ingested = mine.filter((e) => e.event === "ingest");
  const skipped = mine.filter((e) => e.event === "skip");
  const seen = new Set(mine.map((e) => e.file));
  const reflections = log.filter((e) => e.event === "reflection" && !e.carriedForward);
  const lastReflection = reflections.at(-1) || null;
  const myLastReflected = [...ingested].reverse().find((e) => e.reflectionOutcome);
  const serverVersion = initStatus?.serverVersion || [...log].reverse().find((e) => e.serverVersion)?.serverVersion || null;
  let init = { state: "not_requested" };
  if (initStatus && INIT_STATES.includes(initStatus.state)) init = { ...initStatus };
  else if (initStatus) init = { ...initStatus, state: "unknown" };
  else if (request) init = { state: "requested", requestedAt: request.requestedAt, note: "the server has not picked up the request yet (servers without init support ignore bootstrap/)" };
  return {
    project, member,
    ...(aliases.length ? { aliases } : {}),
    projectInit: projectInitState({ initStatus, request, member, aliases }),
    ingest: {
      ingested: new Set(ingested.map((e) => e.file)).size,
      skipped: skipped.length,
      waiting: myFiles.filter((f) => !seen.has(f)).length,
      lastIngestAt: ingested.at(-1)?.ts || null,
      lastSkip: skipped.at(-1) ? { file: skipped.at(-1).file, error: skipped.at(-1).error, ts: skipped.at(-1).ts } : null,
    },
    reflection: lastReflection ? { outcome: lastReflection.outcome ?? null, commit: lastReflection.reflectionCommit ?? null, ts: lastReflection.ts } : null,
    myLastReflection: myLastReflected ? { outcome: myLastReflected.reflectionOutcome, commit: myLastReflected.reflectionCommit ?? null, file: myLastReflected.file } : null,
    init,
    usage: usageFromLog(log, { now }),
    serverVersion,
    memoryCommits,
    pulled: { transcripts: transcriptsPulled, memory: memoryPulled },
    ...(install ? { install } : {}),
  };
}

export function renderStatus(s) {
  const L = [];
  L.push(`project ${s.project} (member ${s.member}${s.aliases?.length ? `, aliases ${s.aliases.join(", ")}` : ""})${s.serverVersion ? `, server ${s.serverVersion}` : ""}`);
  if (s.install?.mode === "user") {
    const tools = Object.entries(s.install.user || {}).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`);
    L.push(`mode: user; user-level hooks: ${tools.join(", ") || "none installed (run `memmem install`)"}${s.install.user?.codex ? " (Codex runs them after a one-time approval on its review screen)" : ""}`);
  } else if (s.install) L.push("mode: shared (project-level hooks)");
  if (s.install?.checkout) L.push(`linked git worktree ${s.install.checkout}: using the main checkout ${s.install.main}`);
  const i = s.ingest;
  L.push(`ingest: ${i.ingested} session file(s) ingested, ${i.skipped} skipped, ${i.waiting} waiting${i.lastIngestAt ? ` (last ${i.lastIngestAt})` : ""}`);
  if (i.lastSkip) L.push(`  last skip: ${i.lastSkip.file}: ${i.lastSkip.error}`);
  if (s.reflection) L.push(`reflection: ${s.reflection.outcome || "?"}${s.reflection.commit ? ` ${String(s.reflection.commit).slice(0, 10)}` : ""} at ${s.reflection.ts}`);
  else L.push("reflection: none yet");
  if (s.myLastReflection) L.push(`  my last reflected session: ${s.myLastReflection.outcome}${s.myLastReflection.commit ? ` ${String(s.myLastReflection.commit).slice(0, 10)}` : ""} (${s.myLastReflection.file})`);
  L.push(...renderInit(s.init, s.projectInit || projectInitState({ initStatus: s.init, member: s.member, aliases: s.aliases || [] })));
  if (s.usage) L.push(renderUsage(s.usage));
  if (s.memoryCommits.length) {
    L.push("memory repo:");
    for (const c of s.memoryCommits) L.push(`  ${c}`);
  }
  if (!s.pulled.transcripts) L.push("note: could not pull the transcripts repo; showing the local copy");
  if (!s.pulled.memory) L.push("note: could not pull the memory repo; showing the local copy");
  return L.join("\n") + "\n";
}

/** The `init:` lines of `memmem status`. `n` = raw status.json (or a pseudo state), `p` = projectInitState. */
export function renderInit(n, p) {
  const L = [];
  if (n.state === "not_requested") { L.push("init: not requested (run `memmem init`)"); return L; }
  if (n.state === "requested") { L.push(`init: requested at ${n.requestedAt}; ${n.note}`); return L; }
  const commits = Array.isArray(n.lastRun?.commits) ? n.lastRun.commits : Array.isArray(n.commits) ? n.commits : [];
  const ncommits = commits.length ? `, ${commits.length} commit(s)` : "";
  if (p.initialized && (p.depth || p.initializedBy.length || p.initializedAt)) {
    const facts = [p.depth, p.initializedBy.length ? `by ${p.initializedBy.join(", ")}` : null, day(p.initializedAt)].filter(Boolean).join(", ");
    const run = n.state === "done" ? "" : `; now ${n.state}${n.lastRun?.kind ? ` (${n.lastRun.kind}${list(n.lastRun.requestedBy).length ? ` for ${list(n.lastRun.requestedBy).join(", ")}` : ""})` : ""}`;
    L.push(`init: done (${facts})${run}${ncommits}`);
  } else {
    L.push(`init: ${n.state}${n.updatedAt ? ` (updated ${n.updatedAt})` : ""}${ncommits}`);
  }
  if (n.state === "waiting_for_answer" && p.question) {
    L.push(`  question: ${p.question}`);
    L.push(`  answer with: memmem init --answer "<text>"`);
  }
  if (n.state === "failed" && p.error) L.push(`  error: ${p.error}`);
  const m = p.myContribution;
  if (m.state === "reflected") L.push(`  my sessions: reflected (${m.sessions}${m.kind ? `, ${m.kind}` : ""}${m.finishedAt ? ` at ${day(m.finishedAt)}` : ""})`);
  else if (m.state === "requested") { if (p.initialized) L.push(`  my sessions: requested${m.requestedAt ? ` at ${m.requestedAt}` : ""} (waiting for the server)`); }
  else if (m.state === "not_reflected") { if (p.initialized) L.push("  my sessions: not reflected (run /memmem-init or memmem init --history-only --history yes)"); }
  else L.push(`  my sessions: ${m.state}${m.kind ? ` (${m.kind})` : ""}`);
  return L;
}

/** Clone or fast-forward the transcripts clone. Returns { ok (clone exists), pulled }. */
export function pullTranscripts(found, paths = projectPaths(found.config, found.dir)) {
  const cl = ensureClone(repoUrl(found.config.transcriptsRepo), paths.transcripts);
  if (!cl.ok) return { ok: false, pulled: false, error: cl.error };
  return { ok: true, pulled: cl.cloned || git(["pull", "--quiet", "--ff-only"], { cwd: paths.transcripts, timeout: 30_000 }).ok };
}

/** Pull both clones and collect the status. */
export function collectStatus(found) {
  const paths = projectPaths(found.config, found.dir);
  const transcriptsPulled = pullTranscripts(found, paths).pulled;
  let memoryPulled = false;
  let memoryCommits = [];
  if (fs.existsSync(path.join(paths.memory, ".git"))) {
    memoryPulled = git(["pull", "--quiet", "--ff-only"], { cwd: paths.memory, timeout: 30_000 }).ok;
    const r = git(["log", "--format=%h %cs %s", "-n", "5"], { cwd: paths.memory });
    if (r.ok && r.stdout) memoryCommits = r.stdout.split("\n");
  }
  const aliases = memberAliases(paths.transcripts, paths.member);
  const names = [paths.member, ...aliases];
  const mode = modeOf(readLocal(found.dir));
  const where = found.checkout ? { checkout: found.checkout, main: found.dir } : {};
  return buildStatus({
    install: mode === "user" ? { mode, user: userInstallSummary(userInstallState()), ...where } : { mode, ...where },
    project: paths.project,
    member: paths.member,
    aliases,
    log: readJsonl(path.join(paths.transcripts, "ingest", "log.jsonl")),
    initStatus: readJsonOrNull(path.join(paths.transcripts, "bootstrap", "status.json")),
    request: readMyRequest(paths.transcripts, names),
    myFiles: myTrajectoryFiles(paths.transcripts, names),
    memoryCommits,
    transcriptsPulled,
    memoryPulled,
  });
}

export function runStatus(args, { out = process.stdout, err = process.stderr } = {}) {
  const found = findConfig(args.cwd || process.cwd());
  if (!found) { err.write("memmem status: not a team project (no .memmem/config.json). Run `memmem setup` first.\n"); return 1; }
  const intervalMs = Number(process.env.MEMMEM_STATUS_INTERVAL_MS || 30_000);
  const once = () => {
    const s = collectStatus(found);
    out.write(args.json ? JSON.stringify(s) + "\n" : renderStatus(s));
  };
  once();
  if (!args.watch) return 0;
  const rounds = Number(process.env.MEMMEM_STATUS_ROUNDS || Infinity); // tests stop the loop
  for (let n = 1; n < rounds; n++) {
    sleepSync(intervalMs);
    if (!args.json) out.write(`\n--- ${new Date().toISOString()}\n`);
    once();
  }
  return 0;
}
