// The init job: code clone, history layout, pre-answer turn, Letta `init`,
// outcome, memory push, bootstrap/status.json and ingest/log.jsonl. The worker
// runs one job at a time per project, in the background, and pauses that
// project's ingest while a job runs (see Worker.launchInit).
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { projectCwd, type ProjectConfig, type WorkerConfig } from "./config.js";
import { GitError, commitFilesAndPush, commitsBetween, headOf, syncRepo } from "./git.js";
import {
  INIT_STATUS_PATH,
  anyWorkflowActive,
  answerText,
  buildAnswerTurn,
  buildContinueTurn,
  isTerminalInitReply,
  waitingOnBackground,
  workflowExecutions,
  buildPreAnswerTurn,
  classifyInit,
  classifyInitReply,
  layoutHistory,
  loadReflectedSessions,
  applyProjectLanguage,
  mergeRequests,
  parseRequest,
  relatedRepoDir,
  repoCloneUrl,
  type BootstrapEntry,
  type BootstrapScan,
  type HistoryLayout,
  type InitClassification,
  type InitKind,
  type InitPlan,
  type LoadedRequest,
} from "./init.js";
import { readBootstrapSources, seedInitStagedSessions } from "./init-recovery.js";
import { aliasMap, readMembers, resolveMember } from "./members.js";
import { TurnError, reportExcerpt, sleep, type FollowOptions, type IngestSession, type LettaGateway, type TurnResult } from "./letta.js";
import { errorMessage, log } from "./log.js";
import { addUsage as addNormalizedUsage, emptyUsage, normalizeUsage, recordUsage, type Usage } from "./usage.js";
import { localDate, saveState, type InitMemberStatus, type InitProjectRecord, type InitRun, type InitState, type LogEntry, type ProjectState } from "./state.js";

/** Pre-answer turn limit (it asks for one sentence). */
const PRE_ANSWER_TIMEOUT_MS = 10 * 60_000;
/** Continue turns sent when the agent stopped to wait for background work that never notified it. */
const MAX_CONTINUE_TURNS = 2;
/** Stop following listener-run turns after this long with nothing running. */
const FOLLOW_IDLE_MS = 60_000;

export interface InitDeps {
  cfg: WorkerConfig;
  p: ProjectConfig;
  state: ProjectState;
  gw: LettaGateway;
  /** Transcripts repo clone. */
  repoDir: string;
  /** Aborted by `init cancel` or a worker stop; `reason` says which. */
  signal: AbortSignal;
  /** Push MemFS main if it moved (the worker's pushMemoryIfMoved). */
  pushMemory: () => Promise<string | null>;
  version: string;
}

class InitFailure extends Error {
  override name = "InitFailure";
}

class InitAborted extends Error {
  override name = "InitAborted";
}

export function initTimeoutMs(cfg: WorkerConfig): number {
  return Math.round(cfg.settings.initTimeoutMinutes * 60_000);
}

/** `<agentcwd>/<project>/repo`: the code clone (kept for re-init). */
export function codeDirOf(cfg: WorkerConfig, project: string): string {
  return join(projectCwd(cfg, project), "repo");
}

export function newInitId(now = new Date()): string {
  return `init-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
}

/** Requests whose blob the worker has not handled yet (and that the current open run does not already cover). */
export function pendingRequests(state: ProjectState, scan: BootstrapScan): BootstrapEntry[] {
  const open = state.init && state.init.state !== "done" && state.init.state !== "failed" ? state.init.requests : [];
  return scan.requests.filter(
    (r) => state.initRequests?.[r.path]?.blob !== r.blob && !open.some((o) => o.path === r.path && o.blob === r.blob),
  );
}

/** Answer files not seen by the current run. */
export function newAnswers(run: InitRun | null | undefined, scan: BootstrapScan): BootstrapScan["answers"] {
  if (!run) return [];
  return scan.answers.filter((a) => run.answersSeen[a.path] !== a.blob);
}

function emptyProjectRecord(): InitProjectRecord {
  return { depth: null, initializedAt: null, initializedBy: [], repos: [], members: {} };
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * The project's init record, created on first use: from an earlier
 * bootstrap/status.json when the state has none (a new server, or a wiped
 * state file), else empty.
 */
export function initProjectOf(state: ProjectState, status?: Record<string, unknown> | null): InitProjectRecord {
  if (state.initProject) {
    state.initProject.members ??= {};
    state.initProject.repos ??= [];
    state.initProject.initializedBy ??= [];
    return state.initProject;
  }
  const rec = emptyProjectRecord();
  if (status && typeof status === "object") {
    rec.depth = status.depth === "standard" || status.depth === "deep" ? status.depth : null;
    if (typeof status.initializedAt === "string") rec.initializedAt = status.initializedAt;
    rec.initializedBy = strList(status.initializedBy);
    rec.repos = strList(status.repos);
    if (status.members && typeof status.members === "object" && !Array.isArray(status.members)) {
      rec.members = JSON.parse(JSON.stringify(status.members)) as Record<string, InitMemberStatus>;
    }
  }
  state.initProject = rec;
  return rec;
}

/** Move entries recorded under an alias to its handle (the newer entry wins). */
export function normalizeMemberKeys(rec: InitProjectRecord, aliases: Map<string, string>): void {
  for (const key of Object.keys(rec.members)) {
    const handle = resolveMember(key, aliases);
    if (handle === key) continue;
    const a = rec.members[key]!;
    const b = rec.members[handle];
    if (!b || String(a.finishedAt ?? "") > String(b.finishedAt ?? "")) rec.members[handle] = { ...a, uploadedAs: a.uploadedAs ?? key };
    delete rec.members[key];
  }
  rec.initializedBy = [...new Set(rec.initializedBy.map((m) => resolveMember(m, aliases)))];
}

function memberState(st: InitState): InitMemberStatus["state"] {
  return st === "queued" ? "running" : st;
}

/**
 * Reflect the run's state into the project record: its members' entries,
 * and on `done` of a project_init / deepen the depth and who initialized.
 * A failed run puts back a member's earlier successful entry (with
 * `lastFailure`). Idempotent.
 */
export function applyRunToProject(state: ProjectState, run: InitRun): void {
  if (!run.kind) return;
  const rec = initProjectOf(state);
  const terminal = run.state === "done" || run.state === "failed";
  for (const [m, e] of Object.entries(rec.members)) {
    if (e.initId !== run.id) continue;
    e.state = memberState(run.state);
    e.finishedAt = terminal ? (run.finishedAt ?? null) : null;
    const prev = run.prevMembers?.[m];
    if (run.state === "failed" && prev && prev.state === "done") {
      rec.members[m] = { ...prev, lastFailure: { initId: run.id, kind: run.kind, finishedAt: run.finishedAt ?? null, ...(run.error ? { error: run.error } : {}) } };
    }
  }
  if (run.state === "done") {
    rec.repos = [...new Set([...rec.repos, ...(run.repos ?? [])])];
    if (run.kind !== "contribute" && run.finishedAt && rec.initializedAt !== run.finishedAt) {
      rec.depth = run.depthAfter ?? rec.depth;
      rec.initializedAt = run.finishedAt;
      rec.initializedBy = [...run.requestedBy];
    }
  }
}

/** bootstrap/status.json. */
export function statusDoc(project: string, run: InitRun, version: string, rec?: InitProjectRecord | null): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    state: run.state,
    project,
    initId: run.id,
    requestedBy: run.requestedBy,
    requests: run.requests.map((r) => r.path),
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    conversationId: run.conversationId,
    commits: run.commits ?? [],
    sessions: run.sessions,
    estimatedTokens: run.estimatedTokens,
    usage: runUsage(run),
    answers: run.answers,
    serverVersion: version,
  };
  if (run.finishedAt) doc.finishedAt = run.finishedAt;
  if (run.durationMs !== undefined) doc.durationMs = run.durationMs;
  if (run.question) doc.question = run.question;
  if (run.error) doc.error = run.error;
  doc.depth = rec?.depth ?? null;
  doc.initializedAt = rec?.initializedAt ?? null;
  doc.initializedBy = rec?.initializedBy ?? [];
  doc.repos = rec?.repos ?? [];
  doc.members = rec?.members ?? {};
  const lastRun: Record<string, unknown> = {
    initId: run.id,
    kind: run.kind ?? null,
    requestedBy: run.requestedBy,
    state: run.state,
    commits: run.commits ?? [],
    usage: runUsage(run),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    sessions: run.sessions,
    alreadyReflected: run.alreadyReflected ?? 0,
    alreadyStaged: run.alreadyStaged ?? 0,
  };
  if (run.error) lastRun.error = run.error;
  doc.lastRun = lastRun;
  return doc;
}

/** The run's usage in the normalized shape (older state kept the SDK's raw counters). */
export function runUsage(run: Pick<InitRun, "usage">): Usage {
  return normalizeUsage(run.usage) ?? emptyUsage();
}

function addUsage(run: InitRun, r: Pick<TurnResult, "usage">): void {
  const u = normalizeUsage(r.usage);
  if (u) run.usage = addNormalizedUsage(runUsage(run), u);
}

function touch(run: InitRun, st?: InitState): void {
  if (st) run.state = st;
  run.updatedAt = new Date().toISOString();
}

/**
 * Write bootstrap/status.json and the pending ingest/log.jsonl lines in one
 * commit and push it. A failed push is logged and left for the next publish
 * (the log lines stay in state.pendingLog, which the normal pass also flushes).
 */
export async function publishInit(d: InitDeps, run: InitRun): Promise<boolean> {
  const { p, state } = d;
  applyRunToProject(state, run);
  await saveState(d.cfg.stateDir, p.project, state);
  const lines = state.pendingLog.map((e) => JSON.stringify(e).replace(/\n/g, " "));
  const n = lines.length;
  try {
    const sha = await commitFilesAndPush(
      p.transcriptsRepo,
      d.repoDir,
      async (dir) => {
        await mkdir(join(dir, "bootstrap"), { recursive: true });
        await writeFile(join(dir, INIT_STATUS_PATH), JSON.stringify(statusDoc(p.project, run, d.version, state.initProject), null, 2) + "\n", "utf8");
        const paths = [INIT_STATUS_PATH];
        if (lines.length) {
          const logPath = join(dir, "ingest", "log.jsonl");
          await mkdir(dirname(logPath), { recursive: true });
          const prev = existsSync(logPath) ? await readFile(logPath, "utf8") : "";
          await writeFile(logPath, prev + (prev && !prev.endsWith("\n") ? "\n" : "") + lines.join("\n") + "\n", "utf8");
          paths.push("ingest/log.jsonl");
        }
        return paths;
      },
      `init: ${run.state} (${run.id})\n\nWritten by the mem-mem worker.`,
    );
    state.pendingLog = state.pendingLog.slice(n);
    await saveState(d.cfg.stateDir, p.project, state);
    log("info", "init_status_pushed", { project: p.project, initId: run.id, state: run.state, commit: sha, logEntries: n });
    return true;
  } catch (err) {
    log("error", "init_status_push_failed", { project: p.project, initId: run.id, state: run.state, error: errorMessage(err) });
    return false;
  }
}

/** A git failure in one line: git's own message (already redacted), not the command line. */
function gitDetail(err: unknown): string {
  if (err instanceof GitError && err.stderr) return err.stderr.replace(/\s+/g, " ").trim().slice(0, 500);
  return errorMessage(err).replace(/\s+/g, " ").trim().slice(0, 500);
}

async function loadRequests(repoDir: string, entries: BootstrapEntry[]): Promise<LoadedRequest[]> {
  const out: LoadedRequest[] = [];
  for (const e of entries) {
    let doc;
    try {
      doc = parseRequest(await readFile(join(repoDir, e.path), "utf8"));
    } catch (err) {
      throw new InitFailure(`cannot read ${e.path}: ${errorMessage(err)}`);
    }
    out.push({ ...e, doc });
  }
  return out;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, onAbort: () => void): Promise<T> {
  if (signal.aborted) {
    onAbort();
    return Promise.reject(new InitAborted(String(signal.reason ?? "aborted")));
  }
  return new Promise<T>((resolve, reject) => {
    const handler = () => {
      onAbort();
      reject(new InitAborted(String(signal.reason ?? "aborted")));
    };
    signal.addEventListener("abort", handler, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", handler);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", handler);
        reject(e);
      },
    );
  });
}

/** Clone or update the code repo and the related repos. */
async function prepareCode(d: InitDeps, plan: InitPlan, kind: InitKind): Promise<{ codeDir: string | null; codeHead: string | null; related: { spec: string; dir: string }[] }> {
  const { cfg, p } = d;
  let codeDir: string | null = null;
  let codeHead: string | null = null;
  if (plan.codeRepo) {
    codeDir = codeDirOf(cfg, p.project);
    const t0 = Date.now();
    try {
      codeHead = (await syncRepo(repoCloneUrl(plan.codeRepo), codeDir)).head;
    } catch (err) {
      throw new InitFailure(`cannot clone the code repo ${plan.codeRepo}: ${gitDetail(err)}`);
    }
    log("info", "init_code_ready", { project: p.project, repo: plan.codeRepo, dir: codeDir, head: codeHead, durationMs: Date.now() - t0 });
  } else if (kind !== "contribute") {
    throw new InitFailure("the request has no codeRepo (the project has no git remote 'origin'); the server needs a URL it can clone");
  } else if (existsSync(join(codeDirOf(cfg, p.project), ".git"))) {
    codeDir = codeDirOf(cfg, p.project); // contribution: reuse the clone of an earlier init
    codeHead = await headOf(codeDir);
  }
  const related: { spec: string; dir: string }[] = [];
  for (const spec of plan.historyOnly ? [] : plan.repos) {
    const dir = join(projectCwd(cfg, p.project), relatedRepoDir(spec));
    try {
      await syncRepo(repoCloneUrl(spec), dir);
    } catch (err) {
      throw new InitFailure(`cannot clone the related repo ${spec}: ${gitDetail(err)}`);
    }
    related.push({ spec, dir });
    log("info", "init_code_ready", { project: p.project, repo: spec, dir, related: true });
  }
  return { codeDir, codeHead, related };
}

/**
 * Lay out the run's sessions: every member's for project_init / deepen, only
 * the requesting members' for contribute; sessions a reflection already
 * handled are left out except on a first project_init, and a contribute also
 * leaves out sessions an earlier init run analysed (`state.initStagedSessions`).
 */
async function prepareHistory(d: InitDeps, scan: BootstrapScan, codeDir: string | null, scope: InitRun["historyScope"]): Promise<HistoryLayout | null> {
  const aliases = aliasMap(readMembers(d.repoDir));
  const who = (m: string) => resolveMember(m, aliases);
  const members = scope?.members ?? null;
  const manifests = members ? scan.manifests.filter((m) => members.includes(who(m.member))) : scan.manifests;
  if (!manifests.length) {
    await rm(d.cfg.initTrajectoriesDir, { recursive: true, force: true });
    return null;
  }
  return layoutHistory({
    repoDir: d.repoDir,
    manifests,
    outDir: d.cfg.initTrajectoriesDir,
    maxSessions: d.cfg.settings.initMaxSessions,
    codeDir,
    exclude: scope?.excludeReflected ? await loadReflectedSessions(d.repoDir) : undefined,
    excludeStaged: scope?.excludeStaged ? (d.state.initStagedSessions ?? {}) : undefined,
    resolveMember: who,
  });
}

/** Session id -> member handle of a history layout. */
function stagedOf(history: HistoryLayout | null): Record<string, string> {
  return Object.fromEntries((history?.sessions ?? []).map((s) => [s.sessionId, s.member ?? ""]));
}

/** Session id -> member of the laid-out manifest.json (a run started before `stagedSessions` was recorded). */
async function stagedOnDisk(dir: string): Promise<Record<string, string>> {
  try {
    const man = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as { sessions?: { sessionId?: unknown; member?: unknown }[] };
    const out: Record<string, string> = {};
    for (const x of Array.isArray(man.sessions) ? man.sessions : []) {
      if (x && typeof x.sessionId === "string") out[x.sessionId] = typeof x.member === "string" ? x.member : "";
    }
    return out;
  } catch {
    return {};
  }
}

async function readStatusFile(repoDir: string): Promise<Record<string, unknown> | null> {
  try {
    const doc = JSON.parse(await readFile(join(repoDir, INIT_STATUS_PATH), "utf8")) as unknown;
    return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Record the requesting members as `running` (keeping their previous entries for a failure). */
function startMembers(rec: InitProjectRecord, run: InitRun): void {
  run.prevMembers = {};
  for (const m of run.requestedBy) {
    run.prevMembers[m] = rec.members[m] ? { ...rec.members[m]! } : null;
    rec.members[m] = { kind: run.kind!, sessions: 0, finishedAt: null, initId: run.id, state: "running" };
  }
}

function followOptions(d: InitDeps, sinceMs: number): Omit<FollowOptions, "deadline"> {
  return {
    isTerminal: isTerminalInitReply,
    backgroundActive: async () => anyWorkflowActive(await workflowExecutions(d.cfg.lettaConfigDir, sinceMs)),
    idleMs: FOLLOW_IDLE_MS,
  };
}

/** Best effort: Letta's background output files for workflows (`<tmp>/letta-background-*\/workflow_<n>.log`) written since `sinceMs`. */
async function workflowLogs(sinceMs: number): Promise<string[]> {
  const out: string[] = [];
  try {
    for (const d of await readdir(tmpdir())) {
      if (!d.startsWith("letta-background-")) continue;
      for (const f of await readdir(join(tmpdir(), d)).catch(() => [] as string[])) {
        if (!/^workflow_\d+\.log$/.test(f)) continue;
        const path = join(tmpdir(), d, f);
        const st = await stat(path).catch(() => null);
        if (st && st.mtimeMs >= sinceMs) out.push(path);
      }
    }
  } catch {
    // no tmp access
  }
  return out.sort();
}

async function openInitSession(d: InitDeps, run: InitRun): Promise<IngestSession> {
  const { cfg, p, gw } = d;
  const cwd = existsSync(join(codeDirOf(cfg, p.project), ".git")) ? codeDirOf(cfg, p.project) : projectCwd(cfg, p.project);
  const s = await gw.openSession(p.agentId, run.conversationId, { cwd, stepCount: cfg.settings.stepCount, permissionMode: "unrestricted" });
  if (s.conversationId !== run.conversationId) {
    s.close();
    throw new InitFailure(`the init conversation ${run.conversationId} could not be resumed`);
  }
  return s;
}

/**
 * The agent ended a turn to wait for background work whose notification
 * never reached it: wait for Letta's Workflow executions to settle, then send
 * a continue turn naming their results. At most MAX_CONTINUE_TURNS. Returns
 * the last assistant message.
 */
async function continueWhileWaiting(d: InitDeps, run: InitRun, text: string, sinceMs: number, deadline: number): Promise<string> {
  const { cfg, p } = d;
  for (let i = 1; i <= MAX_CONTINUE_TURNS && waitingOnBackground(text) && Date.now() < deadline; i++) {
    while (Date.now() < deadline && !d.signal.aborted && anyWorkflowActive(await workflowExecutions(cfg.lettaConfigDir, sinceMs))) await sleep(5_000);
    if (d.signal.aborted) throw new InitAborted(String(d.signal.reason));
    const execs = await workflowExecutions(cfg.lettaConfigDir, sinceMs);
    const logs = await workflowLogs(sinceMs);
    const turn = buildContinueTurn(execs.map((e, k) => ({ id: e.id, journal: e.journal, log: logs[k] })));
    const s = await openInitSession(d, run);
    try {
      const r = await raceAbort(s.sendTurn(turn, Math.max(60_000, deadline - Date.now()), followOptions(d, sinceMs)), d.signal, () => void s.abort());
      addUsage(run, r);
      log("info", "init_continue_turn_done", {
        project: p.project,
        initId: run.id,
        n: i,
        workflows: execs.map((e) => e.id),
        durationMs: r.durationMs,
        followedMs: r.followedMs,
        toolCalls: r.toolCalls,
        notableCommands: r.notableCommands,
        usage: normalizeUsage(r.usage),
        reply: reportExcerpt(r.finalReply ?? r.reply, 800),
      });
      text = r.finalReply ?? r.reply;
    } finally {
      s.close();
    }
  }
  return text;
}

/**
 * A new init run over `pending` requests. Resolves when the run is done,
 * failed, or waiting for an answer; never throws.
 */
export async function runInitJob(d: InitDeps, scan: BootstrapScan, pending: BootstrapEntry[]): Promise<InitRun> {
  const { cfg, p, state, gw } = d;
  const now = new Date();
  const run: InitRun = {
    id: newInitId(now),
    state: "running",
    requests: pending.map((r) => ({ path: r.path, blob: r.blob, member: r.member })),
    requestedBy: [...new Set(pending.map((r) => r.member))],
    conversationId: null,
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    baselineHead: null,
    answersSeen: Object.fromEntries(scan.answers.map((a) => [a.path, a.blob])),
    answers: 0,
    usage: emptyUsage(),
    sessions: 0,
    estimatedTokens: 0,
  };
  state.init = run; // before the first await: `init run` reports this run
  run.baselineHead = await gw.memfsHead(p.agentId);
  await saveState(cfg.stateDir, p.project, state);
  log("info", "init_started", { project: p.project, initId: run.id, requests: run.requests.map((r) => r.path), requestedBy: run.requestedBy });
  let session: IngestSession | null = null;
  try {
    const loaded = await loadRequests(d.repoDir, pending);
    const members = readMembers(d.repoDir);
    const aliases = aliasMap(members);
    const lang = applyProjectLanguage(mergeRequests(loaded, aliases), p.language);
    const plan = lang.plan;
    if (lang.requested.length) {
      log("info", "init_language_overridden", { project: p.project, initId: run.id, requested: lang.requested.join(","), language: p.language });
    }
    run.requestedBy = plan.requestedBy;
    for (const r of run.requests) r.requestedAt = loaded.find((l) => l.path === r.path)?.doc.requestedAt;
    const src = readBootstrapSources(d.repoDir);
    const rec = initProjectOf(state, await readStatusFile(d.repoDir));
    normalizeMemberKeys(rec, aliases);
    const seeded = seedInitStagedSessions(state, rec, src, pending.map((r) => r.path));
    if (seeded !== null) log("info", "init_staged_sessions_seeded", { project: p.project, sessions: seeded });
    const previous = { initializedAt: rec.initializedAt, initializedBy: [...rec.initializedBy] };
    const cls: InitClassification = classifyInit(plan, { initialized: !!rec.initializedAt, depth: rec.depth });
    run.kind = cls.kind;
    run.depthBefore = cls.depthBefore;
    run.depthAfter = cls.depthAfter;
    run.reinit = cls.reinit || undefined;
    run.repos = plan.historyOnly ? [] : plan.repos;
    run.historyScope = {
      members: cls.kind === "contribute" ? plan.requestedBy : null,
      excludeReflected: cls.kind !== "project_init" || cls.reinit,
      excludeStaged: cls.kind === "contribute",
    };
    log("info", "init_classified", {
      project: p.project,
      initId: run.id,
      kind: cls.kind,
      reason: cls.reason,
      requestedBy: run.requestedBy,
      depthBefore: cls.depthBefore,
      depthAfter: cls.depthAfter,
      reinit: cls.reinit || undefined,
    });
    if (cls.downgradeIgnored) {
      log("info", "init_depth_downgrade_ignored", { project: p.project, initId: run.id, recorded: rec.depth ?? "standard", requestedBy: run.requestedBy });
    }
    startMembers(rec, run);
    await publishInit(d, run);
    if (d.signal.aborted) throw new InitAborted(String(d.signal.reason));

    const code = await prepareCode(d, plan, cls.kind);
    if (d.signal.aborted) throw new InitAborted(String(d.signal.reason));
    const history = await prepareHistory(d, scan, code.codeDir, run.historyScope);
    run.sessions = history?.sessions.length ?? 0;
    run.estimatedTokens = history?.estimatedTokens ?? 0;
    run.alreadyReflected = history?.alreadyReflected ?? 0;
    run.alreadyStaged = history?.alreadyStaged ?? 0;
    run.stagedSessions = stagedOf(history);
    // Per-member session counts (and members a project_init / deepen re-stages).
    for (const [m, e] of Object.entries(rec.members)) if (e.initId === run.id) e.sessions = history?.byMember[m] ?? 0;
    for (const m of history?.members ?? []) {
      if (!rec.members[m]) {
        run.prevMembers![m] = null;
        rec.members[m] = { kind: cls.kind, sessions: history!.byMember[m] ?? 0, finishedAt: null, initId: run.id, state: "running" };
      }
    }
    log("info", "init_estimate", {
      project: p.project,
      initId: run.id,
      kind: cls.kind,
      sessions: run.sessions,
      byMember: history?.byMember,
      bySource: history?.bySource,
      historyBytes: history?.bytes ?? 0,
      estimatedHistoryTokens: run.estimatedTokens,
      dropped: history?.dropped.length ?? 0,
      alreadyReflected: run.alreadyReflected,
      alreadyStaged: run.alreadyStaged,
      maxSessions: cfg.settings.initMaxSessions,
      trajectoriesDir: history ? history.outDir : null,
    });
    await saveState(cfg.stateDir, p.project, state);
    if (!run.sessions && cls.kind === "contribute") {
      if (plan.historyOnly && !run.alreadyReflected && !run.alreadyStaged) throw new InitFailure("history-only request, but no sessions were uploaded");
      if (plan.historyOnly || (!plan.memberStyles.length && !plan.repos.length)) {
        log("info", "init_nothing_to_contribute", { project: p.project, initId: run.id, requestedBy: run.requestedBy, alreadyReflected: run.alreadyReflected, alreadyStaged: run.alreadyStaged });
        return await finish(d, run, "done");
      }
    }

    const cwd = code.codeDir ?? projectCwd(cfg, p.project);
    await mkdir(cwd, { recursive: true });
    session = await gw.openSession(p.agentId, null, { cwd, stepCount: cfg.settings.stepCount, permissionMode: "unrestricted" });
    run.conversationId = session.conversationId;
    touch(run);
    await saveState(cfg.stateDir, p.project, state);
    log("info", "init_conversation_opened", { project: p.project, initId: run.id, conversationId: run.conversationId, cwd });

    const s = session;
    const preText = buildPreAnswerTurn({
      project: p.project,
      initId: run.id,
      plan,
      history,
      codeDir: code.codeDir,
      codeHead: code.codeHead,
      relatedDirs: code.related,
      historyModel: cfg.settings.initHistoryModel,
      classification: cls,
      previous,
      members,
    });
    const pre = await raceAbort(s.sendTurn(preText, PRE_ANSWER_TIMEOUT_MS), d.signal, () => void s.abort());
    addUsage(run, pre);
    log("info", "init_preanswer_done", { project: p.project, initId: run.id, durationMs: pre.durationMs, chars: preText.length, reply: pre.reply.slice(0, 300), usage: normalizeUsage(pre.usage) });

    const t0 = Date.now();
    log("info", "init_command_started", { project: p.project, initId: run.id, conversationId: run.conversationId, timeoutMinutes: cfg.settings.initTimeoutMinutes });
    const r = await raceAbort(s.runCommandTurn("init", initTimeoutMs(cfg), undefined, followOptions(d, t0)), d.signal, () => void s.abort());
    addUsage(run, r);
    log(r.success ? "info" : "warn", "init_command_done", {
      project: p.project,
      initId: run.id,
      success: r.success,
      output: r.output.slice(0, 300),
      durationMs: Date.now() - t0,
      followedMs: r.followedMs,
      backgroundLaunches: r.backgroundLaunches,
      toolCalls: r.toolCalls,
      notableCommands: r.notableCommands,
      usage: normalizeUsage(r.usage),
      reply: reportExcerpt(r.finalReply ?? r.reply, 800),
    });
    session.close();
    session = null;
    if (!r.success) throw new InitFailure(`Letta init command failed: ${r.output}`);
    const text = await continueWhileWaiting(d, run, r.finalReply ?? r.reply, t0, t0 + initTimeoutMs(cfg));
    return await settle(d, run, text);
  } catch (err) {
    return await failRun(d, run, err);
  } finally {
    session?.close();
  }
}

/** Relay new answer files as the next turn of a run that waits for an answer. */
export async function continueInitJob(d: InitDeps, scan: BootstrapScan, answers: BootstrapScan["answers"]): Promise<InitRun> {
  const { cfg, p, state, gw } = d;
  const run = state.init!;
  const texts: { member: string; text: string }[] = [];
  for (const a of answers) {
    run.answersSeen[a.path] = a.blob;
    try {
      const t = answerText(await readFile(join(d.repoDir, a.path), "utf8"));
      if (t) texts.push({ member: a.member, text: t });
    } catch (err) {
      log("warn", "init_answer_unreadable", { project: p.project, initId: run.id, file: a.path, error: errorMessage(err) });
    }
  }
  if (!texts.length) {
    await saveState(cfg.stateDir, p.project, state);
    return run;
  }
  run.answers += texts.length;
  run.question = undefined;
  touch(run, "running");
  await saveState(cfg.stateDir, p.project, state);
  log("info", "init_answer_received", { project: p.project, initId: run.id, files: answers.map((a) => a.path), members: texts.map((t) => t.member) });
  await publishInit(d, run);
  let session: IngestSession | null = null;
  try {
    if (!run.conversationId) throw new InitFailure("the init conversation is unknown");
    if (run.sessions > 0 && !existsSync(join(cfg.initTrajectoriesDir, "manifest.json"))) {
      // /tmp was cleared (a restart while waiting): lay the sessions out again.
      const h = await prepareHistory(d, scan, existsSync(join(codeDirOf(cfg, p.project), ".git")) ? codeDirOf(cfg, p.project) : null, run.historyScope);
      run.stagedSessions ??= stagedOf(h);
    }
    session = await openInitSession(d, run);
    const s = session;
    const t0 = Date.now();
    const r = await raceAbort(s.sendTurn(buildAnswerTurn(texts), initTimeoutMs(cfg), followOptions(d, t0)), d.signal, () => void s.abort());
    addUsage(run, r);
    log("info", "init_answer_turn_done", {
      project: p.project,
      initId: run.id,
      durationMs: r.durationMs,
      followedMs: r.followedMs,
      backgroundLaunches: r.backgroundLaunches,
      toolCalls: r.toolCalls,
      notableCommands: r.notableCommands,
      usage: normalizeUsage(r.usage),
      reply: reportExcerpt(r.finalReply ?? r.reply, 800),
    });
    session.close();
    session = null;
    const text = await continueWhileWaiting(d, run, r.finalReply ?? r.reply, t0, t0 + initTimeoutMs(cfg));
    return await settle(d, run, text);
  } catch (err) {
    return await failRun(d, run, err);
  } finally {
    session?.close();
  }
}

/** Classify the last assistant message and finish or wait. */
async function settle(d: InitDeps, run: InitRun, finalText: string): Promise<InitRun> {
  const { p } = d;
  const memfs = d.gw.memfsDir(p.agentId);
  const commits = await commitsBetween(memfs, run.baselineHead);
  const outcome = classifyInitReply(finalText, commits.length > 0);
  log("info", "init_outcome", { project: p.project, initId: run.id, outcome: outcome.kind, source: outcome.source, commits: commits.length });
  if (outcome.kind === "question") {
    run.question = outcome.question;
    run.commits = commits;
    touch(run, "waiting_for_answer");
    d.state.pendingLog.push(logEntry(p.project, run));
    await saveState(d.cfg.stateDir, p.project, d.state);
    // Commits made before the question are pushed now (the conversation may wait for days).
    await d.pushMemory();
    await publishInit(d, run);
    log("info", "init_waiting_for_answer", { project: p.project, initId: run.id, question: outcome.question.slice(0, 500) });
    return run;
  }
  if (outcome.kind === "failed") return finish(d, run, "failed", `the agent reported: ${outcome.reason}`);
  if (!commits.length) log("warn", "init_no_commit", { project: p.project, initId: run.id, hint: "Letta's init finished without a MemFS commit", reply: reportExcerpt(finalText, 500) });
  return finish(d, run, "done", undefined, outcome.kind === "done" ? outcome.followUp : undefined);
}

function logEntry(project: string, run: InitRun): LogEntry {
  const e: LogEntry = {
    ts: new Date().toISOString(),
    event: "init",
    project,
    initId: run.id,
    state: run.state,
    requestedBy: run.requestedBy,
    files: run.requests.map((r) => r.path),
    conversationId: run.conversationId ?? undefined,
    startedAt: run.startedAt,
    commits: (run.commits ?? []).map((c) => c.sha),
    sessions: run.sessions,
    usage: runUsage(run),
  };
  if (run.kind) e.classifiedAs = run.kind;
  if (run.alreadyReflected) e.alreadyReflected = run.alreadyReflected;
  if (run.alreadyStaged) e.alreadyStaged = run.alreadyStaged;
  if (run.finishedAt) e.finishedAt = run.finishedAt;
  if (run.durationMs !== undefined) e.durationMs = run.durationMs;
  if (run.question) e.question = run.question.slice(0, 1000);
  if (run.error) e.error = run.error;
  return e;
}

async function failRun(d: InitDeps, run: InitRun, err: unknown): Promise<InitRun> {
  let reason: string;
  if (err instanceof InitAborted) reason = err.message.startsWith("cancel") ? "cancelled by the operator" : `interrupted: ${err.message}`;
  else if (err instanceof TurnError && err.kind === "timeout") reason = `timed out after ${d.cfg.settings.initTimeoutMinutes} min (settings.initTimeoutMinutes)`;
  else reason = errorMessage(err);
  log("error", "init_failed", { project: d.p.project, initId: run.id, error: reason });
  try {
    return await finish(d, run, "failed", reason);
  } catch (e) {
    log("error", "init_finish_failed", { project: d.p.project, initId: run.id, error: errorMessage(e) });
    return run;
  }
}

/**
 * Terminal state: record the init's MemFS commits, push memory, mark the
 * requests processed, log, publish status.json, and clean the trajectories
 * directory. The code clone is kept for re-init.
 */
export async function finish(d: InitDeps, run: InitRun, st: "done" | "failed", error?: string, followUp?: string): Promise<InitRun> {
  const { cfg, p, state, gw } = d;
  const memfs = gw.memfsDir(p.agentId);
  run.commits = await commitsBetween(memfs, run.baselineHead).catch(() => run.commits ?? []);
  const pushed = run.commits.length ? await d.pushMemory() : null;
  // Later reflections must not claim the init's commits.
  state.memoryHeadSeen = (await gw.memfsHead(p.agentId)) ?? state.memoryHeadSeen;
  run.question = undefined;
  run.error = error;
  run.finishedAt = new Date().toISOString();
  run.durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  touch(run, st);
  // The sessions a done run laid out were analysed: a later contribute leaves them out.
  if (st === "done") {
    const staged = (state.initStagedSessions ??= {});
    for (const [id, member] of Object.entries(run.stagedSessions ?? (await stagedOnDisk(cfg.initTrajectoriesDir)))) staged[id] = { initId: run.id, member };
  }
  run.stagedSessions = undefined;
  state.initRequests ??= {};
  const outcome = st === "failed" && error === "cancelled by the operator" ? "cancelled" : st;
  for (const r of run.requests) state.initRequests[r.path] = { blob: r.blob, processedAt: run.finishedAt, outcome, initId: run.id };
  // The whole run's usage goes to the day it finished (once, even if finish is retried).
  if (!run.usageRecorded) {
    recordUsage(state, "init", runUsage(run), localDate());
    run.usageRecorded = true;
  }
  const entry = logEntry(p.project, run);
  if (followUp) entry.followUp = followUp.slice(0, 1000);
  state.pendingLog.push(entry);
  await saveState(cfg.stateDir, p.project, state);
  log(st === "done" ? "info" : "warn", st === "done" ? "init_done" : "init_failed_recorded", {
    project: p.project,
    initId: run.id,
    state: st,
    error,
    commits: run.commits.map((c) => `${c.sha.slice(0, 10)} ${c.subject}`),
    pushed,
    durationMs: run.durationMs,
    usage: runUsage(run),
    followUp: followUp ? followUp.slice(0, 300) : undefined,
  });
  await publishInit(d, run);
  await rm(cfg.initTrajectoriesDir, { recursive: true, force: true }).catch(() => undefined);
  return run;
}

/** Fail a run that has no job attached (cancel while waiting, a restart mid-run, a superseded question). */
export async function failDetached(d: InitDeps, reason: string): Promise<InitRun | null> {
  const run = d.state.init;
  if (!run || run.state === "done" || run.state === "failed") return null;
  log("warn", "init_failed", { project: d.p.project, initId: run.id, error: reason });
  return finish(d, run, "failed", reason);
}
