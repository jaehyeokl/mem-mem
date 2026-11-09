// The running server: pid file, runtime info (server.json), signals.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { appServerPort, type ServerPaths } from "../paths.js";
import type { Ctx } from "./ctx.js";

export interface RuntimeInfo {
  pid: number;
  version: string;
  startedAt: string;
  port: number;
  state: "starting" | "running" | "reloading" | "stopping";
  appServerPid: number | null;
  /** When the current App Server process started (agents created after this are not loaded). */
  appServerStartedAt: string | null;
  /** When the last reload (SIGHUP) finished. */
  reloadedAt: string | null;
  home: string;
  lettaConfigDir: string;
}

export function isAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readPid(paths: ServerPaths): number | null {
  try {
    const n = Number(readFileSync(paths.pidFile, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function readRuntime(paths: ServerPaths): RuntimeInfo | null {
  try {
    return JSON.parse(readFileSync(paths.runtimeFile, "utf8")) as RuntimeInfo;
  } catch {
    return null;
  }
}

export function writeRuntime(paths: ServerPaths, info: RuntimeInfo): void {
  mkdirSync(dirname(paths.runtimeFile), { recursive: true });
  const tmp = `${paths.runtimeFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info, null, 2) + "\n");
  renameSync(tmp, paths.runtimeFile);
}

export function clearRuntime(paths: ServerPaths, pid: number): void {
  if (readPid(paths) === pid) rmSync(paths.pidFile, { force: true });
  const rt = readRuntime(paths);
  if (rt && rt.pid === pid) rmSync(paths.runtimeFile, { force: true });
}

/** The running `memmem-server start` process, if any (stale pid files are ignored). */
export function runningServer(paths: ServerPaths): { pid: number; runtime: RuntimeInfo | null } | null {
  const pid = readPid(paths);
  if (!pid || !isAlive(pid)) return null;
  const runtime = readRuntime(paths);
  return { pid, runtime: runtime && runtime.pid === pid ? runtime : null };
}

/** The App Server port: the running server's, else the environment's. */
export function currentPort(paths: ServerPaths, env: NodeJS.ProcessEnv): number {
  return runningServer(paths)?.runtime?.port ?? appServerPort(env);
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export type ReloadResult = "reloaded" | "timeout" | "external" | "not_running";

/**
 * Restart the App Server (and worker) inside the running `start` process so
 * Letta re-reads agents, models, providers and the reflection model: Letta
 * Code's local backend reads them only at App Server startup.
 */
export async function requestReload(ctx: Ctx, reason: string, timeoutMs = 120_000): Promise<ReloadResult> {
  const srv = runningServer(ctx.paths);
  if (!srv) {
    return (await ctx.readyz(appServerPort(ctx.env))) ? "external" : "not_running";
  }
  const sentAt = new Date().toISOString();
  ctx.out.line(`Reloading the App Server so it picks up the change (${reason})...`);
  process.kill(srv.pid, "SIGHUP");
  const ok = await waitFor(async () => {
    const rt = readRuntime(ctx.paths);
    return !!rt && rt.state === "running" && !!rt.reloadedAt && rt.reloadedAt >= sentAt && (await ctx.readyz(rt.port));
  }, timeoutMs, 1_000);
  return ok ? "reloaded" : "timeout";
}

/** Print what a reload did (used after project add, model set, provider connect ...). */
export function reportReload(ctx: Ctx, r: ReloadResult): void {
  if (r === "reloaded") ctx.out.result("ok", "App Server", "reloaded; it now knows the change");
  else if (r === "timeout") ctx.out.result("warn", "App Server", "reload requested but not finished after 2 min; check memmem-server status / logs");
  else if (r === "external")
    ctx.out.result("warn", "App Server", "an App Server not started by memmem-server is running; restart it yourself (Letta reads agents only at startup)");
  else ctx.out.result("info", "App Server", "not running; the change applies when you run memmem-server start");
}

export function pidFileExists(paths: ServerPaths): boolean {
  return existsSync(paths.pidFile);
}
