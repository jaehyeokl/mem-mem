// memmem-server start | stop | restart: run the Letta App Server as a child
// and the ingest worker in-process. If either dies, stop the other and exit
// non-zero. SIGTERM/SIGINT stop gracefully (the worker finishes its turn,
// up to 30 s). SIGHUP restarts the App Server and the worker in place, so
// Letta re-reads agents, models and providers (it reads them only at
// startup). SIGUSR2 wakes the worker for a queued CLI request.
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readReflectionState } from "../letta.js";
import { errorMessage, log, setLogFile } from "../log.js";
import { appServerPort } from "../paths.js";
import { loadState } from "../state.js";
import { Worker } from "../worker.js";
import { intOpt } from "./args.js";
import type { Ctx } from "./ctx.js";
import { CliError, duration } from "./io.js";
import { readProviders } from "./letta-cli.js";
import { DEFAULT_FILE_SETTINGS, readProjectsFile, writeProjectsFile } from "./projects-file.js";
import { clearRuntime, isAlive, readRuntime, requestReload, reportReload, runningServer, waitFor, writeRuntime, type RuntimeInfo } from "./runtime.js";
import { launchdPlistPath, renderLaunchdPlist, renderSystemdUnit, serviceEnv, systemdUnitPath, SERVICE_NAME, LAUNCHD_LABEL } from "./service.js";
import { ensureDataDirs } from "./setup.js";

type Values = Record<string, string | boolean | undefined>;

const READY_TIMEOUT_MS = Number(process.env.MEMMEM_READY_TIMEOUT || 60) * 1000;
const WORKER_STOP_MS = 30_000;
const LOG_ROTATE_BYTES = 50 * 1024 * 1024;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function rotate(file: string): void {
  try {
    if (statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // missing: nothing to rotate
  }
}

interface AppServer {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnAppServer(ctx: Ctx, port: number): AppServer {
  const args = ["--backend", "local", "server", "--listen", `ws://127.0.0.1:${port}`, "--openai-api"];
  // Loopback only: the worker runs in this process. A remote worker would need
  // --ws-auth capability-token (not supported here yet).
  const child = spawn("letta", args, { env: ctx.env, cwd: ctx.paths.home, stdio: ["ignore", "pipe", "pipe"] });
  const file = createWriteStream(ctx.paths.appServerLog, { flags: "a" });
  file.on("error", () => undefined);
  const pipe = (s: NodeJS.ReadableStream | null) => {
    s?.on("data", (d: Buffer) => {
      process.stdout.write(d);
      file.write(d);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
    child.on("error", (err) => {
      log("error", "app_server_spawn_failed", { error: errorMessage(err) });
      res({ code: 127, signal: null });
    });
    child.on("exit", (code, signal) => {
      file.end();
      res({ code, signal });
    });
  });
  return { child, exited };
}

async function stopApp(app: AppServer, ms = 20_000): Promise<void> {
  if (app.child.exitCode !== null || app.child.signalCode !== null) return;
  app.child.kill("SIGTERM");
  const done = await Promise.race([app.exited.then(() => true), sleep(ms).then(() => false)]);
  if (!done) {
    app.child.kill("SIGKILL");
    await app.exited;
  }
}

async function stopWorker(worker: Worker, done: Promise<unknown>, ms = WORKER_STOP_MS): Promise<void> {
  worker.stop();
  const finished = await Promise.race([done.then(() => true), sleep(ms).then(() => false)]);
  if (!finished) log("warn", "worker_stop_timeout", { waitedMs: ms });
}

export async function runForeground(ctx: Ctx, port: number): Promise<number> {
  const { paths } = ctx;
  const existing = runningServer(paths);
  if (existing) throw new CliError(`memmem-server is already running (pid ${existing.pid})`, "memmem-server status");
  if (await ctx.readyz(port)) throw new CliError(`something already answers on 127.0.0.1:${port}/readyz`, "stop it, or pick another port with --port / LETTA_APP_SERVER_PORT");
  ensureDataDirs(ctx);
  // An empty projects.json, so the worker idles quietly until `project add`.
  if (!existsSync(paths.configPath)) writeProjectsFile(paths, { settings: { ...DEFAULT_FILE_SETTINGS }, projects: [] });
  rotate(paths.workerLog);
  rotate(paths.appServerLog);
  setLogFile(paths.workerLog);
  ctx.env.LETTA_APP_SERVER_PORT = String(port);
  ctx.env.MEMMEM_APP_SERVER_URL = `ws://127.0.0.1:${port}`;
  writeFileSync(paths.pidFile, `${process.pid}\n`);
  const rt: RuntimeInfo = {
    pid: process.pid,
    version: ctx.version,
    startedAt: new Date().toISOString(),
    port,
    state: "starting",
    appServerPid: null,
    appServerStartedAt: null,
    reloadedAt: null,
    home: paths.home,
    lettaConfigDir: paths.lettaConfigDir,
  };
  const save = () => writeRuntime(paths, rt);
  save();
  log("info", "server_start", { pid: process.pid, version: ctx.version, port, home: paths.home, lettaConfigDir: paths.lettaConfigDir, node: process.version });
  if (!readProviders(paths).length) {
    log("warn", "no_provider", { hint: "turns and reflections fail until a model provider is connected: memmem-server provider connect chatgpt" });
  }
  let gitconfig = "";
  try {
    gitconfig = readFileSync(paths.gitConfig, "utf8");
  } catch {
    // no server gitconfig yet
  }
  if (!/^\s*name\s*=/m.test(gitconfig) || !/helper\s*=\s*\S/.test(gitconfig)) {
    log("warn", "git_setup_incomplete", {
      gitConfig: paths.gitConfig,
      identity: /^\s*name\s*=/m.test(gitconfig),
      credentialHelper: /helper\s*=\s*\S/.test(gitconfig),
      hint: "pushes and reflection commits may fail until you run: memmem-server setup",
    });
  }
  try {
    if (!readProjectsFile(paths).projects.length) log("info", "no_projects", { hint: "memmem-server project add <name>" });
  } catch (err) {
    log("error", "config_error", { error: errorMessage(err) });
  }

  let stopRequested = false;
  let reloadRequested = false;
  let signals = 0;
  let wake: () => void = () => undefined;
  let app: AppServer | null = null;
  let worker: Worker | null = null;
  const onStop = (sig: NodeJS.Signals) => {
    signals += 1;
    if (signals > 1) {
      log("warn", "server_forced_exit", { signal: sig });
      app?.child.kill("SIGKILL");
      clearRuntime(paths, process.pid);
      process.exit(130);
    }
    stopRequested = true;
    log("info", "server_stopping", { signal: sig });
    wake();
  };
  const onHup = () => {
    reloadRequested = true;
    log("info", "server_reload_requested", {});
    wake();
  };
  const onUsr2 = () => worker?.wake();
  process.on("SIGTERM", onStop);
  process.on("SIGINT", onStop);
  process.on("SIGHUP", onHup);
  process.on("SIGUSR2", onUsr2);
  const onRejection = (reason: unknown) => log("error", "unhandled_rejection", { error: errorMessage(reason) });
  process.on("unhandledRejection", onRejection);

  let exitCode = 0;
  let reloaded = false;
  try {
    for (;;) {
      rt.state = "starting";
      app = spawnAppServer(ctx, port);
      rt.appServerPid = app.child.pid ?? null;
      rt.appServerStartedAt = new Date().toISOString();
      save();
      log("info", "app_server_starting", { port, pid: app.child.pid, listen: `ws://127.0.0.1:${port}` });
      const current = app;
      let exitedEarly = false;
      void current.exited.then(() => (exitedEarly = true));
      const ready = await waitFor(async () => stopRequested || exitedEarly || (await ctx.readyz(port)), READY_TIMEOUT_MS, 1_000);
      if (stopRequested) {
        await stopApp(current);
        break;
      }
      if (!ready || exitedEarly) {
        const r = exitedEarly ? await current.exited : null;
        log("error", "app_server_not_ready", { port, timeoutMs: READY_TIMEOUT_MS, exitCode: r?.code, signal: r?.signal });
        await stopApp(current);
        exitCode = 1;
        break;
      }
      log("info", "app_server_ready", { port, pid: current.child.pid });

      const w = new Worker();
      worker = w;
      const workerDone = w.run().then(
        (code) => ({ code }),
        (err) => {
          log("error", "worker_crashed", { error: errorMessage(err) });
          return { code: 1 };
        },
      );
      rt.state = "running";
      if (reloaded) rt.reloadedAt = new Date().toISOString();
      save();
      if (reloaded) log("info", "server_reloaded", { appServerPid: current.child.pid });

      const signalled = new Promise<{ kind: "signal" }>((res) => {
        wake = () => res({ kind: "signal" });
      });
      if (stopRequested || reloadRequested) wake();
      const ev = await Promise.race([
        current.exited.then((r) => ({ kind: "app" as const, r })),
        workerDone.then((r) => ({ kind: "worker" as const, r })),
        signalled,
      ]);
      wake = () => undefined;

      if (ev.kind === "signal" && stopRequested) {
        rt.state = "stopping";
        save();
        await stopWorker(w, workerDone);
        await stopApp(current);
        exitCode = 0;
        break;
      }
      if (ev.kind === "signal") {
        reloadRequested = false;
        rt.state = "reloading";
        save();
        log("info", "server_reloading", { hint: "restarting the App Server so it reads agents, models and providers again" });
        await stopWorker(w, workerDone, 60_000);
        await stopApp(current);
        reloaded = true;
        continue;
      }
      if (ev.kind === "app") {
        log("error", "app_server_exited", { code: ev.r.code, signal: ev.r.signal });
        await stopWorker(w, workerDone);
        exitCode = ev.r.code && ev.r.code !== 0 ? ev.r.code : 1;
        break;
      }
      log(ev.r.code === 0 ? "info" : "error", "worker_exited", { code: ev.r.code });
      await stopApp(current);
      exitCode = ev.r.code === 0 ? (ctx.env.MEMMEM_ONCE === "1" ? 0 : 1) : ev.r.code;
      break;
    }
  } finally {
    process.off("SIGTERM", onStop);
    process.off("SIGINT", onStop);
    process.off("SIGHUP", onHup);
    process.off("SIGUSR2", onUsr2);
    process.off("unhandledRejection", onRejection);
    clearRuntime(paths, process.pid);
    log("info", "server_exit", { code: exitCode });
  }
  return exitCode;
}

/** Path of this CLI's entry script (for detached starts and service files). */
function binPath(): string {
  const argv1 = process.argv[1];
  if (argv1 && existsSync(argv1)) return resolve(argv1);
  return resolve(dirname(new URL(import.meta.url).pathname), "..", "..", "bin", "memmem-server.js");
}

export async function startDetached(ctx: Ctx, port: number): Promise<number> {
  const existing = runningServer(ctx.paths);
  if (existing) {
    ctx.out.result("skip", "memmem-server", `already running (pid ${existing.pid})`);
    return 0;
  }
  ensureDataDirs(ctx);
  const outFile = join(ctx.paths.logsDir, "server.out");
  const fd = openSync(outFile, "a");
  const child = spawn(process.execPath, [binPath(), "start", "--foreground", "--port", String(port)], {
    env: ctx.env,
    cwd: ctx.paths.home,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  ctx.out.line(`Starting memmem-server in the background (pid ${child.pid}, output: ${outFile})...`);
  const ok = await waitFor(() => readRuntime(ctx.paths)?.state === "running" && readRuntime(ctx.paths)?.pid === child.pid, READY_TIMEOUT_MS + 30_000, 1_000);
  if (!ok) {
    if (!isAlive(child.pid)) throw new CliError("memmem-server exited during startup", `see ${outFile}`);
    ctx.out.result("warn", "memmem-server", `started (pid ${child.pid}) but not ready yet; check memmem-server status`);
    return 1;
  }
  ctx.out.result("ok", "memmem-server", `running (pid ${child.pid}), App Server on ws://127.0.0.1:${port}`);
  ctx.out.data({ ok: true, pid: child.pid, port });
  return 0;
}

export function installService(ctx: Ctx): number {
  const spec = { node: process.execPath, bin: binPath(), env: serviceEnv(ctx.env), home: ctx.paths.home };
  if (process.platform === "darwin") {
    const file = launchdPlistPath(ctx.env);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderLaunchdPlist(spec));
    ctx.out.result("ok", "launchd agent", file);
    ctx.out.line("Enable it (starts now and at login):");
    ctx.out.line(`  launchctl bootstrap gui/$(id -u) ${file}`);
    ctx.out.line(`Restart: launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}    Remove: launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`);
    ctx.out.data({ ok: true, kind: "launchd", file });
    return 0;
  }
  if (process.platform !== "linux") throw new CliError(`--install-service supports Linux (systemd) and macOS (launchd), not ${process.platform}`);
  const file = systemdUnitPath(ctx.env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderSystemdUnit(spec));
  ctx.out.result("ok", "systemd user unit", file);
  ctx.out.line("Enable it (starts now and at login):");
  ctx.out.line(`  systemctl --user daemon-reload && systemctl --user enable --now ${SERVICE_NAME}.service`);
  ctx.out.line("Keep it running after you log out:");
  ctx.out.line("  sudo loginctl enable-linger $USER");
  ctx.out.line(`Logs: memmem-server logs -f   (or journalctl --user -u ${SERVICE_NAME})`);
  ctx.out.data({ ok: true, kind: "systemd", file });
  return 0;
}

export async function cmdStart(ctx: Ctx, values: Values): Promise<number> {
  if (values["install-service"]) return installService(ctx);
  const port = intOpt(values.port, "port", appServerPort(ctx.env), 1);
  if (values.detach && values.foreground) throw new CliError("--detach and --foreground exclude each other");
  if (values.detach) return startDetached(ctx, port);
  return runForeground(ctx, port);
}

/** Is a reflection in flight for any project (Letta's state.json says started after the last success)? */
export async function reflectionsInFlight(ctx: Ctx): Promise<string[]> {
  const file = readProjectsFile(ctx.paths);
  const transcriptRoot = ctx.env.LETTA_TRANSCRIPT_ROOT || join(ctx.paths.lettaConfigDir, "transcripts");
  const busy: string[] = [];
  for (const p of file.projects) {
    const st = await loadState(ctx.paths.stateDir, p.project).catch(() => null);
    const conv = st?.conversation?.id;
    if (!conv) continue;
    const rs = await readReflectionState({ lettaConfigDir: ctx.paths.lettaConfigDir, transcriptRoot }, p.agentId, conv);
    const started = rs?.last_reflection_started_at;
    if (started && (!rs?.last_reflection_succeeded_at || started > rs.last_reflection_succeeded_at) && Date.now() - Date.parse(started) < 15 * 60_000) {
      busy.push(p.project);
    }
  }
  return busy;
}

async function serviceActive(ctx: Ctx): Promise<"systemd" | "launchd" | null> {
  if (process.platform === "linux" && existsSync(systemdUnitPath(ctx.env))) {
    const r = await ctx.run("systemctl", ["--user", "is-active", `${SERVICE_NAME}.service`], { env: ctx.env });
    if (r.stdout.trim() === "active") return "systemd";
  }
  if (process.platform === "darwin" && existsSync(launchdPlistPath(ctx.env))) {
    const uid = process.getuid?.() ?? 0;
    const r = await ctx.run("launchctl", ["print", `gui/${uid}/${LAUNCHD_LABEL}`], { env: ctx.env });
    if (r.code === 0) return "launchd";
  }
  return null;
}

export async function cmdStop(ctx: Ctx, values: Values): Promise<number> {
  const srv = runningServer(ctx.paths);
  if (!srv) {
    ctx.out.result("skip", "memmem-server", "not running");
    ctx.out.data({ ok: true, running: false });
    return 0;
  }
  if (values["wait-reflection"]) {
    const t0 = Date.now();
    let busy = await reflectionsInFlight(ctx);
    if (busy.length) ctx.out.line(`Waiting for reflections to finish: ${busy.join(", ")} (up to 10 min)...`);
    while (busy.length && Date.now() - t0 < 10 * 60_000) {
      await sleep(5_000);
      busy = await reflectionsInFlight(ctx);
    }
    if (busy.length) ctx.out.result("warn", "reflection", `still in flight after 10 min: ${busy.join(", ")}; stopping anyway`);
    else ctx.out.result("ok", "reflection", `none in flight${Date.now() - t0 > 1000 ? ` (waited ${duration(Date.now() - t0)})` : ""}`);
  }
  const svc = await serviceActive(ctx);
  if (svc === "systemd") await ctx.run("systemctl", ["--user", "stop", `${SERVICE_NAME}.service`], { env: ctx.env, timeoutMs: 120_000 });
  else if (svc === "launchd") await ctx.run("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`], { env: ctx.env, timeoutMs: 120_000 });
  else process.kill(srv.pid, "SIGTERM");
  ctx.out.line(`Stopping memmem-server (pid ${srv.pid}${svc ? `, via ${svc}` : ""}); the worker finishes its current turn first...`);
  const stopped = await waitFor(() => !isAlive(srv.pid), 90_000, 500);
  if (!stopped) {
    ctx.out.result("warn", "memmem-server", `pid ${srv.pid} still running after 90 s`);
    return 1;
  }
  ctx.out.result("ok", "memmem-server", "stopped");
  ctx.out.data({ ok: true, stopped: srv.pid });
  return 0;
}

export async function cmdRestart(ctx: Ctx, values: Values): Promise<number> {
  const srv = runningServer(ctx.paths);
  if (srv && !values.hard) {
    const r = await requestReload(ctx, "restart");
    reportReload(ctx, r);
    ctx.out.data({ ok: r === "reloaded", result: r });
    return r === "reloaded" ? 0 : 1;
  }
  const svc = await serviceActive(ctx);
  if (svc === "systemd") {
    const r = await ctx.run("systemctl", ["--user", "restart", `${SERVICE_NAME}.service`], { env: ctx.env, timeoutMs: 180_000 });
    ctx.out.result(r.code === 0 ? "ok" : "fail", "systemd", r.code === 0 ? "restarted" : r.stderr.trim());
    return r.code === 0 ? 0 : 1;
  }
  if (svc === "launchd") {
    const r = await ctx.run("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`], { env: ctx.env, timeoutMs: 180_000 });
    ctx.out.result(r.code === 0 ? "ok" : "fail", "launchd", r.code === 0 ? "restarted" : r.stderr.trim());
    return r.code === 0 ? 0 : 1;
  }
  const port = srv?.runtime?.port ?? appServerPort(ctx.env);
  if (srv) {
    const code = await cmdStop(ctx, {});
    if (code !== 0) return code;
  }
  return startDetached(ctx, port);
}
