// memmem-server logs [-p project] [-f] [-n N] [--raw]
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { intOpt, str } from "./args.js";
import type { Ctx } from "./ctx.js";
import { CliError } from "./io.js";

type Values = Record<string, string | boolean | undefined>;

export function matchesProject(line: string, project: string | undefined): boolean {
  if (!project) return true;
  try {
    const o = JSON.parse(line) as { project?: unknown };
    return o.project === project;
  } catch {
    return false;
  }
}

/** `ts level event project key=value ...` for one JSON log line (other lines unchanged). */
export function formatLine(line: string): string {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return line;
  }
  const { ts, level, event, project, ...rest } = o;
  const kv = Object.entries(rest)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === "string" ? (/\s/.test(v) ? JSON.stringify(v) : v) : JSON.stringify(v)}`)
    .join(" ");
  return [String(ts ?? ""), String(level ?? "").padEnd(5), String(event ?? ""), project ? `[${String(project)}]` : "", kv].filter(Boolean).join(" ");
}

function readRange(file: string, start: number, end: number): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(end - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** The last `n` lines (after filtering), reading at most the last 16 MB. */
export function tailLines(file: string, n: number, project?: string): { lines: string[]; size: number } {
  const size = statSync(file).size;
  const start = Math.max(0, size - 16 * 1024 * 1024);
  const text = readRange(file, start, size);
  const all = text.split("\n");
  if (start > 0) all.shift(); // partial first line
  const lines = all.filter((l) => l.trim() && matchesProject(l, project));
  return { lines: lines.slice(Math.max(0, lines.length - n)), size };
}

export async function cmdLogs(ctx: Ctx, v: Values): Promise<number> {
  const file = ctx.paths.workerLog;
  const n = intOpt(v.lines, "lines", 200, 0);
  const project = str(v.project);
  const raw = v.raw === true || ctx.out.json;
  if (!existsSync(file)) {
    if (!v.follow) throw new CliError(`no log yet: ${file}`, "memmem-server start");
  }
  const print = (l: string) => process.stdout.write((raw ? l : formatLine(l)) + "\n");
  let pos = 0;
  if (existsSync(file)) {
    const t = tailLines(file, n, project);
    t.lines.forEach(print);
    pos = t.size;
  }
  if (!v.follow) return 0;
  let carry = "";
  for (;;) {
    await new Promise((r) => setTimeout(r, 1_000));
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (size < pos) pos = 0; // rotated or truncated
    if (size === pos) continue;
    const text = carry + readRange(file, pos, size);
    pos = size;
    const parts = text.split("\n");
    carry = parts.pop() ?? "";
    for (const l of parts) if (l.trim() && matchesProject(l, project)) print(l);
  }
}
