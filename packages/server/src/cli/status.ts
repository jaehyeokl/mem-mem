// memmem-server status: the server process, the App Server, and each
// project's worker state (from the state files).
import { loadState, localDate, type InitRun, type ProjectState } from "../state.js";
import { formatUsageLine, shiftDate, summarizeLedger, type UsageBucket, type UsageKind } from "../usage.js";
import type { Ctx } from "./ctx.js";
import { renderInit } from "./init.js";
import { CliError, ago, duration, short } from "./io.js";
import { readProjectsFile, type ProjectEntry } from "./projects-file.js";
import { currentPort, runningServer } from "./runtime.js";

export interface ProjectStatus {
  project: string;
  enabled: boolean;
  agentId: string;
  model: string | null;
  memoryRepo: string;
  transcriptsRepo: string;
  conversation: { id: string; date: string } | null;
  queue: number;
  unreflected: number;
  pendingReflection: number;
  pendingLog: number;
  lastPassAt: string | null;
  lastError: { at: string; message: string } | null;
  lastReflection: ProjectState["lastReflection"] | null;
  backoff: { failures: number; until: string | null; reason?: string } | null;
  lastPushedMemoryHead: string | null;
  lastSeenCommit: string | null;
  /** Project init: the current or last run (null when never requested). */
  init: InitRun | null;
  /** Token usage per kind over the last 7 days (today included), from the daily ledger. */
  usage7d: Record<UsageKind, UsageBucket>;
}

export interface StatusReport {
  now: string;
  home: string;
  lettaConfigDir: string;
  configPath: string;
  server: {
    running: boolean;
    pid: number | null;
    state: string | null;
    startedAt: string | null;
    version: string | null;
    port: number;
    appServerReady: boolean;
    appServerPid: number | null;
    appServerStartedAt: string | null;
    reloadedAt: string | null;
  };
  projects: ProjectStatus[];
}

export function projectStatus(p: ProjectEntry, st: ProjectState, today = localDate()): ProjectStatus {
  const backoffActive = st.backoff && (st.backoff.failures > 0 || st.backoff.until);
  return {
    project: p.project,
    enabled: p.enabled !== false,
    agentId: p.agentId,
    model: p.model ?? null,
    memoryRepo: p.memoryRepo,
    transcriptsRepo: p.transcriptsRepo,
    conversation: st.conversation,
    queue: st.queue.length,
    unreflected: st.unreflected.length,
    pendingReflection: st.pendingReflection.length,
    pendingLog: st.pendingLog.length,
    lastPassAt: st.lastPassAt ?? null,
    lastError: st.lastError ?? null,
    lastReflection: st.lastReflection ?? null,
    backoff: backoffActive ? st.backoff : null,
    lastPushedMemoryHead: st.lastPushedMemoryHead,
    lastSeenCommit: st.lastSeenCommit,
    init: st.init ?? null,
    usage7d: summarizeLedger(st.usage, shiftDate(today, -6), today).totals,
  };
}

export async function gatherStatus(ctx: Ctx, only?: string): Promise<StatusReport> {
  const { paths } = ctx;
  const srv = runningServer(paths);
  const port = currentPort(paths, ctx.env);
  const file = readProjectsFile(paths);
  const selected = only ? file.projects.filter((p) => p.project === only) : file.projects;
  if (only && !selected.length) throw new CliError(`unknown project: ${only}`);
  const projects: ProjectStatus[] = [];
  for (const p of selected) projects.push(projectStatus(p, await loadState(paths.stateDir, p.project)));
  return {
    now: new Date().toISOString(),
    home: paths.home,
    lettaConfigDir: paths.lettaConfigDir,
    configPath: paths.configPath,
    server: {
      running: !!srv,
      pid: srv?.pid ?? null,
      state: srv?.runtime?.state ?? null,
      startedAt: srv?.runtime?.startedAt ?? null,
      version: srv?.runtime?.version ?? null,
      port,
      appServerReady: await ctx.readyz(port),
      appServerPid: srv?.runtime?.appServerPid ?? null,
      appServerStartedAt: srv?.runtime?.appServerStartedAt ?? null,
      reloadedAt: srv?.runtime?.reloadedAt ?? null,
    },
    projects,
  };
}

export function renderProject(p: ProjectStatus, now: number): string[] {
  const lines = [`${p.project}${p.enabled ? "" : "  (paused)"}  agent ${p.agentId}${p.model ? `  model ${p.model}` : ""}`];
  lines.push(`  queue ${p.queue}  unreflected ${p.unreflected}  carried-forward ${p.pendingReflection}${p.pendingLog ? `  unpushed log entries ${p.pendingLog}` : ""}`);
  lines.push(`  last pass ${p.lastPassAt ? `${p.lastPassAt} (${ago(p.lastPassAt, now)})` : "never"}${p.conversation ? `  conversation ${p.conversation.id} (${p.conversation.date})` : ""}`);
  const r = p.lastReflection;
  lines.push(r ? `  last reflection ${r.outcome}${r.commit ? ` ${short(r.commit)}` : ""} (${r.trigger}, ${ago(r.at, now)})` : "  last reflection none recorded");
  lines.push(`  memory pushed ${short(p.lastPushedMemoryHead)}  transcripts seen ${short(p.lastSeenCommit)}`);
  if (p.backoff) {
    const until = p.backoff.until ? (Date.parse(p.backoff.until) > now ? `until ${p.backoff.until}` : `expired ${ago(p.backoff.until, now)}`) : "";
    lines.push(`  backoff ${p.backoff.failures} failure(s) ${until}${p.backoff.reason ? `: ${p.backoff.reason}` : ""}`.trimEnd());
  }
  if (p.usage7d) lines.push(`  usage 7d: ${formatUsageLine(p.usage7d)}`);
  if (p.lastError) lines.push(`  last error ${ago(p.lastError.at, now)}: ${p.lastError.message}`);
  if (p.init) lines.push(...renderInit(p.init, now).map((l) => `  ${l}`));
  return lines;
}

export function renderStatus(r: StatusReport): string {
  const now = Date.parse(r.now);
  const s = r.server;
  const lines: string[] = [];
  if (s.running) {
    lines.push(`memmem-server: running (pid ${s.pid}${s.startedAt ? `, up ${duration(now - Date.parse(s.startedAt))}` : ""}${s.state && s.state !== "running" ? `, ${s.state}` : ""})`);
  } else {
    lines.push("memmem-server: not running (start it with: memmem-server start)");
  }
  lines.push(
    `App Server: ws://127.0.0.1:${s.port} ${s.appServerReady ? "ready" : "not reachable"}${s.appServerPid ? ` (pid ${s.appServerPid}${s.appServerStartedAt ? `, started ${ago(s.appServerStartedAt, now)}` : ""})` : ""}`,
  );
  lines.push(`Data: ${r.home}   Letta: ${r.lettaConfigDir}`);
  lines.push("");
  if (!r.projects.length) {
    lines.push(`No projects in ${r.configPath}. Add one: memmem-server project add <name>`);
    return lines.join("\n");
  }
  lines.push(`Projects (${r.projects.length}):`);
  for (const p of r.projects) lines.push(...renderProject(p, now).map((l) => `  ${l}`));
  return lines.join("\n");
}

export async function cmdStatus(ctx: Ctx, values: Record<string, string | boolean | undefined>): Promise<number> {
  const report = await gatherStatus(ctx, typeof values.project === "string" ? values.project : undefined);
  if (ctx.out.json) ctx.out.data(report);
  else ctx.out.line(renderStatus(report));
  return 0;
}
