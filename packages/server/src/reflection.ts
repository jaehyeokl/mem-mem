// Reflection instructions and the carry-forward list of sessions that a
// reflection saw but did not save to memory.
import { DEFAULT_LANGUAGE, memoryLanguageInstruction } from "./language.js";
import { membersInstruction, type MemberRecord } from "./members.js";
import type { PendingReflectionItem } from "./state.js";

/** Keep at most this many sessions waiting for a reflection that saves them. */
export const MAX_PENDING_REFLECTION = 20;
/** Drop a session after this many reflections included it and saved nothing. */
export const MAX_PENDING_MISSES = 4;

export interface InstructionInput {
  /** The primary (ingest) agent id. */
  agentId: string;
  /** `<LETTA_CONFIG_DIR>/lc-local-backend/memfs/<agentId>`: holds `memory/` and `memory-worktrees/`. */
  memfsAgentRoot: string;
  /** Sessions that earlier reflections did not save; their text is in `transcriptPath`. */
  pending: PendingReflectionItem[];
  /** Absolute path of a conversation's `transcript.jsonl`. */
  transcriptPath: (conversationId: string) => string;
  /** True for the immediate retry after a reflection that failed to save (or whose outcome is unknown). */
  retry?: boolean;
  /** Why the previous reflection is considered failed (one line); shown in the retry instruction. */
  retryReason?: string;
  /** Registered team members (members/*.json): git authors and aliases to attribute sessions and merge people files. */
  members?: MemberRecord[];
  /** The project's memory language (projects.json `language`; default en). */
  language?: string;
}

function describe(item: PendingReflectionItem): string {
  const who = [item.member && `member ${item.member}`, item.tool && `tool ${item.tool}`].filter(Boolean).join(", ");
  const id = item.session ? `session ${item.session}` : `file ${item.file}`;
  return `${id}${who ? ` (${who})` : ""}`;
}

/** The report line the instruction asks for: `RESULT: committed | nothing-to-save | failed: <reason>`. */
export const RESULT_PREFIX = "RESULT:";

function oneLine(text: string | undefined, max = 200): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/**
 * The text passed as `reflect -- <instruction>`. Letta appends it to its own
 * reflection prompt as "Additional user-provided reflection instruction".
 *
 * The reflection subagent edits a MemFS worktree (`$MEMORY_DIR` =
 * `<root>/memory-worktrees/reflection-...`), not `<root>/memory` itself, so
 * the instruction names the agent's MemFS root and the agent id, and tells it
 * to copy paths from `$MEMORY_DIR` instead of retyping agent ids.
 */
export function buildReflectionInstruction(input: InstructionInput): string {
  const root = input.memfsAgentRoot.replace(/\/+$/, "");
  const lines: string[] = [];
  if (input.retry) {
    lines.push(
      `The previous reflection could not save its changes (${oneLine(input.retryReason) || "unknown"}). Record what is worth keeping under the Rules for reflection; if nothing is, end with RESULT: nothing-to-save.`,
    );
  }
  lines.push(
    `Memory location: the primary agent id is ${input.agentId}. Its memory filesystem is ${root}/memory, and your $MEMORY_DIR is a reflection worktree of it under ${root}/memory-worktrees/.`,
    `Write memory files only inside $MEMORY_DIR. Every absolute path you give Edit or Write must start with ${root}/ and must be copied character for character from the output of printf "%s\\n" "$MEMORY_DIR". Never retype, guess or combine agent ids: your own subagent id is different and is not allowed.`,
    "If an edit is denied (for example by the cross-agent memory guard), resolve the path from $MEMORY_DIR again, fix it and retry. Do not finish before the changes you planned are committed.",
    memoryLanguageInstruction(input.language ?? DEFAULT_LANGUAGE),
    `End your report with exactly one line: "${RESULT_PREFIX} committed", "${RESULT_PREFIX} nothing-to-save" (nothing worth keeping), or "${RESULT_PREFIX} failed: <one-line reason>".`,
  );
  if (input.pending.length) {
    lines.push(
      "Sessions still to review: an earlier reflection could not save the sessions below, and they are not in this payload. Read each one from the transcript file given (a JSONL file; the user line whose header contains the session id or file path holds the full ingest text) and record what is worth keeping following the Rules for reflection in MEMORY.md:",
    );
    for (const item of input.pending) {
      lines.push(`- ${describe(item)}: ${input.transcriptPath(item.conversationId)}`);
    }
  }
  lines.push(...membersInstruction(input.members ?? []));
  return lines.join("\n");
}

/** A short turn that gives the retry reflection new transcript content to start from. */
export function buildRetryTurn(project: string, items: PendingReflectionItem[]): string {
  const ids = items.map((i) => i.session ?? i.file).join(",");
  return [
    `<team-memory-retry project="${project}" sessions="${ids.replace(/"/g, "'")}">`,
    "An earlier reflection failed to save memory for the sessions below, so they are sent for review again. Reply with one sentence only, and leave memory updates to the background reflection.",
    ...items.map((i) => `- ${describe(i)}`),
    "</team-memory-retry>",
  ].join("\n");
}

/**
 * Add `items` to the carry-forward list: dedupe by file (the newer entry
 * wins, keeping the higher miss count), count one more miss for each, drop
 * entries with too many misses, and keep only the newest
 * `MAX_PENDING_REFLECTION`. Returns the new list and what was dropped.
 */
export function addPending(
  current: PendingReflectionItem[],
  items: PendingReflectionItem[],
  max = MAX_PENDING_REFLECTION,
  maxMisses = MAX_PENDING_MISSES,
): { pending: PendingReflectionItem[]; dropped: PendingReflectionItem[] } {
  const byFile = new Map<string, PendingReflectionItem>();
  for (const item of current) byFile.set(item.file, item);
  for (const item of items) {
    const prev = byFile.get(item.file);
    byFile.delete(item.file); // re-insert at the end: newest last
    byFile.set(item.file, { ...item, misses: Math.max(prev?.misses ?? 0, item.misses ?? 0) + 1 });
  }
  const dropped: PendingReflectionItem[] = [];
  let pending = [...byFile.values()].filter((i) => {
    if ((i.misses ?? 0) >= maxMisses) {
      dropped.push(i);
      return false;
    }
    return true;
  });
  if (pending.length > max) {
    dropped.push(...pending.slice(0, pending.length - max));
    pending = pending.slice(pending.length - max);
  }
  return { pending, dropped };
}

// ---------------------------------------------------------------------------
// Reflection outcome: did the reflection carry out its own judgment?
//
// Whether a session is worth saving is the reflection subagent's call. The
// worker only checks whether that call was technically carried out: a
// reflection that decided "nothing worth keeping" is accepted, one that tried
// to save and failed (a denied edit, a failed commit) is retried.

export type ReflectionOutcome = "committed" | "nothing_to_save" | "failed" | "unknown";

/** Which rule decided the outcome (precedence order). */
export type OutcomeSource = "head" | "result_line" | "tool_errors" | "report_prose" | "no_report";

export interface OutcomeInput {
  /** The new MemFS main commit, or null when main did not move. */
  commit: string | null;
  /** The reflection subagent's full final report (not the excerpt), if found. */
  report?: string | null;
  /** Failed tool results from the subagent's conversation (`readReflectionToolErrors`). */
  subagentToolErrors?: string[] | null;
}

export interface OutcomeDetail {
  outcome: ReflectionOutcome;
  source: OutcomeSource;
  /** One-line reason for `failed` / `unknown` (used in the retry instruction). */
  reason?: string;
  /** The report said `RESULT: committed` but MemFS main did not move. */
  claimedCommit?: boolean;
}

export interface ResultLine {
  result: "committed" | "nothing-to-save" | "failed";
  reason?: string;
}

const RESULT_LINE =
  /^[\s>#*_`-]*RESULT[*_`]*\s*:[\s*_`]*(committed|nothing[-_ ]to[-_ ]save|failed)\b[*_`]*\s*(?::\s*(.*?))?[\s*_`]*$/gim;

/** The last `RESULT: ...` line of a report, or null. Tolerates markdown decoration (`**RESULT:** ...`). */
export function parseResultLine(report: string): ResultLine | null {
  let last: RegExpExecArray | null = null;
  for (const m of report.matchAll(RESULT_LINE)) last = m;
  if (!last) return null;
  const word = last[1]!.toLowerCase();
  const result = word.startsWith("nothing") ? "nothing-to-save" : (word as "committed" | "failed");
  const reason = last[2]?.trim();
  return reason ? { result, reason } : { result };
}

const SECTION_NAMES = "Summary|Memory changes|Skipped|Commit|Issues";
/** A section start: `## Issues`, `### 4. Commit`, `4. **Commit** — ...`, `**Issues:** ...`, `Issues: ...`. */
const SECTION_HEADING = new RegExp(`^[ \\t]*#{1,6}[ \\t]*(?:\\d+[.)][ \\t]*)?[*_]{0,2}(${SECTION_NAMES})\\b[*_]{0,2}[ \\t]*:?[*_]{0,2}[ \\t]*(.*)$`, "i");
const SECTION_BOLD = new RegExp(`^[ \\t]*(?:\\d+[.)][ \\t]*)?(?:\\*\\*|__)(${SECTION_NAMES})\\b:?(?:\\*\\*|__)[ \\t]*(?:[:\\u2014\\u2013-][ \\t]*)?(.*)$`, "i");
const SECTION_PLAIN = new RegExp(`^[ \\t]*(?:\\d+[.)][ \\t]*)?(${SECTION_NAMES})[ \\t]*[:\\u2014\\u2013][ \\t]*(.*)$`, "i");

function sectionStart(line: string): RegExpExecArray | null {
  return SECTION_HEADING.exec(line) ?? SECTION_BOLD.exec(line) ?? SECTION_PLAIN.exec(line);
}

/**
 * The report's sections (Summary, Memory changes, Skipped, Commit, Issues) by
 * lowercase name. Handles markdown headings, numbered bold items and
 * `Name: text` lines; a `RESULT:` line ends the current section.
 */
export function reportSections(report: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (current && !out.has(current)) out.set(current, body.join("\n").trim());
    current = null;
    body = [];
  };
  for (const line of report.split("\n")) {
    const m = sectionStart(line);
    if (m) {
      flush();
      current = m[1]!.toLowerCase();
      body = m[2] ? [m[2]] : [];
      continue;
    }
    if (/^[\s>#*_`-]*RESULT[*_`]*\s*:/i.test(line)) {
      flush();
      continue;
    }
    if (current) body.push(line);
  }
  flush();
  // "No commit. Issues: None." on one line.
  if (!out.has("issues")) {
    const inline = /\bIssues\s*[:—–]\s*([^\n]*)/i.exec(report);
    if (inline) out.set("issues", inline[1]!.trim());
  }
  return out;
}

/** "None", "- None.", "No issues", "N/A", the Korean "none" ... */
function isNoneLike(text: string): boolean {
  const t = text.replace(/^[\s>*_`-]+/, "").trim();
  return t === "" || /^(?:none|no issues?|no problems?|n\/a|nothing|없음|해당\s*없음)\b/i.test(t);
}

const PROSE_FAILURE =
  /\bdenied\b|\bguard\b|\b(?:could not|couldn't|cannot|can't|failed to|unable to)\s+(?:write|edit|commit|save|create|persist)\b|\bblocked\b|\bnot (?:be )?committed\b/i;
const PROSE_NOTHING = /\bno commit\b|\bnothing (?:to commit|memory-worthy|worth (?:saving|keeping|recording))\b|\bskipped\b|\bno (?:durable|memory)\b/i;

function firstLine(text: string, max = 200): string {
  const line = text.split("\n").map((l) => l.replace(/^[\s>*_`-]+/, "").trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/**
 * Classify a finished reflection, in this order:
 *
 * a. MemFS main moved: `committed` (whatever the report says).
 * b. The report has a `RESULT:` line: follow it. `committed` without a head
 *    move is `failed` (`claimedCommit`).
 * c. The subagent's conversation has failed tool results (memory guard
 *    denial, permission denied, git commit/worktree failure): `failed`.
 * d. Prose: failure wording in the Commit/Issues sections (or anywhere, when
 *    the report has no sections), a Commit section that claims a commit
 *    (`claimedCommit`), or an Issues section that is not "None": `failed`;
 *    "No commit" / "Skipped" with no issues: `nothing_to_save`.
 * e. No report: `unknown`. A report with none of the above is `unknown` too.
 */
export function explainReflectionOutcome(input: OutcomeInput): OutcomeDetail {
  if (input.commit) return { outcome: "committed", source: "head" };
  const report = input.report?.trim() ?? "";
  const toolErrors = input.subagentToolErrors ?? [];
  if (report) {
    const line = parseResultLine(report);
    if (line) {
      if (line.result === "nothing-to-save") return { outcome: "nothing_to_save", source: "result_line" };
      if (line.result === "failed") return { outcome: "failed", source: "result_line", reason: line.reason ? firstLine(line.reason) : "reported failed" };
      return {
        outcome: "failed",
        source: "result_line",
        reason: "report said committed but MemFS main did not move",
        claimedCommit: true,
      };
    }
  }
  if (toolErrors.length) return { outcome: "failed", source: "tool_errors", reason: firstLine(toolErrors[0]!) };
  if (!report) return { outcome: "unknown", source: "no_report", reason: "no reflection report found" };

  const sections = reportSections(report);
  const scoped = sections.has("commit") || sections.has("issues");
  const scope = scoped ? [sections.get("commit") ?? "", sections.get("issues") ?? ""].join("\n") : report;
  const fail = PROSE_FAILURE.exec(scope);
  if (fail) {
    const issues = sections.get("issues");
    return { outcome: "failed", source: "report_prose", reason: firstLine(issues && !isNoneLike(issues) ? issues : fail[0]) };
  }
  const commitText = sections.get("commit");
  if (commitText && !/\bno commit|\bnothing\b|\bnone\b|\bskipped\b|\bnot committed\b/i.test(commitText) && /\bcommitted\b|\b[0-9a-f]{7,40}\b/i.test(commitText)) {
    return { outcome: "failed", source: "report_prose", reason: "report says it committed but MemFS main did not move", claimedCommit: true };
  }
  const issues = sections.get("issues");
  if (issues !== undefined && !isNoneLike(issues)) return { outcome: "failed", source: "report_prose", reason: firstLine(issues) };
  if (PROSE_NOTHING.test(report)) return { outcome: "nothing_to_save", source: "report_prose" };
  return { outcome: "unknown", source: "report_prose", reason: "report has no RESULT line and no clear outcome" };
}

export function classifyReflectionOutcome(input: OutcomeInput): ReflectionOutcome {
  return explainReflectionOutcome(input).outcome;
}
