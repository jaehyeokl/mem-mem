// Per-project worker state, stored as JSON under $MEMMEM_STATE_DIR.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Usage, UsageLedger } from "./usage.js";

export interface QueueItem {
  file: string;
  attempts: number;
  lastError?: string;
}

export interface FileProgress {
  /** Blob id of the version that was ingested. */
  blob: string;
  /** Number of trajectory records already sent (trajectories only). */
  records?: number;
  ingestedAt: string;
}

export interface UnreflectedItem {
  file: string;
  conversationId: string;
  /**
   * When the file's last turn was sent. A reflection that started after this
   * covers the turn: step-count reflection launches as soon as the step
   * completes, often before the SDK reports the turn result.
   */
  sentAt: string;
  /** Trajectory metadata, used to name the session in reflection instructions. */
  session?: string;
  member?: string;
  tool?: string;
}

/** A session a reflection covered without saving anything (carried to the next reflection). */
export interface PendingReflectionItem {
  file: string;
  conversationId: string;
  session?: string;
  member?: string;
  tool?: string;
  /** Reflections that included this session and saved nothing. */
  misses?: number;
}

/** An init request file the worker has handled (keyed by its path in the transcripts repo). */
export interface InitRequestMark {
  /** Blob of the request.json that was handled; a new blob is a new request. */
  blob: string;
  processedAt: string;
  /** done / failed / cancelled. */
  outcome: string;
  initId?: string;
}

export type InitState = "queued" | "running" | "waiting_for_answer" | "done" | "failed";

/** One member's init contribution (bootstrap/status.json `members[handle]`). */
export interface InitMemberStatus {
  kind: "project_init" | "contribute" | "deepen";
  /** Sessions of this member laid out for the run. */
  sessions: number;
  finishedAt: string | null;
  initId: string;
  state: "done" | "failed" | "running" | "waiting_for_answer";
  /** The name the sessions were uploaded under when it is an alias of the handle (members/<handle>.json `aliases`). */
  uploadedAs?: string;
  /** A later run for this member failed; the entry still describes the earlier successful one. */
  lastFailure?: { initId: string; kind: string; finishedAt: string | null; error?: string };
}

/** What the project's init history established (persists across runs). */
export interface InitProjectRecord {
  /** Depth of the last completed project_init / deepen (null: none recorded). */
  depth: "standard" | "deep" | null;
  initializedAt: string | null;
  initializedBy: string[];
  /** Related repositories named by any request (accumulated). */
  repos: string[];
  members: Record<string, InitMemberStatus>;
}

/** The project's current (or last) init run. */
export interface InitRun {
  /** `init-<timestamp>`. */
  id: string;
  state: InitState;
  /** The request files this run handles (path, blob, member, requestedAt). */
  requests: { path: string; blob: string; member: string; requestedAt?: string }[];
  requestedBy: string[];
  /** Letta conversation of this init (a new one, never the daily ingest conversation). */
  conversationId: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  /** MemFS main when the run started (commits after it are the init's). */
  baselineHead: string | null;
  /** Answer files already seen (present at start or consumed), path -> blob. */
  answersSeen: Record<string, string>;
  /** Answer turns sent. */
  answers: number;
  question?: string;
  error?: string;
  commits?: { sha: string; subject: string }[];
  /** Normalized usage of the run's turns (older state: the SDK's raw counters; read through normalizeUsage). */
  usage: Usage | Record<string, number | undefined>;
  /** The run's usage was added to the daily ledger (`finish`). */
  usageRecorded?: boolean;
  /** Sessions laid out for Letta, and the rough token estimate logged before starting. */
  sessions: number;
  estimatedTokens: number;
  durationMs?: number;
  /** How the requests were classified (absent on runs recorded before classification existed). */
  kind?: "project_init" | "contribute" | "deepen";
  depthBefore?: "standard" | "deep" | null;
  depthAfter?: "standard" | "deep" | null;
  reinit?: boolean;
  /** Sessions left out because a reflection already handled them. */
  alreadyReflected?: number;
  /** Sessions left out because an earlier init run already analysed them (contribute only). */
  alreadyStaged?: number;
  /** Sessions the run laid out (session id -> member handle); recorded into `initStagedSessions` when the run finishes `done`. */
  stagedSessions?: Record<string, string>;
  /** Related repositories the run's requests named (accumulated into the project record on done). */
  repos?: string[];
  /** Which sessions the run lays out: the members' (null: everyone's), and whether reflected ones are left out. */
  historyScope?: { members: string[] | null; excludeReflected: boolean; excludeStaged?: boolean };
  /** Members entries before this run touched them (restored on failure). */
  prevMembers?: Record<string, InitMemberStatus | null>;
}

export interface LogEntry {
  ts: string;
  event: "ingest" | "reflection" | "skip" | "init";
  project: string;
  file?: string;
  files?: string[];
  conversationId?: string;
  /** Normalized usage (usage.ts); older entries carry the SDK's raw counters. */
  usage?: Usage;
  reflectionCommit?: string | null;
  /** `reflection` entries: committed / nothing_to_save / failed / unknown. */
  outcome?: string;
  /** `ingest` entries: the outcome of the reflection that covered the file (with `reflectionCommit`). */
  reflectionOutcome?: string;
  [key: string]: unknown;
}

export interface ProjectState {
  version: 1;
  /** Transcripts repo commit up to which changes have been queued. */
  lastSeenCommit: string | null;
  queue: QueueItem[];
  files: Record<string, FileProgress>;
  /** The daily ingest conversation. */
  conversation: { id: string; date: string } | null;
  /** Last `last_reflection_succeeded_at` seen per conversation. */
  reflectionSeen: Record<string, string>;
  lastPushedMemoryHead: string | null;
  /** MemFS main as seen at the end of the previous pass (baseline for attributing reflection commits). */
  memoryHeadSeen: string | null;
  /** Local date (YYYY-MM-DD) on which the daily reflection was handled. */
  dailyReflectDate: string | null;
  unreflected: UnreflectedItem[];
  /** Sessions whose reflection failed to save (or had an unknown outcome), even after one retry; named in the next reflection's instruction. */
  pendingReflection: PendingReflectionItem[];
  /** Log lines not yet committed to the transcripts repo. */
  pendingLog: LogEntry[];
  backoff: { failures: number; until: string | null; reason?: string };
  /** When the last pass over this project finished (for `memmem-server status`). */
  lastPassAt?: string | null;
  /** The last project-level error, if the last pass failed. */
  lastError?: { at: string; message: string } | null;
  /** The last recorded reflection (for `memmem-server status`). */
  lastReflection?: {
    at: string;
    outcome: string;
    commit: string | null;
    trigger: string;
    conversationId: string;
    /** Summed from the subagent conversation's usage records (absent when none were found). */
    usage?: Usage;
    /** Reflection subagent model handle, when the records name it. */
    model?: string;
  } | null;
  /** Daily token usage per kind (usage.ts; at most USAGE_DAYS days). */
  usage?: UsageLedger;
  /** Project init: the current or last run. */
  init?: InitRun | null;
  /** Project init: request files already handled (path -> mark). */
  initRequests?: Record<string, InitRequestMark>;
  /** Project init: depth, who initialized it, and each member's contribution. */
  initProject?: InitProjectRecord | null;
  /**
   * Project init: sessions an init run that finished `done` laid out (session
   * id -> the run and the member). A `contribute` leaves them out. Absent
   * until the first done run, or until seeded from the manifests for a fresh
   * state (init-recovery.ts seedInitStagedSessions).
   */
  initStagedSessions?: Record<string, InitStagedSession>;
}

export interface InitStagedSession {
  initId: string;
  member: string;
}

export function emptyState(): ProjectState {
  return {
    version: 1,
    lastSeenCommit: null,
    queue: [],
    files: {},
    conversation: null,
    reflectionSeen: {},
    lastPushedMemoryHead: null,
    memoryHeadSeen: null,
    dailyReflectDate: null,
    unreflected: [],
    pendingReflection: [],
    pendingLog: [],
    backoff: { failures: 0, until: null },
    lastPassAt: null,
    lastError: null,
    lastReflection: null,
    init: null,
    initRequests: {},
    initProject: null,
  };
}

export function statePath(stateDir: string, project: string): string {
  return join(stateDir, `${project}.json`);
}

export async function loadState(stateDir: string, project: string): Promise<ProjectState> {
  try {
    const raw = JSON.parse(await readFile(statePath(stateDir, project), "utf8")) as Partial<ProjectState>;
    return { ...emptyState(), ...raw, version: 1 };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw err;
  }
}

/** Atomic write (tmp + rename). */
export async function saveState(stateDir: string, project: string, state: ProjectState): Promise<void> {
  const path = statePath(stateDir, project);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

/** Exponential backoff: 1, 2, 4 ... minutes, capped at one hour. */
export function backoffMs(failures: number, baseMs = 60_000, maxMs = 3_600_000): number {
  if (failures <= 0) return 0;
  return Math.min(maxMs, baseMs * 2 ** Math.min(failures - 1, 20));
}

/** Local calendar date and hour in the process time zone (set TZ). */
export function localDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
