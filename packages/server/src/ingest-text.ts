// Pure conversion: normalized trajectory (@letta-ai/trajectory v1) or inbox
// note -> the text of one or more App Server ingest turns.

export interface ToolCall {
  id?: string;
  name?: string;
  args?: unknown;
}

export interface TrajectoryRecord {
  role: string;
  content?: unknown;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface IngestMeta {
  project: string;
  member: string;
  tool: string;
  sessionId: string;
  startedAt: string;
}

export interface TextLimits {
  /** Whole-turn cap (header + body + closing tag). */
  maxChars: number;
  /** Cap per [user]/[assistant] message. */
  messageMaxChars: number;
  toolArgsMaxChars?: number;
  toolResultMaxChars?: number;
}

export const DEFAULT_LIMITS: TextLimits = {
  maxChars: 40_000,
  messageMaxChars: 1_500,
  toolArgsMaxChars: 300,
  toolResultMaxChars: 400,
};

export interface TrajectoryPathInfo {
  month: string;
  member: string;
  tool: string;
  startedAt: string;
  sessionId: string;
}

/** `trajectories/<YYYY-MM>/<member>/<tool>/<startedAt>_<sessionId>.json` */
export function parseTrajectoryPath(path: string): TrajectoryPathInfo | null {
  const m = path.match(/^trajectories\/(\d{4}-\d{2})\/([^/]+)\/([^/]+)\/([^/]+)\.json$/);
  if (!m) return null;
  const [, month, member, tool, stem] = m as unknown as [string, string, string, string, string];
  const sep = stem.indexOf("_");
  if (sep <= 0 || sep === stem.length - 1) return null;
  return { month, member, tool, startedAt: stem.slice(0, sep), sessionId: stem.slice(sep + 1) };
}

export interface InboxPathInfo {
  member: string;
  name: string;
}

/** `inbox/<member>/<YYYY-MM-DD>-<slug>.md` (any .md name under the member dir is accepted). */
export function parseInboxPath(path: string): InboxPathInfo | null {
  const m = path.match(/^inbox\/([^/]+)\/(.+\.md)$/);
  if (!m) return null;
  return { member: m[1]!, name: m[2]! };
}

export class TrajectoryFormatError extends Error {
  override name = "TrajectoryFormatError";
}

/** Accepts `{ records: [...] }` or a bare array. */
export function extractRecords(json: unknown): TrajectoryRecord[] {
  const list = Array.isArray(json)
    ? json
    : json && typeof json === "object" && Array.isArray((json as { records?: unknown }).records)
      ? (json as { records: unknown[] }).records
      : null;
  if (!list) throw new TrajectoryFormatError("expected a trajectory array or an object with a records array");
  return list.filter((r): r is TrajectoryRecord => !!r && typeof r === "object" && typeof (r as { role?: unknown }).role === "string");
}

/**
 * Metadata for the header: path first (it is what the client hook wrote),
 * then the trajectory's `meta` record, then generic fallbacks.
 */
export function deriveMeta(project: string, path: string, records: TrajectoryRecord[]): IngestMeta {
  const fromPath = parseTrajectoryPath(path);
  const meta = records.find((r) => r.role === "meta") ?? ({} as TrajectoryRecord);
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
  const firstTs = records.map((r) => str(r.timestamp)).find((t) => t !== undefined);
  const stem = path.split("/").pop()?.replace(/\.json$/, "") ?? "unknown";
  return {
    project,
    member: fromPath?.member ?? str(meta.member) ?? str(meta.user) ?? "unknown",
    tool: fromPath?.tool ?? str(meta.source) ?? str(meta.tool) ?? "unknown",
    sessionId: fromPath?.sessionId ?? str(meta.session_id) ?? str(meta.sessionId) ?? stem,
    startedAt: fromPath?.startedAt ?? str(meta.started_at) ?? str(meta.startedAt) ?? firstTs ?? "unknown",
  };
}

export function contentText(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") return p.text;
          if (typeof p.content === "string") return p.content;
          if (p.type === "image" || p.type === "image_url") return "[image]";
        }
        return JSON.stringify(part);
      })
      .filter((s) => s.length > 0)
      .join("\n");
  }
  if (typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
  }
  return JSON.stringify(content);
}

/** Truncate to `max` chars (inclusive of the marker). */
export function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = ` …[+${text.length - max} chars]`;
  if (max <= marker.length) return text.slice(0, max);
  return text.slice(0, max - marker.length) + marker;
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const tidy = (s: string): string => s.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/** Render records as `[user]`/`[assistant]`/`[tool_call]`/`[tool_result]` lines. */
export function renderRecords(records: TrajectoryRecord[], limits: TextLimits = DEFAULT_LIMITS): string[] {
  const argsMax = limits.toolArgsMaxChars ?? 300;
  const resultMax = limits.toolResultMaxChars ?? 400;
  const lines: string[] = [];
  for (const r of records) {
    switch (r.role) {
      case "user":
      case "assistant": {
        const text = tidy(contentText(r.content));
        if (text) lines.push(`[${r.role}] ${cap(text, limits.messageMaxChars)}`);
        if (r.role === "assistant" && Array.isArray(r.tool_calls)) {
          for (const call of r.tool_calls) {
            const name = typeof call?.name === "string" && call.name ? call.name : "unknown";
            const args = typeof call?.args === "string" ? call.args : call?.args === undefined ? "" : JSON.stringify(call.args);
            lines.push(`[tool_call] ${name} ${cap(oneLine(args), argsMax)}`.trimEnd());
          }
        }
        break;
      }
      case "tool": {
        lines.push(`[tool_result] ${cap(oneLine(contentText(r.content)), resultMax)}`.trimEnd());
        break;
      }
      default:
        // meta, reasoning, system and unknown roles are not sent.
        break;
    }
  }
  return lines;
}


function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\s+/g, " ");
}

export function ingestInstruction(meta: IngestMeta): string {
  return `Below is the normalized transcript of a work session that team member ${meta.member} ran with ${meta.tool}. You are this project's team memory manager. Reply with one sentence only, and leave memory updates to the background reflection.`;
}

export function noteInstruction(member: string): string {
  return `Below is a note that team member ${member} explicitly asked to keep in team memory. You are this project's team memory manager. Reply with one sentence only, and leave memory updates to the background reflection.`;
}

/**
 * Greedily pack `lines` into chunks whose joined length (with "\n") fits
 * `budget`. A single line longer than the budget is cut.
 */
export function packLines(lines: string[], budget: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const raw of lines) {
    const line = raw.length > budget ? cap(raw, budget) : raw;
    const add = (current.length ? 1 : 0) + line.length;
    if (current.length && size + add > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    size += (current.length ? 1 : 0) + line.length;
    current.push(line);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function wrap(tag: string, attrs: Array<[string, string]>, instruction: string, chunks: string[][]): string[] {
  const n = chunks.length;
  return chunks.map((chunk, i) => {
    const all = n > 1 ? [...attrs, ["part", `${i + 1}/${n}`] as [string, string]] : attrs;
    const open = `<${tag} ${all.map(([k, v]) => `${k}="${attr(v)}"`).join(" ")}>`;
    return [open, instruction, ...chunk, `</${tag}>`].join("\n");
  });
}

/** Size of everything except the body lines for the worst-case part header. */
function overhead(tag: string, attrs: Array<[string, string]>, instruction: string): number {
  const open = `<${tag} ${[...attrs, ["part", "9999/9999"] as [string, string]].map(([k, v]) => `${k}="${attr(v)}"`).join(" ")}>`;
  return open.length + 1 + instruction.length + 1 + 1 + `</${tag}>`.length;
}

export interface BuildOptions extends Partial<TextLimits> {
  /** Skip the first N records (already ingested from an earlier version of the file). */
  fromRecord?: number;
}

/**
 * Trajectory -> ingest turn texts. Returns [] when there is nothing to send.
 * When `fromRecord` > 0 the header carries `from-record="<n>"` so the agent
 * knows this continues a session it has seen before.
 */
export function buildIngestTexts(records: TrajectoryRecord[], meta: IngestMeta, opts: BuildOptions = {}): string[] {
  const limits: TextLimits = { ...DEFAULT_LIMITS, ...stripUndefined(opts) };
  const from = Math.max(0, opts.fromRecord ?? 0);
  const lines = renderRecords(records.slice(from), limits);
  if (lines.length === 0) return [];
  const attrs: Array<[string, string]> = [
    ["project", meta.project],
    ["member", meta.member],
    ["tool", meta.tool],
    ["session", meta.sessionId],
    ["started", meta.startedAt],
  ];
  if (from > 0) attrs.push(["from-record", String(from)]);
  const instruction = ingestInstruction(meta);
  const budget = Math.max(200, limits.maxChars - overhead("team-memory-ingest", attrs, instruction));
  return wrap("team-memory-ingest", attrs, instruction, packLines(lines, budget));
}

/** Inbox note -> ingest turn texts. */
export function buildNoteTexts(
  content: string,
  info: { project: string; member: string; file: string },
  opts: Partial<TextLimits> = {},
): string[] {
  const maxChars = opts.maxChars ?? DEFAULT_LIMITS.maxChars;
  const body = tidy(content);
  if (!body) return [];
  const attrs: Array<[string, string]> = [
    ["project", info.project],
    ["member", info.member],
    ["file", info.file],
  ];
  const instruction = noteInstruction(info.member);
  const budget = Math.max(200, maxChars - overhead("team-memory-note", attrs, instruction));
  return wrap("team-memory-note", attrs, instruction, packLines(body.split("\n"), budget));
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
