// The ingest loop: transcripts repo -> App Server turns -> reflection -> push.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError, loadConfig, projectCwd, type ProjectConfig, type WorkerConfig } from "./config.js";
import {
  blobId,
  changedIngestFiles,
  commitAndPushLog,
  commitExists,
  isNonFastForward,
  listIngestFiles,
  syncRepo,
} from "./git.js";
import {
  buildIngestTexts,
  buildNoteTexts,
  deriveMeta,
  extractRecords,
  parseInboxPath,
} from "./ingest-text.js";
import {
  IngestSession,
  LettaGateway,
  TurnError,
  reportExcerpt,
  sleep,
  stepsSinceReflection,
  type LettaPaths,
  type ReflectionState,
} from "./letta.js";
import { addUsage, emptyUsage, normalizeUsage, recordUsage, type Usage } from "./usage.js";
import {
  addPending,
  buildReflectionInstruction,
  buildRetryTurn,
  explainReflectionOutcome,
  type OutcomeDetail,
  type ReflectionOutcome,
} from "./reflection.js";
import { scanBootstrap, type BootstrapEntry, type BootstrapScan } from "./init.js";
import { markRequestsFromDoneStatus, readBootstrapSources, readStatusFileSync, seedInitStagedSessions } from "./init-recovery.js";
import { readMembers, readMembersDetailed } from "./members.js";
import { continueInitJob, failDetached, initProjectOf, newAnswers, pendingRequests, runInitJob, type InitDeps } from "./init-runner.js";
import { errorMessage, log } from "./log.js";
import {
  backoffMs,
  loadState,
  localDate,
  saveState,
  type LogEntry,
  type PendingReflectionItem,
  type ProjectState,
  type InitRun,
  type QueueItem,
  type UnreflectedItem,
} from "./state.js";

/** memmem-server's version (dist/worker.js -> ../package.json), for bootstrap/status.json. */
function serverVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

interface QueueItemExt extends QueueItem {
  /** Parts already sent for `partsBlob` (resume a split file without resending). */
  partsDone?: number;
  partsBlob?: string;
}

/** A reflection "started" longer ago than this without succeeding is treated as failed. */
const STALE_REFLECTION_MS = 15 * 60_000;

/** What the reflection helpers of one project pass share. */
interface ReflectCtx {
  cfg: WorkerConfig;
  p: ProjectConfig;
  state: ProjectState;
  /** Log entries of this pass (ingest entries get their `reflectionCommit` filled in). */
  batch: LogEntry[];
  /** MemFS main after the last recorded reflection: a reflection whose head differs made a commit. */
  baseline: string | null;
}

type LaunchResult =
  | {
      kind: "done";
      succeededAt: string;
      startedAt: string;
      commit: string | null;
      /** Report excerpt (for logs). */
      report?: string;
      reflectionAgentId?: string;
      /** committed / nothing_to_save / failed / unknown, and why. */
      outcome: OutcomeDetail;
      toolErrors: string[];
      /** Summed from the subagent conversation's usage records; null when none were found. */
      usage: Usage | null;
      /** Subagent model handle(s), when the records name them. */
      model: string | null;
    }
  | { kind: "nothing" } // Letta: no new transcript content
  | { kind: "not_done" }; // not started, failed to start, or timed out

/** Distinct files ingested into `conversationId` that no recorded reflection has covered yet. */
function unreflectedIn(state: ProjectState, conversationId: string): number {
  return state.unreflected.filter((u) => u.conversationId === conversationId).length;
}

function toPending(u: UnreflectedItem): PendingReflectionItem {
  const out: PendingReflectionItem = { file: u.file, conversationId: u.conversationId };
  if (u.session) out.session = u.session;
  if (u.member) out.member = u.member;
  if (u.tool) out.tool = u.tool;
  return out;
}

function sessionIds(items: PendingReflectionItem[]): string[] {
  return items.map((i) => (i.member ? `${i.member}:` : "") + (i.session ?? i.file));
}

/** A failed first try may be replaced by a better retry outcome in the same pass. */
const OUTCOME_RANK: Record<ReflectionOutcome, number> = { unknown: 0, failed: 0, nothing_to_save: 1, committed: 2 };

/** `toolErrors` log field: count and first excerpt, or undefined when there are none. */
function toolErrorSummary(errors: string[] | undefined): { count: number; first: string } | undefined {
  return errors && errors.length ? { count: errors.length, first: errors[0]! } : undefined;
}

function uniqueByFile(items: PendingReflectionItem[]): PendingReflectionItem[] {
  const m = new Map<string, PendingReflectionItem>();
  for (const i of items) m.set(i.file, { ...m.get(i.file), ...i });
  return [...m.values()];
}

export interface PassResult {
  project: string;
  ok: boolean;
  ingested: number;
  reflections: number;
  pushed: string | null;
  error?: string;
  /** An init job was started or continued this pass (ingest for the project waits for it). */
  init?: string;
}

/** `memmem-server init run|cancel`: what the worker did. */
export interface InitActionResult {
  project: string;
  ok: boolean;
  action: "run" | "cancel";
  initId?: string;
  state?: string;
  message?: string;
  error?: string;
  question?: string;
  commits?: { sha: string; subject: string }[];
}

/** `reflect now` runs a scheduled-style reflection; `reflect retry` the retry path (marker turn + retry instruction). */
export type ManualReflectMode = "now" | "retry";

export interface ManualReflectResult {
  project: string;
  mode: ManualReflectMode;
  ok: boolean;
  /** Reflections recorded (a retry counts separately). */
  reflections: number;
  /** The `reflection` log entries this run produced (outcome, commit, files). */
  entries: LogEntry[];
  /** MemFS head pushed to the memory repo, if it moved. */
  pushed: string | null;
  /** Sessions still unreflected / carried forward after the run. */
  unreflected: number;
  pendingReflection: number;
  message?: string;
}

/** A request file written by the CLI into `requestsDir` (`<id>.json`); the result goes to `<id>.result.json`. */
export type WorkerRequest =
  | { id: string; kind: "reflect"; project: string; mode: ManualReflectMode; createdAt: string }
  | { id: string; kind: "init"; project: string; action: "run" | "cancel"; createdAt: string };

export class Worker {
  private stopping = false;
  private readonly abort = new AbortController();
  private gateway: LettaGateway | null = null;
  private cfg: WorkerConfig | null = null;
  /** Projects whose persisted backoff was already cleared in this process. */
  private readonly backoffResetDone = new Set<string>();
  /** Aborted by `wake()` to cut the poll sleep short (a CLI request is waiting). */
  private wakeCtl = new AbortController();
  /** Init jobs running in the background, one per project (that project's ingest waits). */
  private readonly inits = new Map<string, { promise: Promise<InitRun | null>; ctl: AbortController }>();
  private readonly version = serverVersion();

  constructor(
    private readonly configLoader: () => WorkerConfig = () => loadConfig(),
    /** Injection point for tests. */
    private readonly gatewayFactory: (url: string, paths: LettaPaths) => LettaGateway = (url, paths) => new LettaGateway(url, paths),
  ) {}

  stop(): void {
    this.stopping = true;
    this.abort.abort();
    for (const job of this.inits.values()) job.ctl.abort("worker stopping");
  }

  /** Projects with an init job running in this process. */
  get runningInits(): string[] {
    return [...this.inits.keys()];
  }

  /** Wait for every running init job (tests, single-pass mode, shutdown). */
  async waitForInits(timeoutMs = Infinity): Promise<void> {
    const all = Promise.all([...this.inits.values()].map((j) => j.promise.catch(() => null)));
    if (timeoutMs === Infinity) await all;
    else await Promise.race([all, sleep(timeoutMs)]);
  }

  /** Close the App Server connection (for one-shot use such as `reflect now` without a running server). */
  async close(): Promise<void> {
    await this.gateway?.close();
    this.gateway = null;
  }

  /** End the current poll sleep early (the next loop handles pending CLI requests). */
  wake(): void {
    this.wakeCtl.abort();
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  /** Reload the config each pass so new projects are picked up without a restart. */
  private reloadConfig(): WorkerConfig | null {
    try {
      const cfg = this.configLoader();
      const changed =
        !this.cfg ||
        this.cfg.configPath !== cfg.configPath ||
        JSON.stringify(this.cfg.projects.map((p) => p.project)) !== JSON.stringify(cfg.projects.map((p) => p.project)) ||
        JSON.stringify(this.cfg.settings) !== JSON.stringify(cfg.settings);
      if (changed) {
        log("info", "config_loaded", {
          configPath: cfg.configPath,
          projects: cfg.projects.map((p) => p.project),
          appServerUrl: cfg.appServerUrl,
          stepCount: cfg.settings.stepCount,
          dailyReflectHour: cfg.settings.dailyReflectHour,
        });
      }
      this.ensureGateway(cfg);
      this.cfg = cfg;
      return cfg;
    } catch (err) {
      log("error", "config_error", { error: errorMessage(err), invalidConfig: err instanceof ConfigError });
      return this.cfg; // keep running with the last good config, if any
    }
  }

  private ensureGateway(cfg: WorkerConfig): LettaGateway {
    const g = this.gateway;
    if (!g || g.url !== cfg.appServerUrl || g.paths.lettaConfigDir !== cfg.lettaConfigDir || g.paths.transcriptRoot !== cfg.transcriptRoot) {
      void g?.close();
      this.gateway = this.gatewayFactory(cfg.appServerUrl, { lettaConfigDir: cfg.lettaConfigDir, transcriptRoot: cfg.transcriptRoot });
    }
    return this.gateway!;
  }

  async run(): Promise<number> {
    let exitCode = 0;
    while (!this.stopping) {
      const cfg = this.reloadConfig();
      if (cfg) {
        await this.handleRequests(cfg);
        const results = await this.runPass(cfg);
        if (cfg.once) {
          await this.waitForInits();
          exitCode = results.every((r) => r.ok) ? 0 : 1;
          break;
        }
        await this.handleRequests(cfg);
      } else if (process.env.MEMMEM_ONCE === "1" || process.env.MEMMEM_ONCE === "true") {
        exitCode = 2; // no usable config in single-pass mode
        break;
      }
      const envPoll = Number(process.env.MEMMEM_POLL_SECONDS);
      const pollSeconds = cfg?.pollSeconds ?? (Number.isFinite(envPoll) && envPoll > 0 ? envPoll : 60);
      if (this.wakeCtl.signal.aborted) this.wakeCtl = new AbortController();
      await sleep(pollSeconds * 1000, AbortSignal.any([this.abort.signal, this.wakeCtl.signal]));
      if (this.wakeCtl.signal.aborted) this.wakeCtl = new AbortController();
    }
    // An init job that is still running was aborted by stop(): let it record the failure.
    await this.waitForInits(25_000);
    await this.gateway?.close();
    return exitCode;
  }

  /**
   * Run the CLI's one-shot requests (`memmem-server reflect now|retry`) that
   * wait in `requestsDir`. They run here, between passes, so they never race
   * the pass over the same project's state file.
   */
  async handleRequests(cfg: WorkerConfig): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(cfg.requestsDir)).filter((n) => n.endsWith(".json") && !n.endsWith(".result.json")).sort();
    } catch {
      return; // no requests dir
    }
    for (const name of names) {
      if (this.stopping) return;
      const path = join(cfg.requestsDir, name);
      let req: WorkerRequest;
      try {
        req = JSON.parse(await readFile(path, "utf8")) as WorkerRequest;
      } catch {
        await rm(path, { force: true });
        continue;
      }
      log("info", "request_started", { id: req.id, kind: req.kind, project: req.project, mode: req.kind === "reflect" ? req.mode : req.action });
      let result: ManualReflectResult | InitActionResult | { ok: false; message: string };
      try {
        if (req.kind === "init") {
          result = req.action === "cancel" ? await this.cancelInit(cfg, req.project) : await this.initNow(cfg, req.project, { force: true, wait: false });
        } else {
          result = await this.reflectOnce(cfg, req.project, req.mode);
        }
      } catch (err) {
        result = { ok: false, message: errorMessage(err) };
      }
      const out = join(cfg.requestsDir, `${req.id}.result.json`);
      await writeFile(`${out}.tmp`, JSON.stringify({ id: req.id, finishedAt: new Date().toISOString(), ...result }, null, 2) + "\n", "utf8");
      await rename(`${out}.tmp`, out);
      await rm(path, { force: true });
      log(result.ok ? "info" : "warn", "request_done", { id: req.id, project: req.project, ok: result.ok, message: result.message });
    }
  }

  /**
   * One manual reflection on the project's current ingest conversation, with
   * the same instruction, outcome classification, retry, carry-forward,
   * memory push and `ingest/log.jsonl` entries as a scheduled one.
   * `now` runs the scheduled path (`reflectAndRecord`); `retry` runs the
   * retry path (`retryPending`) over the carried and unreflected sessions.
   */
  async reflectOnce(cfg: WorkerConfig, project: string, mode: ManualReflectMode): Promise<ManualReflectResult> {
    const p = cfg.projects.find((x) => x.project === project);
    if (!p) throw new Error(`unknown project: ${project}`);
    this.ensureGateway(cfg);
    const gw = this.gw();
    const state = await loadState(cfg.stateDir, p.project);
    if (this.inits.has(project)) {
      return { project, mode, ok: false, reflections: 0, entries: [], pushed: null, unreflected: state.unreflected.length, pendingReflection: state.pendingReflection.length, message: "an init is running for this project; reflect after it finishes" };
    }
    const base: ManualReflectResult = {
      project,
      mode,
      ok: false,
      reflections: 0,
      entries: [],
      pushed: null,
      unreflected: state.unreflected.length,
      pendingReflection: state.pendingReflection.length,
    };
    const conv = state.conversation?.id;
    if (!conv) return { ...base, message: "no ingest conversation yet: nothing has been ingested for this project" };
    const memfs = gw.memfsDir(p.agentId);
    if (!existsSync(join(memfs, ".git"))) throw new Error(`MemFS for ${p.agentId} not found at ${memfs}`);
    const headAtStart = await gw.memfsHead(p.agentId);
    const batch: LogEntry[] = [];
    const ctx: ReflectCtx = { cfg, p, state, batch, baseline: state.memoryHeadSeen ?? headAtStart };
    const cwd = projectCwd(cfg, p.project);
    await mkdir(cwd, { recursive: true });
    const session = await gw.openSession(p.agentId, conv, { cwd, stepCount: cfg.settings.stepCount });
    let message: string | undefined;
    let reflections = 0;
    let pushed: string | null = null;
    try {
      if (session.conversationId !== conv) {
        log("warn", "conversation_replaced", { project: p.project, previous: conv, conversationId: session.conversationId });
        state.conversation = { id: session.conversationId, date: state.conversation?.date ?? localDate() };
      }
      const pendingBefore = state.unreflected.filter((u) => u.conversationId === session.conversationId).length + state.pendingReflection.length;
      if (mode === "now" && pendingBefore === 0) {
        message = "nothing to reflect: no unreflected or carried-forward sessions";
      } else if (mode === "now") {
        reflections += await this.reflectAndRecord(ctx, session, "manual");
      } else {
        const extra = state.unreflected.filter((u) => u.conversationId === session.conversationId).map(toPending);
        if (!extra.length && !state.pendingReflection.length) message = "nothing to retry: no carried-forward or unreflected sessions";
        else reflections += await this.retryPending(ctx, session, "manual", extra, "manual retry requested by the operator");
      }
      reflections += await this.collectReflections(ctx);
      pushed = await this.pushMemoryIfMoved(p, state);
      state.memoryHeadSeen = (await gw.memfsHead(p.agentId)) ?? state.memoryHeadSeen;
    } finally {
      session.close();
      if (batch.length) state.pendingLog.push(...batch);
      await saveState(cfg.stateDir, p.project, state);
    }
    const logError = await this.flushLog(cfg, p, state);
    const entries = batch.filter((e) => e.event === "reflection");
    const nothingToDo = !!message && reflections === 0;
    if (!message && reflections === 0) message = "no reflection was recorded (Letta found nothing new to reflect on, or it did not finish in time; see the log)";
    return {
      ...base,
      ok: !logError && (reflections > 0 || nothingToDo),
      reflections,
      entries,
      pushed,
      unreflected: state.unreflected.length,
      pendingReflection: state.pendingReflection.length,
      message: logError ? `ingest log push failed: ${logError}` : message,
    };
  }

  async runPass(cfg: WorkerConfig): Promise<PassResult[]> {
    const results: PassResult[] = [];
    this.ensureGateway(cfg);
    for (const p of cfg.projects) {
      if (this.stopping) break;
      if (p.enabled === false) continue;
      const t0 = Date.now();
      try {
        const r = await this.processProject(cfg, p);
        results.push(r);
        if (r.ingested || r.reflections || r.pushed || !r.ok) {
          log(r.ok ? "info" : "warn", "project_pass", { ...r, durationMs: Date.now() - t0 });
        }
      } catch (err) {
        const msg = errorMessage(err);
        results.push({ project: p.project, ok: false, ingested: 0, reflections: 0, pushed: null, error: msg });
        // Back off on repeated project-level failures (bad repo URL, App Server down, ...).
        try {
          const st = await loadState(cfg.stateDir, p.project);
          st.backoff.failures += 1;
          const wait = backoffMs(st.backoff.failures, cfg.pollSeconds * 1000);
          st.backoff.until = new Date(Date.now() + wait).toISOString();
          st.backoff.reason = msg.slice(0, 500);
          st.lastPassAt = new Date().toISOString();
          st.lastError = { at: st.lastPassAt, message: msg.slice(0, 500) };
          await saveState(cfg.stateDir, p.project, st);
          log("error", "project_error", { project: p.project, error: msg, failures: st.backoff.failures, retryInMs: wait });
        } catch (stateErr) {
          log("error", "project_error", { project: p.project, error: msg, stateError: errorMessage(stateErr) });
        }
      }
    }
    return results;
  }

  private gw(): LettaGateway {
    if (!this.gateway) throw new Error("gateway not initialized");
    return this.gateway;
  }

  async processProject(cfg: WorkerConfig, p: ProjectConfig): Promise<PassResult> {
    const result: PassResult = { project: p.project, ok: true, ingested: 0, reflections: 0, pushed: null };
    if (this.inits.has(p.project)) {
      // The init job owns this project's state and clone until it settles.
      log("debug", "init_running", { project: p.project });
      return result;
    }
    const state = await loadState(cfg.stateDir, p.project);
    if (!this.backoffResetDone.has(p.project)) {
      // A backoff is for repeated failures in this process. After a restart
      // (often because the operator fixed the cause) start without waiting.
      this.backoffResetDone.add(p.project);
      if (state.backoff.until || state.backoff.failures > 0) {
        log("info", "backoff_reset", {
          project: p.project,
          previousFailures: state.backoff.failures,
          previousUntil: state.backoff.until,
          reason: state.backoff.reason,
        });
        state.backoff = { failures: 0, until: null };
        await saveState(cfg.stateDir, p.project, state);
      }
    }
    const now = new Date();
    if (state.backoff.until && Date.parse(state.backoff.until) > now.getTime()) {
      log("debug", "project_backoff", { project: p.project, until: state.backoff.until, reason: state.backoff.reason });
      return result;
    }

    const gw = this.gw();

    // 1. Pull the transcripts repo and queue new/changed files.
    const repoDir = join(cfg.reposDir, p.project, "transcripts");
    const { head } = await syncRepo(p.transcriptsRepo, repoDir);
    this.logMemberRenames(p, repoDir);

    // Project init: a new bootstrap/*/request.json, or an answer for a run
    // that waits for one, starts a background job; ingest resumes once it settles.
    const initStarted = await this.checkInit(cfg, p, state, repoDir);
    if (initStarted) {
      result.init = initStarted;
      return result;
    }

    if (state.lastSeenCommit !== head) {
      let changed: string[];
      if (state.lastSeenCommit && (await commitExists(repoDir, state.lastSeenCommit))) {
        changed = await changedIngestFiles(repoDir, state.lastSeenCommit, head);
      } else {
        // First run, or the cursor commit is gone: compare blobs instead.
        const all = await listIngestFiles(repoDir, head);
        changed = [];
        for (const f of all) {
          const blob = await blobId(repoDir, f, head);
          if (blob && state.files[f]?.blob !== blob) changed.push(f);
        }
      }
      const queued = new Set(state.queue.map((q) => q.file));
      const added = changed.filter((f) => !queued.has(f));
      for (const f of added) state.queue.push({ file: f, attempts: 0 });
      if (added.length) log("info", "files_queued", { project: p.project, count: added.length, files: added.slice(0, 20), head });
      state.lastSeenCommit = head;
      await saveState(cfg.stateDir, p.project, state);
    }

    const memfs = gw.memfsDir(p.agentId);
    if (!existsSync(join(memfs, ".git"))) {
      throw new Error(`MemFS for ${p.agentId} not found at ${memfs} (wrong LETTA_CONFIG_DIR or agent not created?)`);
    }
    const headAtStart = await gw.memfsHead(p.agentId);
    const today = localDate(now);
    const batch: LogEntry[] = [];
    let session: IngestSession | null = null;
    const cwd = projectCwd(cfg, p.project);
    const sessionOpts = { cwd, stepCount: cfg.settings.stepCount };
    const ctx: ReflectCtx = { cfg, p, state, batch, baseline: state.memoryHeadSeen ?? headAtStart };

    try {
      // 2. Ingest queued files into today's conversation. The worker launches
      //    reflections itself (Letta's step-count trigger is off), one per
      //    `stepCount` ingested sessions, so each carries its instruction.
      if (state.queue.length > 0 && !this.stopping) {
        await mkdir(cwd, { recursive: true });
        session = await this.openDailyConversation(cfg, p, state, today, headAtStart);
        await saveState(cfg.stateDir, p.project, state);
        for (;;) {
          const item = state.queue[0] as QueueItemExt | undefined;
          if (!item || this.stopping) break;
          const outcome = await this.ingestOne(cfg, p, state, repoDir, item, session, batch);
          if (outcome === "ingested") result.ingested += 1;
          await saveState(cfg.stateDir, p.project, state);
          if (outcome === "backoff") {
            result.ok = false;
            result.error = state.backoff.reason;
            break;
          }
          if (outcome === "ingested" && !this.stopping && unreflectedIn(state, session.conversationId) >= cfg.settings.stepCount) {
            result.reflections += await this.reflectAndRecord(ctx, session, "step-count");
            await saveState(cfg.stateDir, p.project, state);
          }
        }
      }

      // 3. Reflection outside the ingest loop: wait for one still running from
      //    an earlier pass, reflect leftovers, and run the daily reflection.
      const conv = state.conversation?.id ?? null;
      if (conv && !this.stopping) {
        const before = await gw.readReflectionState(p.agentId, conv);
        const started = before?.last_reflection_started_at ?? null;
        // A start newer than the last success means one is running, unless it is
        // old enough that it must have failed (then do not wait on it every pass).
        const inFlight =
          !!started &&
          (!before?.last_reflection_succeeded_at || started > before.last_reflection_succeeded_at) &&
          Date.now() - Date.parse(started) < STALE_REFLECTION_MS;
        const hour = cfg.settings.dailyReflectHour;
        const daily = hour !== null && now.getHours() >= hour && state.dailyReflectDate !== today;
        const pendingSteps = unreflectedIn(state, conv);

        if (inFlight) {
          if (cfg.settings.reflectionWaitSeconds > 0) {
            const t0 = Date.now();
            log("info", "reflection_wait", { project: p.project, conversationId: conv, timeoutSeconds: cfg.settings.reflectionWaitSeconds });
            const done = await gw.waitForReflection(
              p.agentId,
              conv,
              state.reflectionSeen[conv] ?? before?.last_reflection_succeeded_at ?? null,
              await gw.memfsHead(p.agentId),
              cfg.settings.reflectionWaitSeconds * 1000,
              2_000,
              () => this.stopping,
            );
            log(done ? "info" : "warn", done ? "reflection_done" : "reflection_wait_timeout", {
              project: p.project,
              conversationId: conv,
              trigger: "in-flight",
              waitedMs: Date.now() - t0,
              commit: done?.commit ?? null,
            });
          }
        } else if (pendingSteps >= cfg.settings.stepCount || (daily && (pendingSteps > 0 || stepsSinceReflection(before) > 0))) {
          session ??= await gw.openSession(p.agentId, conv, sessionOpts);
          result.reflections += await this.reflectAndRecord(ctx, session, pendingSteps >= cfg.settings.stepCount ? "step-count" : "daily");
        } else if (daily && state.pendingReflection.length > 0) {
          session ??= await gw.openSession(p.agentId, conv, sessionOpts);
          result.reflections += await this.retryPending(ctx, session, "daily", []);
        }
        if (daily) state.dailyReflectDate = today;
        await saveState(cfg.stateDir, p.project, state);
      }

      // 4. Record reflections that finished without the worker waiting on them
      //    (a timed-out wait, a rollover reflection, one from an earlier pass).
      result.reflections += await this.collectReflections(ctx);
      // 5. Push MemFS main whenever it moved.
      result.pushed = await this.pushMemoryIfMoved(p, state);
      state.memoryHeadSeen = (await gw.memfsHead(p.agentId)) ?? state.memoryHeadSeen;
    } finally {
      session?.close();
      if (batch.length) state.pendingLog.push(...batch);
      await saveState(cfg.stateDir, p.project, state);
    }

    // 6. Commit ingest/log.jsonl.
    const logError = await this.flushLog(cfg, p, state);
    if (logError) {
      result.ok = false;
      result.error = logError;
    }

    if (result.ok && state.backoff.failures > 0 && result.error === undefined) {
      state.backoff = { failures: 0, until: null };
    }
    state.lastPassAt = new Date().toISOString();
    state.lastError = result.ok ? null : { at: state.lastPassAt, message: (result.error ?? "pass failed").slice(0, 500) };
    await saveState(cfg.stateDir, p.project, state);
    return result;
  }

  /** Commit and push `state.pendingLog` to `ingest/log.jsonl`. Returns the error message, or null. */
  private async flushLog(cfg: WorkerConfig, p: ProjectConfig, state: ProjectState): Promise<string | null> {
    if (!state.pendingLog.length) return null;
    const repoDir = join(cfg.reposDir, p.project, "transcripts");
    try {
      const { branch } = await syncRepo(p.transcriptsRepo, repoDir);
      const n = state.pendingLog.length;
      const ingests = state.pendingLog.filter((e) => e.event === "ingest").length;
      const refl = state.pendingLog.filter((e) => e.event === "reflection").length;
      const sha = await commitAndPushLog(
        repoDir,
        branch,
        state.pendingLog.map((e) => JSON.stringify(e)),
        `ingest: log ${ingests} file(s), ${refl} reflection(s)\n\nWritten by the mem-mem ingest worker.`,
      );
      state.pendingLog = [];
      await saveState(cfg.stateDir, p.project, state);
      log("info", "ingest_log_pushed", { project: p.project, entries: n, commit: sha });
      return null;
    } catch (err) {
      log("error", "ingest_log_push_failed", { project: p.project, error: errorMessage(err), pending: state.pendingLog.length });
      return errorMessage(err);
    }
  }

  /**
   * Resume today's ingest conversation or start a new one. Before replacing
   * an older day's conversation, force a reflection on it if it still has
   * unreflected steps, so nothing is left behind.
   */
  private async openDailyConversation(
    cfg: WorkerConfig,
    p: ProjectConfig,
    state: ProjectState,
    today: string,
    headAtStart: string | null,
  ): Promise<IngestSession> {
    const gw = this.gw();
    const opts = { cwd: projectCwd(cfg, p.project), stepCount: cfg.settings.stepCount };
    const prev = state.conversation;
    if (prev && prev.date === today) {
      const s = await gw.openSession(p.agentId, prev.id, opts);
      if (s.conversationId !== prev.id) {
        log("warn", "conversation_replaced", { project: p.project, previous: prev.id, conversationId: s.conversationId });
        state.conversation = { id: s.conversationId, date: today };
      }
      return s;
    }
    if (prev) {
      const st = await gw.readReflectionState(p.agentId, prev.id);
      if (stepsSinceReflection(st) > 0) {
        const old = await gw.openSession(p.agentId, prev.id, opts);
        try {
          const r = await old.reflect(this.instruction(cfg, p, state.pendingReflection, false));
          log("info", "rollover_reflect", { project: p.project, conversationId: prev.id, outcome: r.outcome, output: r.output.slice(0, 200) });
          if ((r.outcome === "started" || r.outcome === "already_running") && cfg.settings.reflectionWaitSeconds > 0) {
            await gw.waitForReflection(
              p.agentId,
              prev.id,
              st?.last_reflection_succeeded_at ?? null,
              headAtStart,
              cfg.settings.reflectionWaitSeconds * 1000,
              2_000,
              () => this.stopping,
            );
          }
        } catch (err) {
          log("warn", "rollover_reflect_failed", { project: p.project, conversationId: prev.id, error: errorMessage(err) });
        } finally {
          old.close();
        }
      }
    }
    const s = await gw.openSession(p.agentId, null, opts);
    state.conversation = { id: s.conversationId, date: today };
    log("info", "conversation_opened", { project: p.project, conversationId: s.conversationId, date: today, previous: prev?.id ?? null });
    return s;
  }

  private async ingestOne(
    cfg: WorkerConfig,
    p: ProjectConfig,
    state: ProjectState,
    repoDir: string,
    item: QueueItemExt,
    session: IngestSession,
    batch: LogEntry[],
  ): Promise<"ingested" | "skipped" | "failed" | "backoff"> {
    const drop = () => {
      state.queue = state.queue.filter((q) => q !== item);
    };
    const blob = await blobId(repoDir, item.file, "HEAD");
    if (!blob) {
      drop();
      log("info", "file_gone", { project: p.project, file: item.file });
      return "skipped";
    }
    if (state.files[item.file]?.blob === blob) {
      drop();
      return "skipped";
    }

    let texts: string[];
    let records: number | undefined;
    let fromRecord: number | undefined;
    const extra: Record<string, unknown> = {};
    try {
      const content = await readFile(join(repoDir, item.file), "utf8");
      if (item.file.startsWith("trajectories/")) {
        const recs = extractRecords(JSON.parse(content));
        const meta = deriveMeta(p.project, item.file, recs);
        let from = state.files[item.file]?.records ?? 0;
        if (from > recs.length) from = 0; // rewritten shorter: send it all again
        texts = buildIngestTexts(recs, meta, {
          fromRecord: from,
          maxChars: cfg.settings.ingestMaxChars,
          messageMaxChars: cfg.settings.messageMaxChars,
        });
        records = recs.length;
        fromRecord = from;
        Object.assign(extra, { member: meta.member, tool: meta.tool, session: meta.sessionId, records: `${from}-${recs.length}` });
      } else {
        const info = parseInboxPath(item.file);
        texts = buildNoteTexts(content, { project: p.project, member: info?.member ?? "unknown", file: item.file }, {
          maxChars: cfg.settings.ingestMaxChars,
        });
        Object.assign(extra, { member: info?.member ?? "unknown", kind: "note" });
      }
    } catch (err) {
      // Unreadable/malformed input will not get better by retrying.
      drop();
      const entry: LogEntry = { ts: new Date().toISOString(), event: "skip", project: p.project, file: item.file, error: errorMessage(err) };
      batch.push(entry);
      log("warn", "file_invalid", { project: p.project, file: item.file, error: errorMessage(err) });
      return "skipped";
    }

    if (texts.length === 0) {
      state.files[item.file] = { blob, records, ingestedAt: new Date().toISOString() };
      drop();
      return "skipped";
    }

    if (item.partsBlob !== blob) {
      item.partsBlob = blob;
      item.partsDone = 0;
    }
    let usage: Usage = emptyUsage();
    let conversationId = session.conversationId;
    let sentAt = new Date().toISOString();
    const t0 = Date.now();
    try {
      for (let i = item.partsDone ?? 0; i < texts.length; i++) {
        if (this.stopping) return "failed";
        sentAt = new Date().toISOString();
        const r = await session.sendTurn(texts[i]!);
        conversationId = r.conversationId;
        const turnUsage = normalizeUsage(r.usage);
        if (turnUsage) usage = addUsage(usage, turnUsage);
        // Every finished turn counts on the ledger, also when a later part fails.
        recordUsage(state, "ingest", turnUsage, localDate());
        item.partsDone = i + 1;
        log("info", "turn_done", {
          project: p.project,
          file: item.file,
          part: `${i + 1}/${texts.length}`,
          fromRecord,
          chars: texts[i]!.length,
          conversationId,
          durationMs: r.durationMs,
          reply: r.reply.slice(0, 200),
          usage: turnUsage ?? undefined,
        });
      }
    } catch (err) {
      const msg = errorMessage(err);
      if (err instanceof TurnError && err.retryable) {
        state.backoff.failures += 1;
        const wait = backoffMs(state.backoff.failures, Math.max(60_000, cfg.pollSeconds * 1000));
        state.backoff.until = new Date(Date.now() + wait).toISOString();
        state.backoff.reason = `${err.kind}: ${msg}`.slice(0, 500);
        log("error", "turn_failed", { project: p.project, file: item.file, kind: err.kind, error: msg, retryInMs: wait });
        return "backoff";
      }
      item.attempts += 1;
      item.lastError = msg.slice(0, 500);
      log("error", "turn_failed", { project: p.project, file: item.file, kind: "agent", error: msg, attempts: item.attempts });
      if (item.attempts >= cfg.settings.maxAttemptsPerFile) {
        drop();
        batch.push({ ts: new Date().toISOString(), event: "skip", project: p.project, file: item.file, error: `gave up after ${item.attempts} attempts: ${msg}` });
      } else {
        // Move it to the back so one bad file does not block the rest.
        drop();
        state.queue.push(item);
      }
      return "failed";
    }

    const ts = new Date().toISOString();
    state.files[item.file] = { blob, records, ingestedAt: ts };
    drop();
    // stepCount counts distinct files: a re-ingest of a file that is still
    // unreflected in this conversation (a long session synced again by a
    // client checkpoint) moves its sentAt forward instead of adding a step,
    // so a reflection that started before this part was sent does not cover it.
    const u: UnreflectedItem = { file: item.file, conversationId, sentAt };
    for (const k of ["session", "member", "tool"] as const) if (typeof extra[k] === "string") u[k] = extra[k] as string;
    const prev = state.unreflected.find((x) => x.file === item.file && x.conversationId === conversationId);
    if (prev) Object.assign(prev, u);
    else state.unreflected.push(u);
    state.backoff = { failures: 0, until: null };
    batch.push({
      ts,
      event: "ingest",
      project: p.project,
      file: item.file,
      blob,
      conversationId,
      parts: texts.length,
      ...extra,
      durationMs: Date.now() - t0,
      usage,
    });
    return "ingested";
  }

  /** The `reflect` instruction: MemFS root and agent id, plus sessions still to record. */
  private instruction(cfg: WorkerConfig, p: ProjectConfig, pending: PendingReflectionItem[], retry: boolean, retryReason?: string): string {
    const gw = this.gw();
    return buildReflectionInstruction({
      members: readMembers(join(cfg.reposDir, p.project, "transcripts")),
      agentId: p.agentId,
      memfsAgentRoot: gw.memfsAgentRoot(p.agentId),
      language: p.language,
      pending,
      transcriptPath: (conv) => gw.transcriptPath(p.agentId, conv),
      retry,
      retryReason,
    });
  }

  /** Launch `reflect -- <instruction>` on the session's conversation and wait for it to finish. */
  private async launchAndWait(ctx: ReflectCtx, session: IngestSession, instruction: string, trigger: string): Promise<LaunchResult> {
    const { cfg, p } = ctx;
    const gw = this.gw();
    const conv = session.conversationId;
    const before = await gw.readReflectionState(p.agentId, conv);
    const since = before?.last_reflection_succeeded_at ?? null;
    const prevHead = await gw.memfsHead(p.agentId);
    let started: string;
    try {
      const r = await session.reflect(instruction);
      started = r.outcome;
      log(r.outcome === "failed" ? "warn" : "info", "reflection_started", {
        project: p.project,
        conversationId: conv,
        trigger,
        outcome: r.outcome,
        output: r.output.slice(0, 200),
      });
    } catch (err) {
      log("warn", "reflection_started", { project: p.project, conversationId: conv, trigger, outcome: "error", error: errorMessage(err) });
      return { kind: "not_done" };
    }
    if (started === "nothing_to_reflect") return { kind: "nothing" };
    if (started !== "started" && started !== "already_running") return { kind: "not_done" };
    if (cfg.settings.reflectionWaitSeconds <= 0) return { kind: "not_done" };

    const t0 = Date.now();
    log("info", "reflection_wait", { project: p.project, conversationId: conv, trigger, timeoutSeconds: cfg.settings.reflectionWaitSeconds });
    const done = await gw.waitForReflection(p.agentId, conv, since, prevHead, cfg.settings.reflectionWaitSeconds * 1000, 2_000, () => this.stopping);
    if (!done) {
      log("warn", "reflection_wait_timeout", { project: p.project, conversationId: conv, trigger, waitedMs: Date.now() - t0 });
      return { kind: "not_done" };
    }
    const st: ReflectionState = (await gw.readReflectionState(p.agentId, conv)) ?? {};
    const startedAt = st.last_reflection_started_at ?? done.succeededAt;
    const { rep, toolErrors, outcome, usage, model } = await this.classifyFinished(p, done.commit, startedAt, done.succeededAt);
    const report = rep ? reportExcerpt(rep.text) : undefined;
    log("info", "reflection_done", {
      project: p.project,
      conversationId: conv,
      trigger,
      waitedMs: Date.now() - t0,
      commit: done.commit,
      outcome: outcome.outcome,
      outcomeSource: outcome.source,
      reason: outcome.reason,
      toolErrors: toolErrorSummary(toolErrors),
      reflectionAgentId: rep?.reflectionAgentId,
      usage: usage ?? undefined,
      model: model ?? undefined,
      report,
    });
    return {
      kind: "done",
      succeededAt: done.succeededAt,
      startedAt,
      commit: done.commit,
      report,
      reflectionAgentId: rep?.reflectionAgentId,
      outcome,
      toolErrors,
      usage,
      model,
    };
  }

  /**
   * Read the subagent's report and failed tool results for a finished
   * reflection and classify it (see `explainReflectionOutcome`). The full
   * report is classified, not the excerpt: the `RESULT:` line is its last line.
   */
  private async classifyFinished(
    p: ProjectConfig,
    commit: string | null,
    startedAt: string,
    succeededAt: string,
  ): Promise<{
    rep: { reflectionAgentId: string; text: string } | null;
    toolErrors: string[];
    outcome: OutcomeDetail;
    usage: Usage | null;
    model: string | null;
  }> {
    const gw = this.gw();
    const rep = await gw.readReflectionReport(p.agentId, startedAt, succeededAt).catch(() => null);
    const toolErrors = rep ? await gw.readReflectionToolErrors(rep.reflectionAgentId).catch(() => []) : [];
    // Usage records of this run only (the subagent conversation may be reused): see sumReflectionUsage.
    const spent = rep ? await gw.readReflectionUsage(rep.reflectionAgentId, startedAt, succeededAt).catch(() => null) : null;
    const outcome = explainReflectionOutcome({ commit, report: rep?.text ?? null, subagentToolErrors: toolErrors });
    if (outcome.claimedCommit) {
      log("warn", "reflection_result_mismatch", {
        project: p.project,
        reflectionAgentId: rep?.reflectionAgentId,
        hint: "the report says it committed but MemFS main did not move; treated as failed",
      });
    }
    return { rep, toolErrors, outcome, usage: spent?.usage ?? null, model: spent?.model ?? null };
  }

  /**
   * Record a finished reflection: the files of `conv` it covered (ingested
   * before it started), plus `extra` sessions it was asked to record. With a
   * commit, the carry-forward list is recorded under that commit too and
   * cleared. With `nothing_to_save`, the carried sessions its instruction
   * named (`named`) and the listed files are accepted and leave the list.
   * Returns the covered files (without `extra`).
   */
  private recordReflection(
    ctx: ReflectCtx,
    conv: string,
    r: {
      succeededAt: string;
      startedAt: string;
      commit: string | null;
      outcome: ReflectionOutcome;
      toolErrors?: string[];
      usage?: Usage | null;
      model?: string | null;
    },
    opts: { trigger: string; extra?: PendingReflectionItem[]; named?: PendingReflectionItem[]; retry?: boolean },
  ): PendingReflectionItem[] {
    const { p, state, batch } = ctx;
    const covered = state.unreflected.filter((u) => u.conversationId === conv && u.sentAt <= r.startedAt);
    state.unreflected = state.unreflected.filter((u) => !covered.includes(u));
    const coveredItems = covered.map(toPending);
    const listed = uniqueByFile([...coveredItems, ...(opts.extra ?? [])]);
    const listedFiles = new Set(listed.map((i) => i.file));
    const namedFiles = new Set((opts.named ?? []).map((i) => i.file));
    const empty = !r.commit && r.outcome === "nothing_to_save";
    const carried = r.commit
      ? state.pendingReflection.filter((i) => !listedFiles.has(i.file))
      : empty
        ? state.pendingReflection.filter((i) => namedFiles.has(i.file) && !listedFiles.has(i.file))
        : [];
    const mapped = new Set([...listedFiles, ...carried.map((i) => i.file)]);
    for (const e of batch) {
      // Fill in ingest entries of this pass; a retry with a better outcome
      // (a commit, or nothing to save) overrides the first try's.
      if (e.event !== "ingest" || !e.file || !mapped.has(e.file)) continue;
      const prev = (e.reflectionOutcome as ReflectionOutcome | undefined) ?? "unknown";
      if (e.reflectionCommit === undefined || OUTCOME_RANK[r.outcome] > OUTCOME_RANK[prev]) {
        e.reflectionCommit = r.commit;
        e.reflectionOutcome = r.outcome;
      }
    }
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      event: "reflection",
      project: p.project,
      conversationId: conv,
      reflectionCommit: r.commit,
      outcome: r.outcome,
      startedAt: r.startedAt,
      succeededAt: r.succeededAt,
      files: listed.map((i) => i.file),
      trigger: opts.trigger,
    };
    if (r.usage) entry.usage = r.usage;
    if (r.model) entry.model = r.model;
    if (opts.retry) entry.retry = true;
    batch.push(entry);
    if (carried.length) {
      // Sessions an earlier reflection could not save, recorded (or judged empty) by this one.
      // Same run: its usage stays on the first entry only, so a reader summing the log counts it once.
      const { usage: _usage, ...rest } = entry;
      batch.push({ ...rest, ts: new Date().toISOString(), files: carried.map((i) => i.file), carriedForward: true });
    }
    recordUsage(state, "reflection", r.usage ?? null, localDate());
    if (r.commit) {
      if (state.pendingReflection.length) {
        log("info", "reflection_pending_recorded", { project: p.project, commit: r.commit, outcome: r.outcome, sessions: sessionIds(state.pendingReflection) });
      }
      state.pendingReflection = [];
      ctx.baseline = r.commit;
    } else if (empty) {
      const resolved = state.pendingReflection.filter((i) => mapped.has(i.file));
      if (resolved.length) {
        log("info", "reflection_pending_recorded", { project: p.project, commit: null, outcome: r.outcome, sessions: sessionIds(resolved) });
        state.pendingReflection = state.pendingReflection.filter((i) => !mapped.has(i.file));
      }
    }
    if (!state.reflectionSeen[conv] || r.succeededAt > state.reflectionSeen[conv]!) state.reflectionSeen[conv] = r.succeededAt;
    state.lastReflection = { at: r.succeededAt, outcome: r.outcome, commit: r.commit, trigger: opts.trigger, conversationId: conv };
    if (r.usage) state.lastReflection.usage = r.usage;
    if (r.model) state.lastReflection.model = r.model;
    log("info", "reflection_recorded", {
      project: p.project,
      conversationId: conv,
      trigger: opts.trigger,
      commit: r.commit,
      outcome: r.outcome,
      toolErrors: toolErrorSummary(r.toolErrors),
      files: listed.length,
      carriedForward: carried.length || undefined,
      usage: r.usage ?? undefined,
      model: r.model ?? undefined,
    });
    return coveredItems;
  }

  /** A reflection that found nothing worth saving: accepted, no retry, no carry-forward. */
  private logEmpty(ctx: ReflectCtx, conv: string, trigger: string, sessions: PendingReflectionItem[], r: Extract<LaunchResult, { kind: "done" }>): void {
    log("info", "reflection_empty", {
      project: ctx.p.project,
      conversationId: conv,
      trigger,
      outcome: r.outcome.outcome,
      outcomeSource: r.outcome.source,
      sessions: sessionIds(sessions),
      toolErrors: toolErrorSummary(r.toolErrors),
      reflectionAgentId: r.reflectionAgentId,
      report: r.report,
    });
  }

  /** Put sessions on the carry-forward list (bounded; logs what it drops). */
  private addToPending(ctx: ReflectCtx, items: PendingReflectionItem[]): void {
    if (!items.length) return;
    const { pending, dropped } = addPending(ctx.state.pendingReflection, items);
    ctx.state.pendingReflection = pending;
    if (dropped.length) {
      log("warn", "reflection_pending_dropped", {
        project: ctx.p.project,
        sessions: sessionIds(dropped),
        files: dropped.map((d) => d.file),
        hint: "these sessions stay in the ingest conversation history but were never saved to memory",
      });
    }
  }

  /**
   * A scheduled reflection (step-count or daily) with the worker's
   * instruction. A commit or a reflection that found nothing worth saving is
   * accepted. One that failed to save (or whose outcome is unknown) is
   * retried once right away; if the retry fails too, the sessions are carried
   * to the next reflection. Returns the number of reflections recorded.
   */
  private async reflectAndRecord(ctx: ReflectCtx, session: IngestSession, trigger: string): Promise<number> {
    const conv = session.conversationId;
    const included = [...ctx.state.pendingReflection];
    const r = await this.launchAndWait(ctx, session, this.instruction(ctx.cfg, ctx.p, included, false), trigger);
    if (r.kind === "not_done") return 0; // retried on a later pass (the files stay unreflected)
    let covered: PendingReflectionItem[];
    let count = 0;
    let reason: string | undefined;
    if (r.kind === "nothing") {
      // Letta already counts this content as reflected (by a reflection the
      // worker did not see): its outcome is unknown, so retry.
      covered = ctx.state.unreflected.filter((u) => u.conversationId === conv).map(toPending);
      ctx.state.unreflected = ctx.state.unreflected.filter((u) => u.conversationId !== conv);
      reason = "Letta reported no new transcript content";
    } else {
      covered = this.recordReflection(ctx, conv, { ...r, outcome: r.outcome.outcome }, { trigger, named: included });
      count = 1;
      if (r.outcome.outcome === "committed") return count;
      if (r.outcome.outcome === "nothing_to_save") {
        this.logEmpty(ctx, conv, trigger, uniqueByFile([...included, ...covered]), r);
        return count;
      }
      reason = r.outcome.reason;
    }
    const candidates = uniqueByFile([...included, ...covered]);
    if (!candidates.length) return count;
    log("info", "reflection_retry", {
      project: ctx.p.project,
      conversationId: conv,
      trigger,
      outcome: r.kind === "done" ? r.outcome.outcome : "nothing_to_reflect",
      reason,
      sessions: sessionIds(candidates),
      report: r.kind === "done" ? r.report : undefined,
    });
    return count + (await this.retryPending(ctx, session, trigger, candidates, reason));
  }

  /**
   * Retry: send a short marker turn (Letta reflects only new transcript
   * content), then reflect with an instruction that says why the previous
   * reflection is considered failed and lists the sessions and where their
   * full text is. A commit or `nothing_to_save` is accepted; otherwise log
   * `reflection_no_commit` and carry the sessions forward.
   */
  private async retryPending(
    ctx: ReflectCtx,
    session: IngestSession,
    trigger: string,
    extra: PendingReflectionItem[],
    reason?: string,
  ): Promise<number> {
    const { p, state } = ctx;
    const conv = session.conversationId;
    const candidates = uniqueByFile([...state.pendingReflection, ...extra]);
    if (!candidates.length) return 0;
    const retryTrigger = `${trigger}-retry`;
    let r: LaunchResult;
    try {
      const marker = await session.sendTurn(buildRetryTurn(p.project, candidates));
      recordUsage(state, "ingest", normalizeUsage(marker.usage), localDate());
      r = await this.launchAndWait(ctx, session, this.instruction(ctx.cfg, p, candidates, true, reason), retryTrigger);
    } catch (err) {
      log("warn", "reflection_retry_failed", { project: p.project, conversationId: conv, error: errorMessage(err) });
      r = { kind: "not_done" };
    }
    let count = 0;
    if (r.kind === "done") {
      this.recordReflection(ctx, conv, { ...r, outcome: r.outcome.outcome }, { trigger: retryTrigger, extra: candidates, named: candidates, retry: true });
      count = 1;
      if (r.outcome.outcome === "committed") return count;
      if (r.outcome.outcome === "nothing_to_save") {
        this.logEmpty(ctx, conv, retryTrigger, candidates, r);
        return count;
      }
    }
    log("warn", "reflection_no_commit", {
      project: p.project,
      conversationId: conv,
      trigger: retryTrigger,
      outcome: r.kind === "done" ? r.outcome.outcome : r.kind === "nothing" ? "nothing_to_reflect" : "not_finished",
      reason: r.kind === "done" ? r.outcome.reason : undefined,
      sessions: sessionIds(candidates),
      toolErrors: r.kind === "done" ? toolErrorSummary(r.toolErrors) : undefined,
      reflectionAgentId: r.kind === "done" ? r.reflectionAgentId : undefined,
      report: r.kind === "done" ? r.report : undefined,
      hint: "kept in pendingReflection; the next reflection's instruction names these sessions",
    });
    this.addToPending(ctx, candidates);
    return count;
  }

  /**
   * Record reflections that succeeded since last seen but that the worker
   * did not wait on. A commit maps the covered files (and the carry-forward
   * list) to it; no commit puts the covered files on the carry-forward list.
   */
  private async collectReflections(ctx: ReflectCtx): Promise<number> {
    const { p, state } = ctx;
    const gw = this.gw();
    const convs = new Set<string>();
    if (state.conversation) convs.add(state.conversation.id);
    for (const u of state.unreflected) convs.add(u.conversationId);
    let count = 0;
    for (const conv of convs) {
      const st = await gw.readReflectionState(p.agentId, conv);
      const at = st?.last_reflection_succeeded_at;
      if (!at || (state.reflectionSeen[conv] && at <= state.reflectionSeen[conv]!)) continue;
      // A reflection that changed nothing leaves main where it was.
      const head = await gw.memfsHead(p.agentId);
      const commit = head && head !== ctx.baseline ? head : null;
      const startedAt = st?.last_reflection_started_at ?? at;
      const { rep, toolErrors, outcome, usage, model } = await this.classifyFinished(p, commit, startedAt, at);
      const covered = this.recordReflection(
        ctx,
        conv,
        { succeededAt: at, startedAt, commit, outcome: outcome.outcome, toolErrors, usage, model },
        { trigger: "collected" },
      );
      ctx.baseline = head;
      count += 1;
      if (!commit && covered.length) {
        const report = rep ? reportExcerpt(rep.text) : undefined;
        if (outcome.outcome === "nothing_to_save") {
          log("info", "reflection_empty", {
            project: p.project,
            conversationId: conv,
            trigger: "collected",
            outcome: outcome.outcome,
            outcomeSource: outcome.source,
            sessions: sessionIds(covered),
            reflectionAgentId: rep?.reflectionAgentId,
            report,
          });
        } else {
          log("warn", "reflection_no_commit", {
            project: p.project,
            conversationId: conv,
            trigger: "collected",
            outcome: outcome.outcome,
            reason: outcome.reason,
            sessions: sessionIds(covered),
            toolErrors: toolErrorSummary(toolErrors),
            reflectionAgentId: rep?.reflectionAgentId,
            report,
            hint: "kept in pendingReflection; the next reflection's instruction names these sessions",
          });
          this.addToPending(ctx, covered);
        }
      }
    }
    // Forget conversations that have nothing pending (keep the current one).
    for (const conv of Object.keys(state.reflectionSeen)) {
      if (conv !== state.conversation?.id && !state.unreflected.some((u) => u.conversationId === conv)) {
        delete state.reflectionSeen[conv];
      }
    }
    return count;
  }

  private initDeps(cfg: WorkerConfig, p: ProjectConfig, state: ProjectState, repoDir: string, signal: AbortSignal): InitDeps {
    return { cfg, p, state, gw: this.gw(), repoDir, signal, pushMemory: () => this.pushMemoryIfMoved(p, state), version: this.version };
  }

  /** Run `job` in the background as the project's init job; ingest for the project waits until it settles. */
  private launchInit(p: ProjectConfig, job: (signal: AbortSignal) => Promise<InitRun | null>): Promise<InitRun | null> {
    const ctl = new AbortController();
    const promise = (async () => {
      try {
        return await job(ctl.signal);
      } catch (err) {
        log("error", "init_job_crashed", { project: p.project, error: errorMessage(err) });
        return null;
      } finally {
        this.inits.delete(p.project);
        this.wake(); // let the project's ingest resume without waiting a full poll
      }
    })();
    this.inits.set(p.project, { promise, ctl });
    return promise;
  }

  /**
   * After the transcripts repo is synced: fail a run that a previous process
   * left `running`, relay new answers to a run that waits for one, or start a
   * run for new requests. Returns what was started, or null (ingest goes on).
   */
  private async checkInit(cfg: WorkerConfig, p: ProjectConfig, state: ProjectState, repoDir: string, force = false): Promise<string | null> {
    const deps = (signal: AbortSignal) => this.initDeps(cfg, p, state, repoDir, signal);
    if (state.init?.state === "running" || state.init?.state === "queued") {
      // Only this process runs init jobs, and none is running: it was interrupted.
      await failDetached(deps(new AbortController().signal), "interrupted: the worker restarted while the init was running (memmem-server init run to retry)");
    }
    await this.seedInitRecord(cfg, p, state, repoDir);
    let scan: BootstrapScan;
    try {
      scan = await scanBootstrap(repoDir);
    } catch (err) {
      log("warn", "init_scan_failed", { project: p.project, error: errorMessage(err) });
      return null;
    }
    // A fresh state next to an earlier finished init: its requests are not new.
    if (!state.init && !Object.keys(state.initRequests ?? {}).length && scan.requests.length) {
      const status = readStatusFileSync(repoDir);
      const marked = markRequestsFromDoneStatus(state, status, scan, readBootstrapSources(repoDir));
      if (marked.length) {
        await saveState(cfg.stateDir, p.project, state);
        log("info", "init_requests_marked_done", { project: p.project, initId: status?.initId ?? null, requests: marked });
      }
    }
    let pending: BootstrapEntry[] = pendingRequests(state, scan);
    // A state without the map (e.g. a fresh one): the sessions earlier done runs analysed, from the manifests (init-recovery.ts).
    if (state.initProject && !state.initStagedSessions) {
      const seeded = seedInitStagedSessions(state, state.initProject, readBootstrapSources(repoDir), pending.map((r) => r.path));
      if (seeded !== null) {
        await saveState(cfg.stateDir, p.project, state);
        log("info", "init_staged_sessions_seeded", { project: p.project, sessions: seeded });
      }
    }
    if (force && !pending.length && state.init?.state !== "waiting_for_answer") pending = scan.requests;
    if (state.init?.state === "waiting_for_answer") {
      if (pending.length) {
        await failDetached(deps(new AbortController().signal), "superseded by a new init request");
      } else {
        const answers = newAnswers(state.init, scan);
        if (!answers.length) return null;
        void this.launchInit(p, (signal) => continueInitJob(deps(signal), scan, answers));
        return `continued ${state.init.id}`;
      }
    }
    if (!pending.length) return null;
    log("info", "init_requests_found", { project: p.project, requests: pending.map((r) => r.path), forced: force || undefined });
    void this.launchInit(p, (signal) => runInitJob(deps(signal), scan, pending));
    return "started";
  }

  /** One `members_rename_detected` line per pass while two members/*.json share a githubId (members.ts). */
  private logMemberRenames(p: ProjectConfig, repoDir: string): void {
    const { renames } = readMembersDetailed(repoDir);
    if (renames.length) log("info", "members_rename_detected", { project: p.project, renames: renames.map((r) => ({ handle: r.handle, previous: r.previous, githubId: r.githubId })) });
  }

  /**
   * A fresh state (a new install, or a wiped state file) next to a
   * bootstrap/status.json from an earlier run: seed the project init record
   * from it, so depth, who initialized and each member's contribution carry
   * over without a new run.
   */
  private async seedInitRecord(cfg: WorkerConfig, p: ProjectConfig, state: ProjectState, repoDir: string): Promise<void> {
    if (state.initProject) return;
    const status = readStatusFileSync(repoDir);
    if (!status) return;
    initProjectOf(state, status);
    await saveState(cfg.stateDir, p.project, state);
  }

  /**
   * `init run`: sync and start (or continue) an init now. With `force`, the
   * newest requests are run again even if they were already processed.
   * With `wait`, resolves when the job settles.
   */
  async initNow(cfg: WorkerConfig, project: string, opts: { force?: boolean; wait?: boolean } = {}): Promise<InitActionResult> {
    const p = cfg.projects.find((x) => x.project === project);
    if (!p) throw new Error(`unknown project: ${project}`);
    this.ensureGateway(cfg);
    if (this.inits.has(project)) {
      const st = await loadState(cfg.stateDir, project);
      return { project, action: "run", ok: false, initId: st.init?.id, state: st.init?.state, message: "an init is already running for this project" };
    }
    const state = await loadState(cfg.stateDir, project);
    const repoDir = join(cfg.reposDir, p.project, "transcripts");
    await syncRepo(p.transcriptsRepo, repoDir);
    const started = await this.checkInit(cfg, p, state, repoDir, opts.force !== false);
    if (!started) {
      return { project, action: "run", ok: false, initId: state.init?.id, state: state.init?.state, message: state.init?.state === "waiting_for_answer" ? "the init waits for an answer (memmem init --answer)" : "no bootstrap/*/request.json in the transcripts repo" };
    }
    const job = this.inits.get(project);
    if (!opts.wait || !job) return { project, action: "run", ok: true, initId: state.init?.id, state: state.init?.state ?? "running", message: `${started}; progress: memmem-server init status --project ${project}` };
    const run = await job.promise;
    return {
      project,
      action: "run",
      ok: !!run && run.state !== "failed",
      initId: run?.id,
      state: run?.state,
      error: run?.error,
      question: run?.question,
      commits: run?.commits,
      message: started,
    };
  }

  /** `init cancel`: abort the running job, or fail a run that waits for an answer. */
  async cancelInit(cfg: WorkerConfig, project: string): Promise<InitActionResult> {
    const p = cfg.projects.find((x) => x.project === project);
    if (!p) throw new Error(`unknown project: ${project}`);
    this.ensureGateway(cfg);
    const job = this.inits.get(project);
    if (job) {
      job.ctl.abort("cancelled by the operator");
      const run = await Promise.race([job.promise, sleep(60_000).then(() => null)]);
      return { project, action: "cancel", ok: !!run, initId: run?.id, state: run?.state, error: run?.error, message: run ? "cancelled" : "cancel requested; the job has not settled yet" };
    }
    const state = await loadState(cfg.stateDir, project);
    if (!state.init || state.init.state === "done" || state.init.state === "failed") {
      return { project, action: "cancel", ok: false, initId: state.init?.id, state: state.init?.state, message: "no init is running or waiting for an answer" };
    }
    const repoDir = join(cfg.reposDir, p.project, "transcripts");
    const run = await failDetached(this.initDeps(cfg, p, state, repoDir, new AbortController().signal), "cancelled by the operator");
    return { project, action: "cancel", ok: !!run, initId: run?.id, state: run?.state, error: run?.error, message: "cancelled" };
  }

  private async pushMemoryIfMoved(p: ProjectConfig, state: ProjectState): Promise<string | null> {
    const gw = this.gw();
    const head = await gw.memfsHead(p.agentId);
    if (!head || head === state.lastPushedMemoryHead) return null;
    const t0 = Date.now();
    try {
      await gw.pushMemory(p.agentId, p.memoryRepo);
      state.lastPushedMemoryHead = head;
      log("info", "memory_pushed", { project: p.project, commit: head, durationMs: Date.now() - t0 });
      return head;
    } catch (err) {
      log("error", "memory_push_failed", {
        project: p.project,
        commit: head,
        nonFastForward: isNonFastForward(err),
        hint: isNonFastForward(err)
          ? "memory repo has commits MemFS does not (merged PR?); reconcile manually, the worker never force-pushes"
          : undefined,
        error: errorMessage(err),
      });
      return null;
    }
  }
}
