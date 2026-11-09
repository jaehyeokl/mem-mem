// init status | run | cancel --project p: project memory initialization
// (bootstrap/<member>/request.json from the client's `memmem init`).
// `run` and `cancel` go to the running worker as a request file (handled
// between passes); without a running server they run in this process.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { INIT_STATUS_PATH } from "../init.js";
import { setLogFile, setLogStdout } from "../log.js";
import { loadState, type InitRun, type ProjectState } from "../state.js";
import { normalizeUsage } from "../usage.js";
import { Worker, type InitActionResult, type WorkerRequest } from "../worker.js";
import { intOpt, str } from "./args.js";
import type { Ctx } from "./ctx.js";
import { CliError, UsageError, ago, duration, short } from "./io.js";
import { initRecordOf, renderInitMembers } from "./members.js";
import { findProject, readProjectsFile } from "./projects-file.js";
import { currentPort, runningServer, waitFor } from "./runtime.js";

type Values = Record<string, string | boolean | undefined>;

/** One-line-per-fact rendering of an init run (status and init status). */
export function renderInit(run: InitRun | null | undefined, now = Date.now()): string[] {
  if (!run) return ["init none"];
  const L: string[] = [];
  L.push(
    `init ${run.state} ${run.id}${run.kind ? ` ${run.kind}` : ""}  requested by ${run.requestedBy.join(", ") || "?"}  updated ${ago(run.updatedAt, now)}${run.durationMs !== undefined ? `  took ${duration(run.durationMs)}` : ""}`,
  );
  const usage = normalizeUsage(run.usage);
  const tok = usage ? `  tokens ${usage.total}` : "";
  L.push(`  sessions ${run.sessions} (~${run.estimatedTokens} history tokens)  answers ${run.answers}${run.conversationId ? `  conversation ${run.conversationId}` : ""}${tok}`);
  if (run.commits?.length) L.push(`  commits ${run.commits.map((c) => `${short(c.sha)} ${c.subject}`).join("; ")}`);
  if (run.question) L.push(`  question: ${run.question.replace(/\s+/g, " ").slice(0, 400)}`);
  if (run.error) L.push(`  error: ${run.error}`);
  return L;
}

function readStatusFile(ctx: Ctx, project: string): unknown {
  try {
    return JSON.parse(readFileSync(join(ctx.paths.reposDir, project, "transcripts", INIT_STATUS_PATH), "utf8"));
  } catch {
    return null;
  }
}

async function cmdInitStatus(ctx: Ctx, project: string): Promise<number> {
  const st: ProjectState = await loadState(ctx.paths.stateDir, project);
  const requests = st.initRequests ?? {};
  if (ctx.out.json) {
    ctx.out.data({ project, init: st.init ?? null, initProject: initRecordOf(ctx, project, st), requests, statusFile: readStatusFile(ctx, project) });
    return 0;
  }
  ctx.out.line(`${project}`);
  for (const l of renderInit(st.init)) ctx.out.line(`  ${l}`);
  for (const l of renderInitMembers(initRecordOf(ctx, project, st))) ctx.out.line(`  ${l}`);
  const marks = Object.entries(requests);
  if (marks.length) {
    ctx.out.line("  processed requests:");
    for (const [path, m] of marks) ctx.out.line(`    ${path}  ${m.outcome}  ${m.processedAt}${m.initId ? `  ${m.initId}` : ""}  blob ${short(m.blob)}`);
  }
  if (st.init?.state === "waiting_for_answer") ctx.out.line('  answer from a project checkout: memmem init --answer "<text>"');
  return 0;
}

function render(ctx: Ctx, r: InitActionResult | { ok: false; message: string }): void {
  if (ctx.out.json) {
    ctx.out.data(r);
    return;
  }
  if ("action" in r) {
    ctx.out.result(r.ok ? "ok" : "warn", `init ${r.action}`, `${r.state ?? "-"}${r.initId ? ` (${r.initId})` : ""}`);
    if (r.commits?.length) ctx.out.line(`  commits: ${r.commits.map((c) => `${short(c.sha)} ${c.subject}`).join("; ")}`);
    if (r.question) ctx.out.line(`  question: ${r.question}`);
    if (r.error) ctx.out.line(`  error: ${r.error}`);
  }
  if (r.message) ctx.out.line(`  ${r.message}`);
}

export async function cmdInit(ctx: Ctx, action: "status" | "run" | "cancel", v: Values): Promise<number> {
  const project = str(v.project);
  if (!project) throw new UsageError(`memmem-server init ${action} needs --project <name>`);
  findProject(readProjectsFile(ctx.paths), project);
  if (action === "status") return cmdInitStatus(ctx, project);
  const timeoutMs = intOpt(v.timeout, "timeout", action === "run" ? 120 : 90, 5) * 1000;
  const srv = runningServer(ctx.paths);
  let result: InitActionResult | { ok: false; message: string };
  if (srv) {
    mkdirSync(ctx.paths.requestsDir, { recursive: true });
    const req: WorkerRequest = { id: `${Date.now()}-${randomUUID().slice(0, 8)}`, kind: "init", project, action, createdAt: new Date().toISOString() };
    const file = join(ctx.paths.requestsDir, `${req.id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(req, null, 2) + "\n");
    renameSync(`${file}.tmp`, file);
    process.kill(srv.pid, "SIGUSR2");
    ctx.out.line(`Asked the running worker (pid ${srv.pid}) to ${action} the init of ${project}; it runs between passes.`);
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
      ctx.out.result("warn", `init ${action}`, `no answer after ${timeoutMs / 1000}s (a pass may be running); the result will be written to ${resultFile}`);
      return 1;
    }
    result = JSON.parse(readFileSync(resultFile, "utf8")) as InitActionResult;
    rmSync(resultFile, { force: true });
    if (action === "run" && result.ok) ctx.out.line(`Progress: memmem-server init status --project ${project}  (log: memmem-server logs -f -p ${project})`);
  } else {
    setLogFile(ctx.paths.workerLog);
    setLogStdout(false);
    const cfg = loadConfig(ctx.env);
    const worker = new Worker(() => cfg);
    try {
      if (action === "run") {
        const port = currentPort(ctx.paths, ctx.env);
        if (!(await ctx.readyz(port))) throw new CliError("memmem-server is not running and no App Server answers", "memmem-server start");
        ctx.env.MEMMEM_APP_SERVER_URL ??= `ws://127.0.0.1:${port}`;
        const cfg2 = loadConfig(ctx.env);
        ctx.out.line(`No memmem-server process; running the init here against ws://127.0.0.1:${port} (progress in ${ctx.paths.workerLog}); this can take up to settings.initTimeoutMinutes...`);
        result = await worker.initNow(cfg2, project, { force: true, wait: true });
      } else {
        result = await worker.cancelInit(cfg, project);
      }
    } finally {
      await worker.close();
    }
  }
  render(ctx, result);
  return result.ok ? 0 : 1;
}
