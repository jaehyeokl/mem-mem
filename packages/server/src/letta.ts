// Letta Code App Server client: daily ingest conversation, turns, reflect,
// reflection completion detection, and MemFS push.
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk/client";
import type { LettaCodeSession, SDKMessage, SDKProtocolMessage } from "@letta-ai/letta-agent-sdk/client";
import WebSocket from "ws";
import { headOf, pushMemory as gitPushMemory } from "./git.js";
import { log } from "./log.js";
import { addUsage as addNormalizedUsage, emptyUsage, normalizeUsage, type Usage } from "./usage.js";

export interface LettaPaths {
  /** `~/.letta` or `$LETTA_CONFIG_DIR`. */
  lettaConfigDir: string;
  /** `<lettaConfigDir>/transcripts` or `$LETTA_TRANSCRIPT_ROOT`. */
  transcriptRoot: string;
}

/** `<LETTA_CONFIG_DIR>/lc-local-backend/memfs/<agentId>`: holds `memory/` and the reflection `memory-worktrees/`. */
export function memfsAgentRoot(paths: LettaPaths, agentId: string): string {
  return join(paths.lettaConfigDir, "lc-local-backend", "memfs", agentId);
}

/** The MemFS main checkout (the one the worker pushes). */
export function memfsDir(paths: LettaPaths, agentId: string): string {
  return join(memfsAgentRoot(paths, agentId), "memory");
}

/** Letta's full text record of a conversation (every turn, one JSON object per line). */
export function conversationTranscriptPath(paths: LettaPaths, agentId: string, conversationId: string): string {
  return join(paths.transcriptRoot, agentId, conversationId, "transcript.jsonl");
}

export function reflectionStatePath(paths: LettaPaths, agentId: string, conversationId: string): string {
  return join(paths.transcriptRoot, agentId, conversationId, "state.json");
}

/** Subset of Letta's per-conversation reflection state (`state.json`). */
export interface ReflectionState {
  total_completed_steps?: number;
  reflected_completed_steps?: number;
  steps_since_last_successful_reflection?: number;
  last_reflection_started_at?: string;
  last_reflection_succeeded_at?: string;
}

export async function readReflectionState(paths: LettaPaths, agentId: string, conversationId: string): Promise<ReflectionState | null> {
  try {
    return JSON.parse(await readFile(reflectionStatePath(paths, agentId, conversationId), "utf8")) as ReflectionState;
  } catch {
    return null;
  }
}

export function stepsSinceReflection(s: ReflectionState | null): number {
  if (!s) return 0;
  if (typeof s.steps_since_last_successful_reflection === "number") return s.steps_since_last_successful_reflection;
  return Math.max(0, (s.total_completed_steps ?? 0) - (s.reflected_completed_steps ?? 0));
}

export type TurnErrorKind = "connection" | "provider" | "timeout" | "agent";

export class TurnError extends Error {
  override name = "TurnError";
  constructor(
    message: string,
    readonly kind: TurnErrorKind,
  ) {
    super(message);
  }
  /** Connection/provider/timeout problems are not the input's fault: back off, do not count an attempt. */
  get retryable(): boolean {
    return this.kind !== "agent";
  }
}

const PROVIDER_PATTERN = /quota|rate.?limit|usage.?limit|429|too many requests|insufficient|overloaded|503|502|unavailable|billing|expired|unauthori[sz]ed|401|credential/i;
const CONNECTION_PATTERN = /ECONNREFUSED|ECONNRESET|EPIPE|socket|websocket|stream_closed|not open|closed before|connect/i;

export function classifyError(message: string, errorCode?: string): TurnErrorKind {
  if (errorCode === "llm_api_error" || PROVIDER_PATTERN.test(message)) return "provider";
  if (errorCode === "stream_closed" || CONNECTION_PATTERN.test(message)) return "connection";
  return "agent";
}

/**
 * Letta Code's local backend reads agent records from disk only when the App
 * Server starts, so an agent created afterwards (e.g. by
 * `memmem-server project add --no-reload` in a running container) is "not
 * found" until the App Server restarts.
 */
export function agentNotFoundHint(message: string): string {
  return /\bAgent \S+ not found\b/.test(message)
    ? " (the App Server loads agents only at startup: restart it after creating the agent, e.g. `docker restart <container>`)"
    : "";
}

/**
 * Letta splits `reflect` args like a shell (quotes group, backslash escapes)
 * and joins the words with single spaces. Escape quotes and backslashes so
 * the instruction arrives as written (whitespace collapsed).
 */
export function escapeReflectArgs(instruction: string): string {
  return instruction.replace(/\s+/g, " ").trim().replace(/[\\"']/g, (c) => `\\${c}`);
}

export interface ReflectionReport {
  /** The hidden reflection subagent that wrote the report. */
  reflectionAgentId: string;
  /** Its final assistant message. */
  text: string;
}

/** `lc-local-backend/conversations/<base64url("default:<subagentId>")>`: a subagent's default conversation. */
export function subagentConversationDir(paths: LettaPaths, subagentId: string): string {
  return join(paths.lettaConfigDir, "lc-local-backend", "conversations", Buffer.from(`default:${subagentId}`).toString("base64url"));
}

/** A pi session entry's `message` (only the fields the worker reads). */
interface PiMessage {
  role?: string;
  toolName?: string;
  isError?: boolean;
  content?: unknown;
}

/** The `message` of every parseable line of a `messages.jsonl` (partial lines skipped). */
async function readPiMessages(dir: string): Promise<PiMessage[]> {
  const out: PiMessage[] = [];
  for (const raw of (await readFile(join(dir, "messages.jsonl"), "utf8")).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as { message?: PiMessage };
      if (entry.message && typeof entry.message === "object") out.push(entry.message);
    } catch {
      // skip a partial line
    }
  }
  return out;
}

/** The `text` parts of a message's content, joined. */
function messageText(m: PiMessage): string {
  if (!Array.isArray(m.content)) return typeof m.content === "string" ? m.content : "";
  return m.content
    .filter((c): c is { type: string; text: string } => !!c && typeof c === "object" && (c as { type?: unknown }).type === "text" && typeof (c as { text?: unknown }).text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

/**
 * Best effort: find the final message of the newest reflection subagent of
 * `parentAgentId` created between `sinceIso` (minus 10 s) and `untilIso`, from Letta Code's local
 * backend files (0.34.x layout):
 *
 * - `lc-local-backend/conversations/<base64url("default:<subagentId>")>/conversation.json`
 *   (`agent_id`, `created_at`) and `messages.jsonl` (pi session entries);
 * - `lc-local-backend/agents/<base64url(subagentId)>.json` with tags
 *   `type:reflection` and `parent:<parentAgentId>`.
 *
 * Returns null when nothing matches or the layout is different.
 */
export async function readReflectionReport(
  paths: LettaPaths,
  parentAgentId: string,
  sinceIso: string | null,
  untilIso: string | null = null,
): Promise<ReflectionReport | null> {
  const base = join(paths.lettaConfigDir, "lc-local-backend");
  const convRoot = join(base, "conversations");
  const since = sinceIso ? Date.parse(sinceIso) - 10_000 : 0;
  const until = untilIso ? Date.parse(untilIso) : Infinity;
  let best: { agentId: string; created: number; dir: string } | null = null;
  try {
    for (const name of await readdir(convRoot)) {
      const decoded = Buffer.from(name, "base64url").toString("utf8");
      if (!decoded.startsWith("default:agent-")) continue;
      const dir = join(convRoot, name);
      try {
        if ((await stat(dir)).mtimeMs < since) continue;
        const conv = JSON.parse(await readFile(join(dir, "conversation.json"), "utf8")) as { agent_id?: string; created_at?: string };
        const agentId = conv.agent_id ?? decoded.slice("default:".length);
        const created = Date.parse(conv.created_at ?? "");
        if (!Number.isFinite(created) || created < since || created > until || (best && created <= best.created)) continue;
        const agentFile = join(base, "agents", `${Buffer.from(agentId).toString("base64url")}.json`);
        const agent = JSON.parse(await readFile(agentFile, "utf8")) as { tags?: unknown };
        const tags = Array.isArray(agent.tags) ? agent.tags : [];
        if (!tags.includes("type:reflection") || !tags.includes(`parent:${parentAgentId}`)) continue;
        best = { agentId, created, dir };
      } catch {
        // not a readable subagent conversation
      }
    }
    if (!best) return null;
    const messages = await readPiMessages(best.dir);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      const text = messageText(m);
      if (text) return { reflectionAgentId: best.agentId, text };
    }
    return null;
  } catch {
    return null;
  }
}

/** Failures that mean the subagent's memory edits did not land (on any failed tool result). */
const TOOL_ERROR_PATTERN =
  /memory guard|permission denied|denied|EACCES|EPERM|read-only file system|fatal:|error:|could not|cannot|unable to|not a git repository|worktree|index\.lock|failed/i;
/** Git commit/worktree failures in a Bash result that exited non-zero (Letta marks those `isError: false`). */
const GIT_FAILURE_PATTERN =
  /fatal: |error: |could not (?:lock|write|commit|create)|unable to (?:create|write|lock)|index\.lock|not a git repository|permission denied|read-only file system/i;
const MAX_TOOL_ERRORS = 10;
const TOOL_ERROR_EXCERPT_CHARS = 240;

/**
 * Best effort: failed tool results in a reflection subagent's conversation
 * that mean memory edits did not land, as `<toolName>: <excerpt>` (at most
 * 10, each at most 240 chars). Letta Code 0.34.x stores each tool result as a
 * pi entry `{type:"message", message:{role:"toolResult", toolCallId,
 * toolName, isError, content:[{type:"text", text}], timestamp}}` in
 * `<subagentConversationDir>/messages.jsonl`. Matched:
 *
 * - `isError: true` results whose text names a denial or failure, e.g. an
 *   `Edit` denied with `Permission denied by cross-agent memory guard (...)`
 *   (a missing file on `Read` is not one);
 * - Bash results, which Letta keeps at `isError: false` with text starting
 *   `Exit code: <n>` when the command fails: only a non-zero exit with a
 *   git/permission failure line (`fatal: `, `error: `, `index.lock`, ...)
 *   that is not printed data. Reflection subagents print transcripts, and
 *   those often contain words like "denied" from the sessions.
 *
 * Returns [] when nothing matches or the conversation cannot be read.
 */
export async function readReflectionToolErrors(paths: LettaPaths, reflectionAgentId: string): Promise<string[]> {
  let messages: PiMessage[];
  try {
    messages = await readPiMessages(subagentConversationDir(paths, reflectionAgentId));
  } catch {
    return [];
  }
  const out: string[] = [];
  const clip = (t: string) => (t.length > TOOL_ERROR_EXCERPT_CHARS ? `${t.slice(0, TOOL_ERROR_EXCERPT_CHARS - 3)}...` : t);
  for (const m of messages) {
    if (m.role !== "toolResult") continue;
    const text = messageText(m);
    if (!text) continue;
    const tool = m.toolName ?? "tool";
    let excerpt: string | null = null;
    if (m.isError === true ? TOOL_ERROR_PATTERN.test(text) : /^Permission denied by cross-agent memory guard/i.test(text)) {
      excerpt = `${tool}: ${text.replace(/\s+/g, " ").trim()}`;
    } else {
      const exit = /^Exit code: ([1-9]\d*)/.exec(text);
      if (exit) {
        // Only the command's own messages: skip printed data (JSON lines,
        // pretty-printed JSON, `[user] ...` ingest lines, indented text).
        const line = text
          .split("\n")
          .slice(1, 400)
          .find((l) => !/^[\s{["]/.test(l) && GIT_FAILURE_PATTERN.test(l));
        if (line) excerpt = `${tool}: exit ${exit[1]}: ${line.trim()}`;
      }
    }
    if (!excerpt) continue;
    out.push(clip(excerpt));
    if (out.length >= MAX_TOOL_ERRORS) break;
  }
  return out;
}

/** What a reflection subagent's conversation says it spent. */
export interface ReflectionUsage {
  usage: Usage;
  /** Model handle(s) of the counted messages (`<provider>/<model>`, distinct, comma-joined), or null. */
  model: string | null;
  /** Assistant messages counted. */
  messages: number;
}

/** Slack around the reflection's [started, succeeded] window when matching message timestamps. */
const USAGE_WINDOW_BEFORE_MS = 10_000;
const USAGE_WINDOW_AFTER_MS = 5_000;

function entryTime(entry: Record<string, unknown>, m: Record<string, unknown>): number {
  const iso = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  if (Number.isFinite(iso)) return iso;
  if (typeof m.timestamp === "number" && Number.isFinite(m.timestamp)) return m.timestamp;
  const meta = m.metadata as { created_at?: unknown } | undefined;
  const created = typeof meta?.created_at === "string" ? Date.parse(meta.created_at) : NaN;
  return Number.isFinite(created) ? created : NaN;
}

/**
 * Pure: sum the per-message `usage` records of one reflection run from the
 * lines of a subagent's `messages.jsonl`. Letta Code 0.34.x writes each
 * assistant message as `{type:"message", id, timestamp:<ISO>, message:{role:
 * "assistant", provider, model, usage:{input, output, cacheRead, cacheWrite,
 * reasoning, totalTokens, cost:{..., total}}, timestamp:<ms>}}`.
 *
 * The conversation can outlive one run (the same subagent reflecting again),
 * so only messages written inside the run count: entry timestamp (else the
 * message's own `timestamp` / `metadata.created_at`) within
 * [sinceIso - 10 s, untilIso + 5 s]. With a window, a message without any
 * timestamp is skipped; an open bound (null) does not restrict that side.
 * Lines are deduplicated by entry id. Returns null when nothing counted.
 */
export function sumReflectionUsage(lines: string[], sinceIso: string | null, untilIso: string | null): ReflectionUsage | null {
  const since = sinceIso ? Date.parse(sinceIso) - USAGE_WINDOW_BEFORE_MS : -Infinity;
  const until = untilIso ? Date.parse(untilIso) + USAGE_WINDOW_AFTER_MS : Infinity;
  const windowed = Number.isFinite(since) || Number.isFinite(until);
  const seen = new Set<string>();
  const models: string[] = [];
  let usage: Usage | null = null;
  let messages = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a partial line
    }
    const m = entry.message as Record<string, unknown> | undefined;
    if (!m || typeof m !== "object" || m.role !== "assistant") continue;
    const u = normalizeUsage(m.usage);
    if (!u) continue;
    const t = entryTime(entry, m);
    if (Number.isNaN(t) ? windowed : t < since || t > until) continue;
    const id = typeof entry.id === "string" ? entry.id : typeof m.responseId === "string" ? m.responseId : null;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    usage = addNormalizedUsage(usage ?? emptyUsage(), u);
    messages += 1;
    if (typeof m.model === "string" && m.model) {
      const handle = typeof m.provider === "string" && m.provider ? `${m.provider}/${m.model}` : m.model;
      if (!models.includes(handle)) models.push(handle);
    }
  }
  return usage ? { usage, model: models.length ? models.join(", ") : null, messages } : null;
}

/**
 * Best effort: the token usage of the reflection run that `reflectionAgentId`
 * made between `sinceIso` and `untilIso` (see `sumReflectionUsage`), from
 * `<subagentConversationDir>/messages.jsonl`. Null when unreadable or empty.
 */
export async function readReflectionUsage(
  paths: LettaPaths,
  reflectionAgentId: string,
  sinceIso: string | null,
  untilIso: string | null,
): Promise<ReflectionUsage | null> {
  try {
    const text = await readFile(join(subagentConversationDir(paths, reflectionAgentId), "messages.jsonl"), "utf8");
    return sumReflectionUsage(text.split("\n"), sinceIso, untilIso);
  } catch {
    return null;
  }
}

/** Whitespace-collapsed excerpt: the whole text, or its head and tail (the report's issues come last). */
export function reportExcerpt(text: string, max = 500): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const half = Math.floor((max - 5) / 2);
  return `${flat.slice(0, half)} ... ${flat.slice(flat.length - half)}`;
}

export interface TurnUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  stepCount?: number;
  durationMs?: number;
  [key: string]: number | undefined;
}

export interface TurnResult {
  conversationId: string;
  /** Every assistant text of the turn, joined. */
  reply: string;
  /** The turn's last assistant message (after the last tool call), when known. */
  finalReply?: string;
  durationMs: number;
  usage: TurnUsage;
  /** Tool calls by name (init turns). */
  toolCalls?: Record<string, number>;
  /** Bash commands that mention trajectories / prepare-history / workflows (init observation), truncated. */
  notableCommands?: string[];
  /** Background work started in the turn (Workflow without `wait: true`, Agent/Task subagents). */
  backgroundLaunches?: number;
}

/**
 * After a turn ends with background work still running (a Workflow without
 * `wait: true`, an Agent subagent), Letta's App Server queues the task
 * notification for the conversation and runs it as a new turn once a session
 * is attached to that conversation. Keep the session open and collect those
 * turns until the agent's last message is terminal, or nothing runs anymore.
 */
export interface FollowOptions {
  /** Epoch ms after which following stops. */
  deadline: number;
  /** True when the last assistant message ends the work (e.g. an `INIT: done` line). */
  isTerminal: (text: string) => boolean;
  /** True while background work the agent started is still running (Workflow journals). */
  backgroundActive: () => Promise<boolean>;
  /** Stop after this long with no turn running and no background work. */
  idleMs: number;
  pollMs?: number;
}

/** Wait for listener-run turns (see FollowOptions). Returns how long it followed. */
export async function followBackgroundTurns(acc: StreamAccumulator, opts: FollowOptions, shouldStop: () => boolean = () => false): Promise<number> {
  if (acc.backgroundLaunches === 0 || opts.isTerminal(acc.finalReply)) return 0;
  const t0 = Date.now();
  acc.markFollow();
  log("info", "turn_follow_started", { backgroundLaunches: acc.backgroundLaunches, idleMs: opts.idleMs });
  let idleFrom = Date.now();
  while (Date.now() < opts.deadline && !shouldStop()) {
    await sleep(opts.pollMs ?? 2_000);
    const busy = acc.status !== null && acc.status !== "WAITING_ON_INPUT";
    if (busy || Date.now() - acc.lastAt < 5_000) {
      idleFrom = Date.now();
      continue;
    }
    if (acc.followMessages > 0 && opts.isTerminal(acc.finalReply)) break;
    if (await opts.backgroundActive().catch(() => false)) {
      idleFrom = Date.now();
      continue;
    }
    if (Date.now() - idleFrom > opts.idleMs) break;
  }
  return Date.now() - t0;
}

/** What an App Server command that runs an agent turn (`init`) produced. */
export interface CommandTurnResult extends FollowedTurnResult {
  success: boolean;
  /** The command's own output ("Memory initialization completed"). */
  output: string;
}

/** A turn plus the listener-run turns that followed it. */
export interface FollowedTurnResult extends TurnResult {
  /** How long background turns were followed (0: not needed). */
  followedMs?: number;
}

/** Collects assistant text, usage and tool calls from stream messages. */
export class StreamAccumulator {
  reply = "";
  /** Text of the current assistant message (reset by a new message id or a tool call). */
  private finalText = "";
  private finalKey: string | null = null;
  usage: TurnUsage = {};
  toolCalls: Record<string, number> = {};
  notableCommands: string[] = [];
  lastError: { message: string; errorCode?: string } | null = null;
  messages = 0;
  /** When the last message arrived. */
  lastAt = Date.now();
  /** The last loop status (`WAITING_ON_INPUT` = idle). */
  status: string | null = null;
  /** Background work the agent started: Workflow calls without `wait: true`, Agent/Task subagents. */
  backgroundLaunches = 0;
  /** Assistant messages started after `markFollow()` (turns the listener ran on its own, e.g. a task notification). */
  followMessages = 0;
  private following = false;

  markFollow(): void {
    this.following = true;
  }

  add(m: SDKMessage): void {
    this.messages += 1;
    this.lastAt = Date.now();
    if (m.type === "loop_status") {
      this.status = (m as { status?: string }).status ?? null;
      return;
    }
    if (m.type === "assistant") {
      this.reply += m.content;
      // A new message id (or otid) starts a new message; chunks without one
      // continue the current message (the SDK generates "app-server-<n>" ids for those).
      const key = m.otid ? `otid:${m.otid}` : m.uuid && !/^app-server-\d+$/.test(m.uuid) ? `id:${m.uuid}` : this.finalKey;
      if (key !== this.finalKey || this.finalText === "") {
        if (this.following) this.followMessages += 1;
        this.finalKey = key;
        this.finalText = "";
      }
      this.finalText += m.content;
    } else if (m.type === "tool_call") {
      const name = m.toolName || "tool";
      this.toolCalls[name] = (this.toolCalls[name] ?? 0) + 1;
      this.finalText = "";
      this.finalKey = null;
      const input = (m.toolInput ?? {}) as Record<string, unknown>;
      if ((name === "Workflow" && input.wait !== true) || name === "Agent" || name === "Task") this.backgroundLaunches += 1;
      // Bash (`command`), Codex-style exec_command (`cmd`), Workflow scripts.
      const raw = input.command ?? input.cmd;
      const cmd = typeof raw === "string" ? raw : typeof input.script === "string" ? `${name}: ${input.script}` : null;
      if (cmd && /trajectories|prepare-history|history-coverage|letta-init-history|workflow/i.test(cmd) && this.notableCommands.length < 20) {
        this.notableCommands.push(cmd.replace(/\s+/g, " ").slice(0, 300));
      }
    } else if (m.type === "stream_event") {
      const ev = m.event as Record<string, unknown>;
      if (ev.message_type === "usage_statistics") this.usage = addUsage(this.usage, usageFromEvent(ev));
    } else if (m.type === "error") {
      this.lastError = { message: m.errorDetail ?? m.message, errorCode: m.errorCode };
    } else if (m.type === "retry") {
      log("warn", "turn_retry", { reason: m.reason, attempt: m.attempt, maxAttempts: m.maxAttempts });
    }
  }

  get finalReply(): string {
    return this.finalText.trim() || this.reply.trim();
  }
}

export type ReflectOutcome = "started" | "already_running" | "nothing_to_reflect" | "failed";

export interface ReflectResult {
  outcome: ReflectOutcome;
  output: string;
}

export function classifyReflectOutput(success: boolean, output: string): ReflectOutcome {
  if (/already running/i.test(output)) return "already_running";
  if (/no new transcript content/i.test(output)) return "nothing_to_reflect";
  if (success && /started a reflection/i.test(output)) return "started";
  if (success && !/fail|error|needs the memory filesystem/i.test(output)) return "started";
  return "failed";
}

function usageFromEvent(event: Record<string, unknown>): TurnUsage {
  const out: TurnUsage = {};
  const pick = (k: string, as: string) => {
    const v = event[k];
    if (typeof v === "number" && Number.isFinite(v)) out[as] = v;
  };
  pick("prompt_tokens", "promptTokens");
  pick("completion_tokens", "completionTokens");
  pick("total_tokens", "totalTokens");
  pick("step_count", "stepCount");
  pick("cached_input_tokens", "cachedInputTokens");
  pick("cache_write_tokens", "cacheWriteTokens");
  pick("reasoning_tokens", "reasoningTokens");
  return out;
}

function addUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
  const out: TurnUsage = { ...a };
  for (const [k, v] of Object.entries(b)) if (typeof v === "number") out[k] = (out[k] ?? 0) + v;
  return out;
}

export interface SessionOptions {
  cwd: string;
  stepCount: number;
  /** App Server permission mode (init sessions run `unrestricted`: no one is there to approve tools). */
  permissionMode?: "standard" | "acceptEdits" | "unrestricted" | "strict";
}

/** One open App Server session on a project's ingest conversation. */
export class IngestSession {
  constructor(
    private readonly session: LettaCodeSession,
    readonly agentId: string,
    readonly conversationId: string,
  ) {}

  /** Send one user turn and consume the stream until its result. */
  async sendTurn(text: string, timeoutMs = 15 * 60_000, follow?: Omit<FollowOptions, "deadline">): Promise<FollowedTurnResult> {
    const t0 = Date.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void this.session.abort().catch(() => undefined);
    }, timeoutMs);
    timer.unref();
    const acc = new StreamAccumulator();
    try {
      try {
        await this.session.send(text);
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        throw new TurnError(`send failed: ${msg}`, classifyError(msg) === "agent" ? "connection" : classifyError(msg));
      }
      for await (const m of this.session.stream() as AsyncGenerator<SDKMessage>) {
        if (m.type === "result") {
          if (timedOut) throw new TurnError(`turn timed out after ${timeoutMs} ms`, "timeout");
          if (!m.success) {
            const msg = acc.lastError?.message ?? m.errorDetail ?? m.error ?? m.stopReason ?? "turn failed";
            throw new TurnError(msg, classifyError(msg, m.errorCode ?? acc.lastError?.errorCode));
          }
          let usage = acc.usage;
          const extra = (m as unknown as { usage?: Record<string, unknown> }).usage;
          if (extra && typeof extra === "object" && Object.keys(usage).length === 0) usage = usageFromEvent(extra);
          usage.durationMs = m.durationMs;
          const finalReply = (typeof m.result === "string" && m.result.trim()) || acc.finalReply;
          let followedMs = 0;
          if (follow && acc.backgroundLaunches > 0 && !follow.isTerminal(finalReply)) {
            // Turns the listener runs on its own (task notifications) arrive untracked.
            clearTimeout(timer);
            void (async () => {
              try {
                for await (const x of this.session.stream() as AsyncGenerator<SDKMessage>) acc.add(x);
              } catch {
                // the session closed
              }
            })();
            followedMs = await followBackgroundTurns(acc, { ...follow, deadline: t0 + timeoutMs });
            usage = { ...acc.usage, durationMs: Date.now() - t0 };
          }
          return {
            conversationId: m.conversationId ?? this.conversationId,
            reply: acc.reply.trim(),
            finalReply: acc.followMessages > 0 ? acc.finalReply : finalReply,
            durationMs: followedMs ? Date.now() - t0 : m.durationMs,
            usage,
            toolCalls: acc.toolCalls,
            notableCommands: acc.notableCommands,
            backgroundLaunches: acc.backgroundLaunches,
            followedMs,
          };
        }
        acc.add(m);
      }
      if (timedOut) throw new TurnError(`turn timed out after ${timeoutMs} ms`, "timeout");
      throw new TurnError("stream ended without a result", "connection");
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Run an App Server command that starts an agent turn on this conversation
   * (`init`: Letta builds its /init message and runs it, and answers the
   * command only after the turn ends). The turn's stream messages arrive
   * without a tracked turn, so they are collected in the background while the
   * command is pending. Close this session afterwards and open a new one for
   * further turns: the background reader stays parked on the stream.
   */
  async runCommandTurn(commandId: string, timeoutMs: number, args?: string, follow?: Omit<FollowOptions, "deadline">): Promise<CommandTurnResult> {
    const acc = new StreamAccumulator();
    let stop = false;
    let lastAt = Date.now();
    const reader = (async () => {
      try {
        for await (const m of this.session.stream() as AsyncGenerator<SDKMessage>) {
          acc.add(m);
          lastAt = Date.now();
          if (stop) break;
        }
      } catch {
        // the session closed
      }
    })();
    void reader;
    const t0 = Date.now();
    const command = {
      type: "execute_command",
      command_id: commandId,
      request_id: `memmem-${commandId}-${randomUUID()}`,
      runtime: { agent_id: this.agentId, conversation_id: this.conversationId },
      ...(args?.trim() ? { args } : {}),
    };
    let resp: SDKProtocolMessage;
    try {
      resp = await this.session.sendCommand<SDKProtocolMessage>(command, { responseType: "execute_command_response", timeoutMs });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (/timed out/i.test(msg)) {
        await this.session.abort().catch(() => undefined);
        throw new TurnError(`${commandId} timed out after ${Math.round(timeoutMs / 1000)} s`, "timeout");
      }
      throw new TurnError(`${commandId} failed: ${msg}`, classifyError(msg) === "agent" ? "connection" : classifyError(msg));
    }
    // Stream messages sent before the response may still be queued: drain until quiet.
    const drainEnd = Date.now() + 5_000;
    while (Date.now() < drainEnd && Date.now() - lastAt < 1_000) await sleep(200);
    const followedMs = follow ? await followBackgroundTurns(acc, { ...follow, deadline: t0 + timeoutMs }) : 0;
    stop = true;
    const success = resp.success === true;
    const output = typeof resp.output === "string" ? resp.output : typeof resp.error === "string" ? resp.error : JSON.stringify(resp);
    const durationMs = Date.now() - t0;
    return {
      success,
      output,
      followedMs,
      conversationId: this.conversationId,
      reply: acc.reply.trim(),
      finalReply: acc.finalReply,
      durationMs,
      usage: { ...acc.usage, durationMs },
      toolCalls: acc.toolCalls,
      notableCommands: acc.notableCommands,
      backgroundLaunches: acc.backgroundLaunches,
    };
  }

  /** Abort the turn in flight (best effort). */
  async abort(): Promise<void> {
    await this.session.abort().catch(() => undefined);
  }

  /** Force a reflection pass over this conversation (App Server: current conversation only). */
  async reflect(instruction?: string, timeoutMs = 120_000): Promise<ReflectResult> {
    const command = {
      type: "execute_command",
      command_id: "reflect",
      request_id: `memmem-reflect-${randomUUID()}`,
      runtime: { agent_id: this.agentId, conversation_id: this.conversationId },
      ...(instruction?.trim() ? { args: `-- ${escapeReflectArgs(instruction)}` } : {}),
    };
    const resp = await this.session.sendCommand<SDKProtocolMessage>(command, {
      responseType: "execute_command_response",
      timeoutMs,
    });
    const success = resp.success === true;
    const output = typeof resp.output === "string" ? resp.output : typeof resp.error === "string" ? resp.error : JSON.stringify(resp);
    return { outcome: classifyReflectOutput(success, output), output };
  }

  close(): void {
    try {
      this.session.close();
    } catch {
      // already closed
    }
  }
}

export class LettaGateway {
  private client: LettaAgentClient | null = null;

  constructor(
    readonly url: string,
    readonly paths: LettaPaths,
  ) {}

  private getClient(): LettaAgentClient {
    if (!this.client) {
      this.client = new LettaAgentClient({
        backend: "remote",
        url: this.url,
        WebSocket: WebSocket as unknown as NonNullable<ConstructorParameters<typeof LettaAgentClient>[0]["WebSocket"]>,
        requestTimeoutMs: 120_000,
      });
    }
    return this.client;
  }

  /**
   * Open the ingest conversation: resume `conversationId` when given, else
   * create a new conversation on the agent. Falls back to a new conversation
   * if the resume fails (e.g. Letta state was reset).
   */
  async openSession(agentId: string, conversationId: string | null, opts: SessionOptions): Promise<IngestSession> {
    // The worker launches every reflection itself (`reflect -- <instruction>`),
    // so Letta's own step-count trigger stays off: an automatic reflection
    // would run without the worker's instruction.
    const sessionOpts = {
      cwd: opts.cwd,
      dreaming: { trigger: "off" as const, stepCount: opts.stepCount },
      ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
    };
    if (conversationId) {
      const session = this.getClient().resumeSession(conversationId, sessionOpts);
      try {
        const info = await session.ready();
        if (info.agentId && info.agentId !== agentId) {
          session.close();
          throw new Error(`conversation ${conversationId} belongs to ${info.agentId}, not ${agentId}`);
        }
        return new IngestSession(session, agentId, info.conversationId || conversationId);
      } catch (err) {
        try {
          session.close();
        } catch {
          // ignore
        }
        const msg = (err as Error).message ?? String(err);
        if (classifyError(msg) === "connection") throw new TurnError(`cannot reach App Server: ${msg}`, "connection");
        log("warn", "conversation_resume_failed", { agentId, conversationId, error: msg });
      }
    }
    const session = this.getClient().createSession(agentId, sessionOpts);
    try {
      const info = await session.ready();
      return new IngestSession(session, agentId, info.conversationId);
    } catch (err) {
      try {
        session.close();
      } catch {
        // ignore
      }
      const msg = (err as Error).message ?? String(err);
      throw new TurnError(
        `cannot open session for ${agentId}: ${msg}${agentNotFoundHint(msg)}`,
        classifyError(msg) === "agent" ? "connection" : classifyError(msg),
      );
    }
  }

  readReflectionState(agentId: string, conversationId: string): Promise<ReflectionState | null> {
    return readReflectionState(this.paths, agentId, conversationId);
  }

  memfsDir(agentId: string): string {
    return memfsDir(this.paths, agentId);
  }

  memfsAgentRoot(agentId: string): string {
    return memfsAgentRoot(this.paths, agentId);
  }

  transcriptPath(agentId: string, conversationId: string): string {
    return conversationTranscriptPath(this.paths, agentId, conversationId);
  }

  readReflectionReport(agentId: string, sinceIso: string | null, untilIso: string | null = null): Promise<ReflectionReport | null> {
    return readReflectionReport(this.paths, agentId, sinceIso, untilIso);
  }

  readReflectionToolErrors(reflectionAgentId: string): Promise<string[]> {
    return readReflectionToolErrors(this.paths, reflectionAgentId);
  }

  readReflectionUsage(reflectionAgentId: string, sinceIso: string | null, untilIso: string | null): Promise<ReflectionUsage | null> {
    return readReflectionUsage(this.paths, reflectionAgentId, sinceIso, untilIso);
  }

  memfsHead(agentId: string): Promise<string | null> {
    return headOf(this.memfsDir(agentId), "refs/heads/main");
  }

  /**
   * Wait until the conversation's `last_reflection_succeeded_at` moves past
   * `sinceIso`, then give MemFS `main` a short grace period to move past
   * `prevHead`. Returns null on timeout. `commit` is null when the reflection
   * succeeded without changing memory.
   */
  async waitForReflection(
    agentId: string,
    conversationId: string,
    sinceIso: string | null,
    prevHead: string | null,
    timeoutMs: number,
    pollMs = 2_000,
    shouldStop: () => boolean = () => false,
  ): Promise<{ succeededAt: string; commit: string | null } | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !shouldStop()) {
      const st = await this.readReflectionState(agentId, conversationId);
      const at = st?.last_reflection_succeeded_at ?? null;
      if (at && (!sinceIso || at > sinceIso)) {
        const graceEnd = Math.min(deadline, Date.now() + 5_000);
        let head = await this.memfsHead(agentId);
        while (head === prevHead && Date.now() < graceEnd) {
          await sleep(1_000);
          head = await this.memfsHead(agentId);
        }
        return { succeededAt: at, commit: head && head !== prevHead ? head : null };
      }
      await sleep(pollMs);
    }
    return null;
  }

  pushMemory(agentId: string, memoryRepo: string): Promise<string> {
    return gitPushMemory(this.memfsDir(agentId), memoryRepo);
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) await c.close().catch(() => undefined);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep) => {
    if (signal?.aborted) return resolveSleep();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolveSleep();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
