// Project memory initialization (design: docs/design/project-initialization.md, 3.2).
//
// A team member's `memmem init` writes bootstrap/<member>/request.json (plus,
// with consent, redacted session copies and a manifest in the shape of Letta
// Code's `letta trajectories export`) to the transcripts repo. The worker
// clones the code, lays the sessions out where Letta's `initializing-memory`
// skill expects an export, answers the skill's questions in a first turn, and
// runs Letta's own `/init` (App Server `execute_command` `init`).
//
// This module holds the pure parts: scanning bootstrap/, merging requests,
// laying out history, the pre-answer turn, and classifying the outcome. The
// job itself (sessions, status.json, pushes) lives in init-runner.ts.
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { git } from "./git.js";
import { parseTrajectoryPath } from "./ingest-text.js";
import { memoryLanguageInstruction } from "./language.js";
import { membersInstruction, resolveMember, type MemberRecord } from "./members.js";

export const INIT_STATUS_PATH = "bootstrap/status.json";

export interface BootstrapEntry {
  path: string;
  blob: string;
  member: string;
}

export interface BootstrapScan {
  /** bootstrap/<member>/request.json */
  requests: BootstrapEntry[];
  /** bootstrap/<member>/answer-<n>.md, in (member, n) order. */
  answers: (BootstrapEntry & { n: number })[];
  /** bootstrap/<member>/manifest.json */
  manifests: BootstrapEntry[];
}

/** Classify bootstrap/ paths (with blob ids) from `git ls-tree -r`. */
export function classifyBootstrapPaths(entries: { path: string; blob: string }[]): BootstrapScan {
  const out: BootstrapScan = { requests: [], answers: [], manifests: [] };
  for (const { path, blob } of entries) {
    const p = path.split("/");
    if (p[0] !== "bootstrap" || p.length !== 3 || !p[1]) continue;
    const member = p[1];
    if (p[2] === "request.json") out.requests.push({ path, blob, member });
    else if (p[2] === "manifest.json") out.manifests.push({ path, blob, member });
    else {
      const m = /^answer-(\d+)\.md$/.exec(p[2]!);
      if (m) out.answers.push({ path, blob, member, n: Number(m[1]) });
    }
  }
  out.answers.sort((a, b) => a.member.localeCompare(b.member) || a.n - b.n);
  return out;
}

/** Scan bootstrap/ at `rev` of the transcripts clone. */
export async function scanBootstrap(repoDir: string, rev = "HEAD"): Promise<BootstrapScan> {
  const out = await git(["ls-tree", "-r", "-z", rev, "--", "bootstrap"], { cwd: repoDir });
  const entries = out
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      // "<mode> blob <sha>\t<path>"
      const tab = line.indexOf("\t");
      const meta = line.slice(0, tab).split(" ");
      return { path: line.slice(tab + 1), blob: meta[2] ?? "", type: meta[1] };
    })
    .filter((e) => e.type === "blob");
  return classifyBootstrapPaths(entries);
}

/** request.json as written by the client's `memmem init` (client/lib/init.mjs buildRequest). */
export interface InitRequestDoc {
  layoutVersion?: number;
  memmemVersion?: string;
  requestedAt?: string;
  project?: string;
  member?: string;
  language?: string;
  historyOnly?: boolean;
  /** Re-initialize even though the project is already initialized (`memmem init --reinit`). */
  reinit?: boolean;
  answers?: { depth?: string; repos?: string[]; style?: string; history?: boolean };
  codeRepo?: string | null;
  codeSummary?: { branch?: string | null; status?: string; log?: string; shortlog?: string; remote?: string | null } | null;
  sessions?: number;
}

export interface LoadedRequest extends BootstrapEntry {
  doc: InitRequestDoc;
}

/** The merged view of every pending request (normally one). */
export interface InitPlan {
  requests: LoadedRequest[];
  /** The request whose code summary and style are used (the newest full request, else the newest). */
  primary: LoadedRequest;
  requestedBy: string[];
  depth: "standard" | "deep";
  repos: string[];
  style: string;
  /** Members whose request approved history analysis. */
  historyApprovedBy: string[];
  historyOnly: boolean;
  codeRepo: string | null;
  language: string;
  /** Each full request's style answer, by member handle. */
  memberStyles: { member: string; style: string }[];
  /** Some full request asked for `reinit`. */
  reinit: boolean;
}

export function parseRequest(text: string): InitRequestDoc {
  const doc = JSON.parse(text) as unknown;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("request.json is not a JSON object");
  return doc as InitRequestDoc;
}

/** The member handle of a request (its `member`, else the bootstrap/<member>/ directory; an alias maps to its handle). */
export function requestMember(r: LoadedRequest, aliases?: Map<string, string>): string {
  const m = r.doc.member || r.member;
  return aliases ? resolveMember(m, aliases) : m;
}

export function mergeRequests(requests: LoadedRequest[], aliases?: Map<string, string>): InitPlan {
  if (!requests.length) throw new Error("no init request");
  const who = (r: LoadedRequest) => requestMember(r, aliases);
  const byTime = [...requests].sort((a, b) => String(a.doc.requestedAt ?? "").localeCompare(String(b.doc.requestedAt ?? "")));
  const full = byTime.filter((r) => !r.doc.historyOnly);
  const primary = (full.length ? full : byTime).at(-1)!;
  const repos = [...new Set(full.flatMap((r) => (Array.isArray(r.doc.answers?.repos) ? r.doc.answers!.repos! : [])).map((x) => String(x).trim()).filter(Boolean))];
  const styles = [...new Set(full.map((r) => String(r.doc.answers?.style ?? "").trim()).filter(Boolean))];
  return {
    requests: byTime,
    primary,
    requestedBy: [...new Set(byTime.map(who))],
    depth: full.some((r) => r.doc.answers?.depth === "deep") ? "deep" : "standard",
    repos,
    style: styles.join(" / "),
    historyApprovedBy: [...new Set(byTime.filter((r) => r.doc.answers?.history === true).map(who))],
    historyOnly: full.length === 0,
    codeRepo: (full.length ? primary.doc.codeRepo : byTime.map((r) => r.doc.codeRepo).filter(Boolean).at(-1)) ?? null,
    language: primary.doc.language || "en",
    memberStyles: full
      .map((r) => ({ member: who(r), style: String(r.doc.answers?.style ?? "").trim() }))
      .filter((x) => x.style)
      .filter((x, i, a) => a.findIndex((y) => y.member === x.member && y.style === x.style) === i),
    reinit: full.some((r) => r.doc.reinit === true),
  };
}

/**
 * The project's memory language (projects.json) wins over the requests'
 * `language` (the client's config). Returns the plan with the project
 * language and, when a request asked for another one, what it asked for.
 */
export function applyProjectLanguage(plan: InitPlan, projectLanguage: string): { plan: InitPlan; requested: string[] } {
  const requested = [...new Set(plan.requests.map((r) => r.doc.language).filter((l): l is string => typeof l === "string" && l !== "" && l !== projectLanguage))];
  return { plan: { ...plan, language: projectLanguage }, requested };
}

export type InitKind = "project_init" | "contribute" | "deepen";
export type InitDepth = "standard" | "deep";

/** What the project already has (from state, or bootstrap/status.json). */
export interface InitProjectView {
  /** A project_init or deepen run finished `done`. */
  initialized: boolean;
  /** Depth of the last completed project research; null when unknown (treated as standard). */
  depth: InitDepth | null;
}

export interface InitClassification {
  kind: InitKind;
  /** One-line reason (logged). */
  reason: string;
  reinit: boolean;
  depthBefore: InitDepth | null;
  depthAfter: InitDepth | null;
  /** A request asked for a shallower depth than the recorded one (ignored). */
  downgradeIgnored: boolean;
}

/**
 * Classify pending requests against the project's state (design 3.5), not
 * their flags alone:
 * - only history-only requests: `contribute`;
 * - no completed init: `project_init` (pending requests merged);
 * - completed init and `reinit`: `project_init` again (all members' sessions);
 * - completed init and a deeper depth than recorded (standard -> deep): `deepen`;
 * - otherwise `contribute` (a shallower depth is ignored).
 */
export function classifyInit(plan: InitPlan, project: InitProjectView): InitClassification {
  const full = plan.requests.filter((r) => !r.doc.historyOnly);
  const before = project.initialized ? project.depth : null;
  const recorded: InitDepth = project.depth ?? "standard";
  const downgrade = project.initialized && recorded === "deep" && full.some((r) => r.doc.answers?.depth !== "deep");
  const base = { reinit: false, depthBefore: before, downgradeIgnored: false };
  if (!full.length) return { ...base, kind: "contribute", reason: "history-only request", depthAfter: before };
  if (!project.initialized) return { ...base, kind: "project_init", reason: "no completed init", depthAfter: plan.depth };
  if (plan.reinit) {
    return { ...base, kind: "project_init", reason: "reinit requested", reinit: true, depthAfter: recorded === "deep" ? "deep" : plan.depth, downgradeIgnored: downgrade };
  }
  if (plan.depth === "deep" && recorded !== "deep") {
    return { ...base, kind: "deepen", reason: `depth ${recorded} -> deep requested`, depthAfter: "deep" };
  }
  return {
    ...base,
    kind: "contribute",
    reason: downgrade ? `already initialized (${recorded}); shallower depth ignored` : `already initialized (${recorded})`,
    depthAfter: before,
    downgradeIgnored: downgrade,
  };
}

const REFLECTED_OUTCOMES = new Set(["committed", "nothing_to_save"]);

/**
 * Session ids that a reflection already handled, from ingest/log.jsonl:
 * `ingest` entries with a `session` whose `reflectionOutcome` is committed or
 * nothing_to_save (or that carry a `reflectionCommit`), and the trajectory
 * files listed by `reflection` entries with such an outcome.
 */
export function reflectedSessions(logText: string): Set<string> {
  const out = new Set<string>();
  const sessionOfFile = new Map<string, string>();
  const reflectedFiles: string[] = [];
  for (const line of logText.split("\n")) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e.event === "ingest") {
      const session = typeof e.session === "string" ? e.session : undefined;
      if (session && typeof e.file === "string") sessionOfFile.set(e.file, session);
      if (session && (REFLECTED_OUTCOMES.has(String(e.reflectionOutcome)) || (typeof e.reflectionCommit === "string" && e.reflectionCommit))) out.add(session);
    } else if (e.event === "reflection" && (REFLECTED_OUTCOMES.has(String(e.outcome)) || (typeof e.reflectionCommit === "string" && e.reflectionCommit))) {
      for (const f of Array.isArray(e.files) ? e.files : []) if (typeof f === "string") reflectedFiles.push(f);
    }
  }
  for (const f of reflectedFiles) {
    const id = parseTrajectoryPath(f)?.sessionId ?? sessionOfFile.get(f);
    if (id) out.add(id);
  }
  return out;
}

/** reflectedSessions() over the checkout's ingest/log.jsonl (empty when there is none). */
export async function loadReflectedSessions(repoDir: string): Promise<Set<string>> {
  try {
    return reflectedSessions(await readFile(join(repoDir, "ingest", "log.jsonl"), "utf8"));
  } catch {
    return new Set();
  }
}

/** `org/repo` -> GitHub https URL; URLs and scp-style addresses are kept. */
export function repoCloneUrl(spec: string): string {
  const s = spec.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return `https://github.com/${s.replace(/\.git$/, "")}.git`;
  return s;
}

/** Directory name for a related repo clone: `repo-<name>`. */
export function relatedRepoDir(spec: string): string {
  const name = basename(spec.trim().replace(/\.git$/, "").replace(/[:/]+$/, "")).replace(/[^A-Za-z0-9._-]/g, "-") || "related";
  return `repo-${name}`;
}

/** One session of Letta's export manifest (fields the skill's scripts read, plus ours). */
export interface ManifestSession {
  source: string;
  id?: string;
  sessionId: string;
  file: string;
  sourcePath?: string;
  project?: string;
  startedAt?: string;
  endedAt?: string;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  reasoningRecords?: number;
  firstUserPrompt?: string;
  records?: number;
  bytes?: number;
  diagnostics?: number;
  /** mem-mem: the member who uploaded the session, and the path the client recorded. */
  member?: string;
  clientProject?: string;
  [key: string]: unknown;
}

export interface HistoryLayout {
  outDir: string;
  sessions: ManifestSession[];
  /** Sessions left out (over initMaxSessions, missing file, duplicate). */
  dropped: { sessionId?: string; member?: string; file?: string; reason: string }[];
  bytes: number;
  estimatedTokens: number;
  /** Members with at least one laid-out session. */
  members: string[];
  bySource: Record<string, number>;
  /** Laid-out sessions per member handle. */
  byMember: Record<string, number>;
  /** Distinct sessions left out because a reflection already handled them. */
  alreadyReflected: number;
  /** Distinct sessions left out because an earlier init run already analysed them. */
  alreadyStaged: number;
}

/** Rough token estimate for the history: 4 bytes per token of rendered JSON. */
export function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

/**
 * Lay out every bootstrap/<member>/<source>/*.json listed in that member's
 * manifest.json into `outDir/<source>/<file>`, and write a merged
 * `outDir/manifest.json` in the shape `letta trajectories export` writes
 * (version, generatedAt, outDir, sources{discovered, exported}, errors[],
 * sessions[]). Sessions are deduplicated by sessionId (the larger copy wins),
 * and only the newest `maxSessions` are kept. Each session's `project` is set
 * to `codeDir` (the server's clone) when given, so Letta's prepare-history
 * fills the cohort's `repo`; the client's path is kept as `clientProject`.
 * `outDir` is emptied first.
 */
export async function layoutHistory(opts: {
  repoDir: string;
  manifests: BootstrapEntry[];
  outDir: string;
  maxSessions: number;
  codeDir: string | null;
  now?: Date;
  /** Session ids to leave out (already reflected by the regular ingest). */
  exclude?: Set<string>;
  /** Session ids to leave out because an earlier init run analysed them (id -> that run). */
  excludeStaged?: Record<string, { initId: string }>;
  /** Map a member name (alias) to its handle. */
  resolveMember?: (name: string) => string;
}): Promise<HistoryLayout> {
  const { repoDir, outDir } = opts;
  const dropped: HistoryLayout["dropped"] = [];
  const errors: { source?: string; sourcePath?: string; member?: string; error: string }[] = [];
  const sources: Record<string, { discovered: number; exported: number }> = {};
  const candidates = new Map<string, { s: ManifestSession; member: string; abs: string }>();
  const excluded = new Set<string>();
  const staged = new Set<string>();
  const who = opts.resolveMember ?? ((n: string) => n);
  for (const m of opts.manifests) {
    let manifest: { sessions?: ManifestSession[]; errors?: unknown[] };
    try {
      manifest = JSON.parse(await readFile(join(repoDir, m.path), "utf8")) as typeof manifest;
    } catch (err) {
      errors.push({ member: m.member, error: `unreadable ${m.path}: ${(err as Error).message}` });
      continue;
    }
    for (const e of Array.isArray(manifest.errors) ? manifest.errors : []) {
      if (e && typeof e === "object") errors.push({ ...(e as Record<string, unknown>), member: m.member } as (typeof errors)[number]);
    }
    for (const s of Array.isArray(manifest.sessions) ? manifest.sessions : []) {
      if (!s || typeof s.file !== "string" || typeof s.sessionId !== "string" || !s.source) continue;
      const counts = (sources[s.source] ??= { discovered: 0, exported: 0 });
      counts.discovered += 1;
      if (s.file.includes("..") || s.file.startsWith("/")) {
        dropped.push({ sessionId: s.sessionId, member: m.member, file: s.file, reason: "unsafe file path" });
        continue;
      }
      if (opts.exclude?.has(s.sessionId)) {
        if (!excluded.has(s.sessionId)) dropped.push({ sessionId: s.sessionId, member: who(m.member), file: s.file, reason: "already reflected" });
        excluded.add(s.sessionId);
        continue;
      }
      const earlier = opts.excludeStaged && Object.hasOwn(opts.excludeStaged, s.sessionId) ? opts.excludeStaged[s.sessionId] : undefined;
      if (earlier) {
        if (!staged.has(s.sessionId)) dropped.push({ sessionId: s.sessionId, member: who(m.member), file: s.file, reason: `already analysed by init ${earlier.initId}` });
        staged.add(s.sessionId);
        continue;
      }
      const abs = join(repoDir, dirname(m.path), s.file);
      if (!existsSync(abs)) {
        dropped.push({ sessionId: s.sessionId, member: m.member, file: s.file, reason: "session file missing from the transcripts repo" });
        continue;
      }
      const prev = candidates.get(s.sessionId);
      if (prev) {
        const keepNew = (s.bytes ?? 0) > (prev.s.bytes ?? 0);
        const loser = keepNew ? prev : { s, member: m.member };
        dropped.push({ sessionId: s.sessionId, member: loser.member, file: loser.s.file, reason: "duplicate session (uploaded by more than one member)" });
        if (!keepNew) continue;
      }
      candidates.set(s.sessionId, { s, member: who(s.member && typeof s.member === "string" ? s.member : m.member), abs });
    }
  }
  const sorted = [...candidates.values()].sort((a, b) => String(b.s.startedAt ?? "").localeCompare(String(a.s.startedAt ?? "")));
  const kept = sorted.slice(0, Math.max(0, opts.maxSessions));
  for (const c of sorted.slice(kept.length)) {
    dropped.push({ sessionId: c.s.sessionId, member: c.member, file: c.s.file, reason: `over settings.initMaxSessions (${opts.maxSessions}); the newest are kept` });
  }
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const used = new Set<string>();
  const sessions: ManifestSession[] = [];
  let bytes = 0;
  const bySource: Record<string, number> = {};
  const byMember: Record<string, number> = {};
  for (const c of kept.sort((a, b) => String(a.s.startedAt ?? "").localeCompare(String(b.s.startedAt ?? "")))) {
    const ext = c.s.file.endsWith(".json") ? ".json" : "";
    const base = c.s.file.slice(0, c.s.file.length - ext.length);
    let file = c.s.file;
    for (let n = 2; used.has(file); n++) file = `${base}-${n}${ext}`;
    used.add(file);
    await mkdir(dirname(join(outDir, file)), { recursive: true });
    await copyFile(c.abs, join(outDir, file));
    const entry: ManifestSession = { ...c.s, file, member: c.member };
    if (typeof c.s.member === "string" && c.s.member !== c.member) entry.uploadedAs = c.s.member;
    if (opts.codeDir) {
      if (c.s.project) entry.clientProject = c.s.project;
      entry.project = opts.codeDir;
    }
    sessions.push(entry);
    bytes += c.s.bytes ?? 0;
    bySource[c.s.source] = (bySource[c.s.source] ?? 0) + 1;
    byMember[c.member] = (byMember[c.member] ?? 0) + 1;
    sources[c.s.source]!.exported += 1;
  }
  for (const d of dropped) errors.push({ member: d.member, sourcePath: d.file, error: `not laid out: ${d.reason}` });
  const manifest = {
    version: 1,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    outDir,
    generatedBy: "mem-mem worker (from bootstrap/*/ in the transcripts repo)",
    sources,
    errors,
    sessions,
  };
  await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return {
    outDir,
    sessions,
    dropped,
    bytes,
    estimatedTokens: estimateTokens(bytes),
    members: [...new Set(sessions.map((s) => s.member!))],
    bySource,
    byMember,
    alreadyReflected: excluded.size,
    alreadyStaged: staged.size,
  };
}

export { LANGUAGE_NAMES } from "./language.js";

export interface PreAnswerInput {
  project: string;
  initId: string;
  plan: InitPlan;
  history: HistoryLayout | null;
  codeDir: string | null;
  codeHead: string | null;
  relatedDirs: { spec: string; dir: string }[];
  historyModel: string | null;
  /** How the requests were classified (default: a first project_init). */
  classification?: InitClassification;
  /** The completed init this run builds on (contribute / deepen / reinit). */
  previous?: { initializedAt: string | null; initializedBy: string[] } | null;
  /** Registered team members (members/*.json). */
  members?: MemberRecord[];
}

function styleList(plan: InitPlan): string {
  if (!plan.memberStyles.length) return plan.style;
  return plan.memberStyles.map((x) => `${x.style} (${x.member})`).join("; ");
}

/** The first turn of the init conversation: the skill's questions, already answered. */
export function buildPreAnswerTurn(i: PreAnswerInput): string {
  const { plan, history } = i;
  const c = i.classification;
  const kind: InitKind = c?.kind ?? (plan.historyOnly ? "contribute" : "project_init");
  const cs = kind === "contribute" && plan.historyOnly ? null : (plan.primary.doc.codeSummary ?? null);
  const prev = i.previous;
  const prevText = prev?.initializedAt
    ? ` by ${prev.initializedBy.join(", ") || "a team member"} on ${prev.initializedAt}${c?.depthBefore ? ` at ${c.depthBefore} depth` : ""}`
    : "";
  const L: string[] = [];
  L.push(`<memmem-init project="${i.project}" init="${i.initId}">`);
  L.push(
    `This conversation is the team memory initialization of project ${i.project}, requested by ${plan.requestedBy.join(", ")} through mem-mem. You run on the team's memory server: no human is attached to this conversation and AskUserQuestion is not available.`,
  );
  L.push("");
  L.push(`Run kind: ${kind}${c ? ` (${c.reason})` : ""}.`);
  L.push("");
  L.push("The following /init questions are already answered; do not ask them again:");
  const repoList = i.relatedDirs.length ? i.relatedDirs.map((r) => `${r.spec} (cloned at ${r.dir})`).join(", ") : "none";
  if (kind === "contribute") {
    L.push(
      `- Scope: session contribution from ${plan.requestedBy.join(", ")}. This project's memory is already initialized${prevText}. Reflect these members' approved sessions into the existing memory. Do not research the codebase again beyond verifying claims made in the sessions; keep the existing layout and records.`,
    );
    if (!plan.historyOnly) L.push(`- Other repositories: ${repoList}${i.relatedDirs.length ? " (add them to memory if they are not recorded yet)" : ""}`);
    L.push(
      `- Communication style: ${styleList(plan) || "no preference given"}. Record each member's answer in people/<handle>.md (create or update that member's file); it is that member's preference, not the team's.`,
    );
  } else {
    if (kind === "deepen") {
      L.push(
        `- Research depth: deep. The project was initialized${prevText || " before"}; this run deepens it: research the code again at deep depth and extend the existing memory.`,
      );
    } else {
      L.push(`- Research depth: ${c?.depthAfter ?? plan.depth}`);
      if (c?.reinit) L.push(`- Re-initialization requested by ${plan.requestedBy.join(", ")}: the project was initialized${prevText || " before"}; rebuild from the existing memory plus the code.`);
    }
    if (kind === "deepen" || c?.reinit) {
      L.push(
        "- Existing memory stays: do not delete existing records. Where the new research contradicts one, mark it superseded (with the reason and the replacing record) as the Rules for reflection say.",
      );
    }
    L.push(`- Other repositories: ${repoList}`);
    L.push(`- Communication style: ${styleList(plan) || "no preference given"}`);
  }
  if (history && history.sessions.length) {
    const src = Object.entries(history.bySource)
      .map(([s, n]) => `${s} ${n}`)
      .join(", ");
    L.push(
      `- History analysis: approved by ${history.members.join(", ")} (${history.sessions.length} sessions: ${src}). They are already exported to ${history.outDir} in the \`letta trajectories export\` layout (manifest.json plus <source>/<startedAt>_<sessionId>.json). Do not run \`letta trajectories detect\` or \`letta trajectories export\` again: this server has no team sessions, and an export would overwrite that directory. Use that directory as the export (for example \`prepare-history.mjs --export ${history.outDir} --out /tmp/letta-init-history\`).`,
    );
    L.push(
      "- Session authorship: the `member` field of each session in manifest.json names the team member who ran it (not git authors). A session's `user` turns can still be prompts written by a parent agent.",
    );
    if (history.alreadyReflected) L.push(`- Sessions left out because the regular ingest already reflected them: ${history.alreadyReflected}.`);
    if (history.alreadyStaged) L.push(`- Sessions left out because an earlier init already analysed them: ${history.alreadyStaged}.`);
    if (history.dropped.length) L.push(`- Sessions not laid out: ${history.dropped.length} (listed in manifest.json errors with the reason).`);
  } else {
    L.push("- History analysis: no sessions were uploaded; skip history detection, export and analysis.");
  }
  L.push(`- Subagent model for history analysis: ${i.historyModel ?? "your current model"}`);
  L.push(
    "- Background work: this server conversation does not reliably receive background task notifications. Call the analysis Workflow with `wait: true` so it returns the script's value in the same turn, and do not end your turn while a Workflow or subagent you started is still running.",
  );
  L.push(`- ${memoryLanguageInstruction(plan.language)}`);
  L.push("");
  const team = membersInstruction(i.members ?? []);
  if (team.length) {
    L.push(...team);
    L.push("");
  }
  if (i.codeDir) {
    L.push(
      `The code repository is cloned at ${i.codeDir} (your working directory; remote ${plan.codeRepo ?? "unknown"}${i.codeHead ? `, HEAD ${i.codeHead.slice(0, 12)}` : ""}). The git summary in the /init message is computed in the server process's directory, not in this repository: use the summary below and run git commands in ${i.codeDir}.`,
    );
  } else {
    L.push("No code repository is cloned for this initialization.");
  }
  if (cs) {
    L.push(`Project git summary from ${plan.primary.doc.member ?? plan.primary.member}'s machine:`);
    L.push(`branch: ${cs.branch ?? "unknown"}`);
    if (cs.log) L.push(`recent commits:\n${cs.log}`);
    if (cs.shortlog) L.push(`top authors (git shortlog -sn --all):\n${cs.shortlog}`);
    if (cs.status) L.push(`working tree (git status --short):\n${cs.status}`);
  }
  L.push("");
  L.push(
    'This is team memory shared by everyone on the project. Follow the "Rules for reflection" in your root MEMORY.md and keep the layout that is already in MemFS (it takes precedence over the skill\'s example layouts).',
  );
  L.push(
    "Existing decision and change records came from the team's own sessions: do not delete them. If the current code or history contradicts one, update its status (superseded or unverified, with the reason) as the Rules for reflection say.",
  );
  L.push(
    "When you finish, end your final message with exactly one line: `INIT: done`, or `INIT: question: <question>` if you cannot continue without an answer from the team (the answer comes back as the next message in this conversation), or `INIT: failed: <one-line reason>`. Do not end with an offer of refinement.",
  );
  L.push("Reply to this message with one sentence only. The /init command follows in the next message.");
  L.push("</memmem-init>");
  return L.join("\n");
}

/** A turn that resumes an init that stopped while its background work was running. */
export function buildContinueTurn(workflows: { id: string; journal: string; log?: string }[]): string {
  const list = workflows.length
    ? workflows.map((w) => `- Workflow ${w.id}: per-call results in ${w.journal}${w.log ? `; script result in ${w.log}` : ""}`).join("\n")
    : "- (no Workflow execution found; check your background tasks' output files)";
  return `<memmem-init-continue>\nThe background work you started has finished, but this server conversation did not deliver its task notification:\n${list}\nRead those results and continue the initialization from where you stopped (coverage check, curation, commits). End your final message with exactly one line: \`INIT: done\`, \`INIT: question: <question>\` or \`INIT: failed: <reason>\`.\n</memmem-init-continue>`;
}

const BACKGROUND_WAIT = /still running|in progress|background|waiting (?:for|on)|notification|not (?:yet )?finished|pending/i;

/**
 * True when the last message ends the init: an explicit `INIT: done` /
 * `INIT: question` line, or `INIT: failed` for a reason other than waiting on
 * background work. Used to stop following listener-run turns.
 */
export function isTerminalInitReply(text: string): boolean {
  const o = classifyInitReply(text, false);
  if (o.source !== "result_line") return false;
  if (o.kind === "failed" && BACKGROUND_WAIT.test(o.reason)) return false;
  return true;
}

/** The agent ended its turn to wait for background work (no INIT line, or `INIT: failed` because something still runs). */
export function waitingOnBackground(text: string): boolean {
  const o = classifyInitReply(text, false);
  if (o.source !== "result_line") return BACKGROUND_WAIT.test(text.slice(-600));
  return o.kind === "failed" && BACKGROUND_WAIT.test(o.reason);
}

export interface WorkflowExecution {
  id: string;
  dir: string;
  journal: string;
  startedAtMs: number;
  agentsStarted: number;
  agentsFinished: number;
  lastWriteMs: number;
}

/**
 * Letta Workflow executions started since `sinceMs`
 * (`$LETTA_CONFIG_DIR/workflows/executions/<id>/`: args.json and script.js
 * at start, journal.jsonl with `{kind:"agent_started", callIndex}` lines and
 * one `{callIndex, label, prompt, outcome:{value, failed, durationMs,
 * totalTokens}}` line per finished call; Letta Code 0.34.41).
 */
export async function workflowExecutions(lettaConfigDir: string, sinceMs: number): Promise<WorkflowExecution[]> {
  const root = join(lettaConfigDir, "workflows", "executions");
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const out: WorkflowExecution[] = [];
  for (const id of names) {
    const dir = join(root, id);
    const started = await stat(join(dir, "script.js")).catch(() => stat(join(dir, "args.json")).catch(() => null));
    if (!started || started.mtimeMs < sinceMs - 5_000) continue;
    const journal = join(dir, "journal.jsonl");
    let agentsStarted = 0;
    let agentsFinished = 0;
    let lastWriteMs = started.mtimeMs;
    try {
      const st = await stat(journal);
      lastWriteMs = st.mtimeMs;
      for (const line of (await readFile(journal, "utf8")).split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as Record<string, unknown>;
          if (e.kind === "agent_started") agentsStarted += 1;
          else if (typeof e.callIndex === "number" && ((e.outcome && typeof e.outcome === "object") || typeof e.failed === "boolean")) agentsFinished += 1;
        } catch {
          // partial line
        }
      }
    } catch {
      // no journal yet
    }
    out.push({ id, dir, journal, startedAtMs: started.mtimeMs, agentsStarted, agentsFinished, lastWriteMs });
  }
  return out.sort((a, b) => a.startedAtMs - b.startedAtMs);
}

/** Some execution still has unfinished agent calls, or wrote its journal in the last `quietMs`. */
export function anyWorkflowActive(execs: WorkflowExecution[], now = Date.now(), quietMs = 30_000): boolean {
  return execs.some((e) => e.agentsFinished < e.agentsStarted || now - e.lastWriteMs < quietMs);
}

/** A turn that relays a team member's answer to the init's question. */
export function buildAnswerTurn(answers: { member: string; text: string }[]): string {
  const body = answers.map((a) => `${a.member}: ${a.text}`).join("\n\n");
  return `<memmem-init-answer>\nAnswer from the team to your question:\n\n${body}\n\nContinue the initialization. End your final message with exactly one line: \`INIT: done\`, \`INIT: question: <question>\` or \`INIT: failed: <reason>\`.\n</memmem-init-answer>`;
}

/** answer-<n>.md body without the client's frontmatter. */
export function answerText(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

export type InitOutcome =
  | { kind: "done"; source: "result_line" | "no_question"; followUp?: string }
  | { kind: "question"; question: string; source: "result_line" | "heuristic" }
  | { kind: "failed"; reason: string; source: "result_line" };

/**
 * What the init's last assistant message means:
 * 1. an `INIT:` line (the last one wins): done / question / failed;
 * 2. otherwise a message that ends with a question (`?` / `？`, or an
 *    AskUserQuestion-style block) is a question, unless the init already
 *    committed memory (then it is the skill's closing offer of refinement:
 *    done, with the text kept as `followUp`);
 * 3. otherwise done.
 */
export function classifyInitReply(text: string, committed: boolean): InitOutcome {
  const t = (text ?? "").trim();
  const lines = t.split("\n").map((l) => l.replace(/[*`_>#]/g, "").trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^INIT:\s*(done|question|failed)\b[:\s-]*(.*)$/i.exec(lines[i]!);
    if (!m) continue;
    const kind = m[1]!.toLowerCase();
    const rest = m[2]!.trim();
    if (kind === "done") return { kind: "done", source: "result_line" };
    if (kind === "failed") return { kind: "failed", reason: rest || "the agent reported failure", source: "result_line" };
    const before = lines.slice(Math.max(0, i - 6), i).join("\n").trim();
    return { kind: "question", question: rest || before || t.slice(-1000), source: "result_line" };
  }
  const askBlock = /AskUserQuestion|^\s*(?:questions?|질문)\s*[:：]/im.test(t);
  const endsWithQuestion = /[?？]\s*$/.test(t.replace(/[*`_)\]]+\s*$/, ""));
  if (askBlock || endsWithQuestion) {
    const question = lastParagraph(t);
    if (committed) return { kind: "done", source: "no_question", followUp: question };
    return { kind: "question", question, source: "heuristic" };
  }
  return { kind: "done", source: "no_question" };
}

function lastParagraph(t: string, max = 1500): string {
  const paras = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  let out = paras.at(-1) ?? t;
  // A short closing line ("Which one?") needs the paragraph before it.
  if (out.length < 80 && paras.length > 1) out = `${paras.at(-2)}\n\n${out}`;
  return out.length > max ? out.slice(out.length - max) : out;
}
