// reflect now | retry --project p: run the worker's reflection path once.
// With a running server the request goes to its worker (between passes, so
// it never races a pass over the same state file); otherwise, if an App
// Server answers, it runs in this process.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { setLogFile, setLogStdout } from "../log.js";
import { Worker, type ManualReflectMode, type ManualReflectResult, type WorkerRequest } from "../worker.js";
import { intOpt, str } from "./args.js";
import type { Ctx } from "./ctx.js";
import { CliError, UsageError, short } from "./io.js";
import { findProject, readProjectsFile } from "./projects-file.js";
import { currentPort, runningServer, waitFor } from "./runtime.js";

type Values = Record<string, string | boolean | undefined>;
type Result = ManualReflectResult | { ok: false; message: string; project?: string };

function render(ctx: Ctx, r: Result): void {
  if (ctx.out.json) {
    ctx.out.data(r);
    return;
  }
  if ("entries" in r) {
    for (const e of r.entries) {
      const files = Array.isArray(e.files) ? e.files.length : 0;
      ctx.out.result(
        e.outcome === "committed" || e.outcome === "nothing_to_save" ? "ok" : "warn",
        `reflection (${String(e.trigger)}${e.carriedForward ? ", carried forward" : ""})`,
        `${e.outcome}${e.reflectionCommit ? ` ${short(e.reflectionCommit as string)}` : ""}, ${files} file(s)`,
      );
    }
    if (r.pushed) ctx.out.result("ok", "memory pushed", short(r.pushed));
    ctx.out.line(`  unreflected ${r.unreflected}, carried forward ${r.pendingReflection}`);
  }
  if (r.message) ctx.out.line(`  ${r.message}`);
}

export async function cmdReflect(ctx: Ctx, mode: ManualReflectMode, v: Values): Promise<number> {
  const project = str(v.project);
  if (!project) throw new UsageError(`memmem-server reflect ${mode} needs --project <name>`);
  findProject(readProjectsFile(ctx.paths), project);
  const timeoutMs = intOpt(v.timeout, "timeout", 900, 10) * 1000;
  const srv = runningServer(ctx.paths);
  let result: Result;
  if (srv) {
    mkdirSync(ctx.paths.requestsDir, { recursive: true });
    const req: WorkerRequest = { id: `${Date.now()}-${randomUUID().slice(0, 8)}`, kind: "reflect", project, mode, createdAt: new Date().toISOString() };
    const file = join(ctx.paths.requestsDir, `${req.id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(req, null, 2) + "\n");
    renameSync(`${file}.tmp`, file);
    process.kill(srv.pid, "SIGUSR2");
    ctx.out.line(`Asked the running worker (pid ${srv.pid}) to reflect ${project} (${mode}); it runs between passes. Progress: memmem-server logs -f -p ${project}`);
    const resultFile = join(ctx.paths.requestsDir, `${req.id}.result.json`);
    const done = await waitFor(() => {
      try {
        readFileSync(resultFile);
        return true;
      } catch {
        return false;
      }
    }, timeoutMs, 1_000);
    if (!done) {
      ctx.out.result("warn", "reflect", `no result after ${timeoutMs / 1000}s; the request stays queued and its result will be written to ${resultFile}`);
      return 1;
    }
    result = JSON.parse(readFileSync(resultFile, "utf8")) as Result;
    rmSync(resultFile, { force: true });
  } else {
    const port = currentPort(ctx.paths, ctx.env);
    if (!(await ctx.readyz(port))) throw new CliError("memmem-server is not running and no App Server answers", "memmem-server start");
    ctx.env.MEMMEM_APP_SERVER_URL ??= `ws://127.0.0.1:${port}`;
    setLogFile(ctx.paths.workerLog);
    setLogStdout(false);
    ctx.out.line(`No memmem-server process; running the reflection here against ws://127.0.0.1:${port} (progress in ${ctx.paths.workerLog})...`);
    const cfg = loadConfig(ctx.env);
    const worker = new Worker(() => cfg);
    try {
      result = await worker.reflectOnce(cfg, project, mode);
    } finally {
      await worker.close();
    }
  }
  render(ctx, result);
  return result.ok ? 0 : 1;
}
