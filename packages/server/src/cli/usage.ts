// memmem-server usage [-p project] [--since 7d|30d|YYYY-MM-DD]: token usage
// per day and kind, from the daily ledger in each project's state file.
import { loadState, localDate } from "../state.js";
import {
  USAGE_DAYS,
  USAGE_KINDS,
  compactTokens,
  formatCost,
  formatUsageLine,
  parseSince,
  summarizeLedger,
  type UsageBucket,
  type UsageKind,
  type UsageSummary,
} from "../usage.js";
import { str } from "./args.js";
import type { Ctx } from "./ctx.js";
import { CliError, UsageError } from "./io.js";
import { readProjectsFile } from "./projects-file.js";

type Values = Record<string, string | boolean | undefined>;

export interface ProjectUsage extends UsageSummary {
  project: string;
}

/** What each kind's `turns` counts. */
const UNIT: Record<UsageKind, string> = { ingest: "turns", reflection: "runs", init: "runs" };

export async function gatherUsage(ctx: Ctx, opts: { project?: string; since: string; today: string }): Promise<ProjectUsage[]> {
  const file = readProjectsFile(ctx.paths);
  const selected = opts.project ? file.projects.filter((p) => p.project === opts.project) : file.projects;
  if (opts.project && !selected.length) throw new CliError(`unknown project: ${opts.project}`);
  const out: ProjectUsage[] = [];
  for (const p of selected) {
    const st = await loadState(ctx.paths.stateDir, p.project);
    out.push({ project: p.project, ...summarizeLedger(st.usage, opts.since, opts.today) });
  }
  return out;
}

function pad(s: string, n: number, left = false): string {
  return left ? s.padEnd(n) : s.padStart(n);
}

/** Per-kind table columns: count, tokens, cached, and cost when any day in range has one. */
function kindCells(b: UsageBucket | undefined, withCost: boolean): string[] {
  if (!b || (!b.turns && !b.total)) return withCost ? ["-", "-", "-", "-"] : ["-", "-", "-"];
  const cells = [String(b.turns), compactTokens(b.total), compactTokens(b.cacheRead)];
  if (withCost) cells.push(b.costUsd === null ? "-" : formatCost(b.costUsd));
  return cells;
}

export function renderProjectUsage(u: ProjectUsage): string[] {
  const lines = [`${u.project}  usage ${u.since} .. ${u.until}`];
  if (!u.days.length) {
    lines.push("  no usage recorded in this range");
    return lines;
  }
  const withCost = Object.fromEntries(USAGE_KINDS.map((k) => [k, u.totals[k].costUsd !== null])) as Record<UsageKind, boolean>;
  const header = ["date", ...USAGE_KINDS.flatMap((k) => [`${k} ${UNIT[k]}`, "tokens", "cached", ...(withCost[k] ? ["cost"] : [])])];
  const rows = [
    ...u.days.map((d) => [d.date, ...USAGE_KINDS.flatMap((k) => kindCells(d.kinds[k], withCost[k]))]),
    ["total", ...USAGE_KINDS.flatMap((k) => kindCells(u.totals[k], withCost[k]))],
  ];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => `  ${r.map((c, i) => pad(c, widths[i]!, i === 0)).join("  ")}`.trimEnd();
  lines.push(fmt(header), ...rows.map(fmt));
  lines.push(`  ${formatUsageLine(u.totals)}`);
  return lines;
}

export async function cmdUsage(ctx: Ctx, v: Values): Promise<number> {
  const today = localDate();
  const spec = str(v.since) ?? "7d";
  const since = parseSince(spec, today);
  if (!since) throw new UsageError(`--since must be <n>d (e.g. 7d, 30d) or YYYY-MM-DD, not ${JSON.stringify(spec)}`);
  const projects = await gatherUsage(ctx, { project: str(v.project), since, today });
  if (ctx.out.json) {
    ctx.out.data({ since, until: today, keptDays: USAGE_DAYS, projects });
    return 0;
  }
  if (!projects.length) {
    ctx.out.line("No projects.");
    return 0;
  }
  const blocks = projects.map((p) => renderProjectUsage(p).join("\n"));
  ctx.out.line(blocks.join("\n\n"));
  return 0;
}
