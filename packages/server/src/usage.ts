// Token usage: one normalized shape for ingest turns, reflections and init
// runs, and the per-day ledger kept in the project state.
//
// Letta Code reports usage in pi's terms (`input` = uncached input tokens,
// `cacheRead`, `cacheWrite`, `output`, `reasoning` (part of output),
// `totalTokens` = input + output + cacheRead + cacheWrite). The App Server's
// `usage_statistics` events carry the same numbers as prompt_tokens /
// completion_tokens / cached_input_tokens / cache_write_tokens /
// reasoning_tokens / total_tokens, so both map onto one shape.

export interface Usage {
  /** Input tokens not served from the provider's prompt cache. */
  input: number;
  output: number;
  /** Input tokens read from the prompt cache. */
  cacheRead: number;
  /** Input tokens written to the prompt cache. */
  cacheWrite: number;
  /** Reasoning tokens (already counted in `output`). */
  reasoning: number;
  /** input + output + cacheRead + cacheWrite, as Letta reports it. */
  total: number;
  /** Letta's own cost estimate in USD (reflection subagent records only); null when unknown. */
  costUsd: number | null;
}

export type UsageKind = "ingest" | "reflection" | "init";
export const USAGE_KINDS: UsageKind[] = ["ingest", "reflection", "init"];

/** One kind's usage on one day. `turns`: ingest turns, reflection runs, init runs. */
export interface UsageBucket extends Usage {
  turns: number;
}

/** `state.usage[YYYY-MM-DD][kind]`. */
export type UsageLedger = Record<string, Partial<Record<UsageKind, UsageBucket>>>;

/** Days of ledger kept in the project state. */
export const USAGE_DAYS = 90;

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, costUsd: null };
}

export function emptyBucket(): UsageBucket {
  return { turns: 0, ...emptyUsage() };
}

function num(o: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

/**
 * Any usage object the server sees, in the normalized shape: the normalized
 * shape itself, the worker's SDK turn usage (promptTokens, completionTokens,
 * cachedInputTokens, cacheWriteTokens, reasoningTokens, totalTokens), the App
 * Server's snake_case event fields, or a pi `usage` record from a Letta
 * conversation's messages.jsonl (input, output, cacheRead, cacheWrite,
 * reasoning, totalTokens, cost.total). Null when it has no token counts.
 */
export function normalizeUsage(raw: unknown): Usage | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const input = num(o, "input", "promptTokens", "prompt_tokens");
  const output = num(o, "output", "completionTokens", "completion_tokens");
  const cacheRead = num(o, "cacheRead", "cachedInputTokens", "cached_input_tokens");
  const cacheWrite = num(o, "cacheWrite", "cacheWriteTokens", "cache_write_tokens");
  const reasoning = num(o, "reasoning", "reasoningTokens", "reasoning_tokens");
  const total = num(o, "total", "totalTokens", "total_tokens");
  if ([input, output, cacheRead, cacheWrite, total].every((v) => v === undefined)) return null;
  const cost = o.cost && typeof o.cost === "object" ? num(o.cost as Record<string, unknown>, "total") : undefined;
  const costUsd = num(o, "costUsd") ?? cost ?? null;
  const u: Usage = {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    reasoning: reasoning ?? 0,
    total: 0,
    costUsd,
  };
  u.total = total ?? u.input + u.output + u.cacheRead + u.cacheWrite;
  return u;
}

/** Sum. `costUsd` is the sum of the known costs (null only when neither side has one). */
export function addUsage<T extends Usage>(a: T, b: Usage): T {
  const cost = a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return {
    ...a,
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    total: a.total + b.total,
    costUsd: cost === null ? null : Math.round(cost * 1e6) / 1e6,
  };
}

/** `YYYY-MM-DD` shifted by `days` (calendar arithmetic, no time zone involved). */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Drop ledger days older than `keepDays` before `today` (today counts as one). */
export function pruneLedger(ledger: UsageLedger, today: string, keepDays = USAGE_DAYS): UsageLedger {
  const cutoff = shiftDate(today, -(keepDays - 1));
  for (const day of Object.keys(ledger)) if (day < cutoff) delete ledger[day];
  return ledger;
}

/**
 * Add one finished ingest turn / reflection / init run to the ledger on
 * `date` (the local date it finished), and prune days beyond `USAGE_DAYS`.
 * `usage` null still counts the turn (a reflection whose records had no usage).
 */
export function recordUsage(
  holder: { usage?: UsageLedger },
  kind: UsageKind,
  usage: Usage | null,
  date: string,
  turns = 1,
): UsageLedger {
  const ledger = (holder.usage ??= {});
  const day = (ledger[date] ??= {});
  const prev = day[kind] ?? emptyBucket();
  day[kind] = usage ? addUsage({ ...prev, turns: prev.turns + turns }, usage) : { ...prev, turns: prev.turns + turns };
  return pruneLedger(ledger, date);
}

export interface UsageSummary {
  since: string;
  until: string;
  /** Days with entries, oldest first. */
  days: { date: string; kinds: Partial<Record<UsageKind, UsageBucket>> }[];
  totals: Record<UsageKind, UsageBucket>;
}

/** Ledger days in [since, until], plus per-kind totals. */
export function summarizeLedger(ledger: UsageLedger | undefined, since: string, until: string): UsageSummary {
  const totals = { ingest: emptyBucket(), reflection: emptyBucket(), init: emptyBucket() };
  const days: UsageSummary["days"] = [];
  for (const date of Object.keys(ledger ?? {}).sort()) {
    if (date < since || date > until) continue;
    const kinds = ledger![date]!;
    days.push({ date, kinds });
    for (const k of USAGE_KINDS) {
      const b = kinds[k];
      if (b) totals[k] = addUsage({ ...totals[k], turns: totals[k].turns + b.turns }, b);
    }
  }
  return { since, until, days, totals };
}

/** `--since`: `<n>d` (today and the n-1 days before it) or `YYYY-MM-DD`. Null when invalid. */
export function parseSince(spec: string, today: string): string | null {
  const m = /^(\d{1,4})d$/.exec(spec.trim());
  if (m) {
    const n = Number(m[1]);
    return n >= 1 ? shiftDate(today, -(n - 1)) : null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(spec) && !Number.isNaN(Date.parse(`${spec}T00:00:00Z`)) && shiftDate(spec, 0) === spec) return spec;
  return null;
}

/** 950, 12.3k, 4.5M. */
export function compactTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatCost(c: number): string {
  return c > 0 && c < 0.01 ? "<$0.01" : `$${c.toFixed(2)}`;
}

/** "ingest N turns / X tokens · reflection N / Y · init N / Z (≈$C)"; the cost part only when Letta priced something. */
export function formatUsageLine(totals: Record<UsageKind, UsageBucket>): string {
  const { ingest, reflection, init } = totals;
  const cost = USAGE_KINDS.reduce<number | null>((acc, k) => (totals[k].costUsd === null ? acc : (acc ?? 0) + totals[k].costUsd!), null);
  const parts = [
    `ingest ${ingest.turns} turns / ${compactTokens(ingest.total)} tokens`,
    `reflection ${reflection.turns} / ${compactTokens(reflection.total)}`,
    `init ${init.turns} / ${compactTokens(init.total)}`,
  ];
  return `${parts.join(" · ")}${cost !== null ? ` (≈${formatCost(cost)})` : ""}`;
}
