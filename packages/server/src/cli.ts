// memmem-server CLI entry (bin/memmem-server.js -> main()).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "./config.js";
import { applyServerEnv } from "./paths.js";
import { helpText, parseCommandLine } from "./cli/args.js";
import { doctorChecks, failed, renderChecks } from "./cli/checks.js";
import { defaultReadyz, type Ctx } from "./cli/ctx.js";
import { defaultRunner } from "./cli/exec.js";
import { CliError, UsageError, createOutput, createPrompter, isInteractive, statusTag } from "./cli/io.js";
import { cmdInit } from "./cli/init.js";
import { cmdLogs } from "./cli/logs.js";
import { cmdMembers } from "./cli/members.js";
import { cmdModelList, cmdModelSet, cmdModelSetReflection } from "./cli/model.js";
import { cmdProjectAdd, cmdProjectEnable, cmdProjectList, cmdProjectRemove, cmdProjectSetLanguage, cmdProjectShow } from "./cli/project.js";
import { cmdProviderConnect, cmdProviderDisconnect, cmdProviderList } from "./cli/provider.js";
import { cmdReflect } from "./cli/reflect.js";
import { cmdSetup } from "./cli/setup.js";
import { cmdStatus } from "./cli/status.js";
import { cmdRestart, cmdStart, cmdStop } from "./cli/supervisor.js";
import { cmdUsage } from "./cli/usage.js";
import { packageRoot } from "./cli/templates.js";

export function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

type Values = Record<string, string | boolean | undefined>;

async function cmdDoctor(ctx: Ctx): Promise<number> {
  const checks = await doctorChecks(ctx);
  const bad = failed(checks);
  if (ctx.out.json) ctx.out.data({ ok: bad.length === 0, checks });
  else {
    ctx.out.line(renderChecks(checks, statusTag));
    ctx.out.line("");
    ctx.out.line(bad.length ? `${bad.length} critical problem(s).` : "No critical problems.");
  }
  return bad.length ? 1 : 0;
}

export async function dispatch(ctx: Ctx, name: string, v: Values, pos: string[]): Promise<number> {
  switch (name) {
    case "setup":
      return cmdSetup(ctx, v);
    case "doctor":
      return cmdDoctor(ctx);
    case "start":
      return cmdStart(ctx, v);
    case "stop":
      return cmdStop(ctx, v);
    case "restart":
      return cmdRestart(ctx, v);
    case "status":
      return cmdStatus(ctx, v);
    case "project add":
      return cmdProjectAdd(ctx, pos[0]!, v);
    case "project list":
      return cmdProjectList(ctx);
    case "project show":
      return cmdProjectShow(ctx, pos[0]!);
    case "project set-language":
      return cmdProjectSetLanguage(ctx, pos[0]!, pos[1]!);
    case "project pause":
      return cmdProjectEnable(ctx, pos[0]!, false);
    case "project resume":
      return cmdProjectEnable(ctx, pos[0]!, true);
    case "project remove":
      return cmdProjectRemove(ctx, pos[0]!, v);
    case "model list":
      return cmdModelList(ctx);
    case "model set":
      return cmdModelSet(ctx, pos[0]!, v);
    case "model set-reflection":
      return cmdModelSetReflection(ctx, pos[0]!);
    case "provider list":
      return cmdProviderList(ctx);
    case "provider connect":
      return cmdProviderConnect(ctx, pos[0]!, v);
    case "provider disconnect":
      return cmdProviderDisconnect(ctx, pos[0]!);
    case "reflect now":
      return cmdReflect(ctx, "now", v);
    case "reflect retry":
      return cmdReflect(ctx, "retry", v);
    case "init status":
      return cmdInit(ctx, "status", v);
    case "init run":
      return cmdInit(ctx, "run", v);
    case "init cancel":
      return cmdInit(ctx, "cancel", v);
    case "members":
      return cmdMembers(ctx, v);
    case "logs":
      return cmdLogs(ctx, v);
    case "usage":
      return cmdUsage(ctx, v);
    case "version":
      ctx.out.json ? ctx.out.data({ version: ctx.version }) : ctx.out.line(ctx.version);
      return 0;
    default:
      throw new UsageError(`unknown command: ${name}`);
  }
}

export async function main(argv: string[]): Promise<number> {
  const version = packageVersion();
  let parsed;
  try {
    parsed = parseCommandLine(argv);
    if (parsed.kind === "help") {
      process.stdout.write(helpText(parsed.topic, version) + "\n");
      return 0;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`memmem-server: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  if (parsed.kind === "version") {
    process.stdout.write(version + "\n");
    return 0;
  }
  const { spec, values, positionals } = parsed.cmd;
  if (typeof values.home === "string") process.env.MEMMEM_SERVER_HOME = values.home;
  const paths = applyServerEnv(process.env);
  const json = values.json === true;
  const ctx: Ctx = {
    env: process.env,
    paths,
    out: createOutput(json),
    prompt: createPrompter(isInteractive() && values.yes !== true),
    run: defaultRunner,
    yes: values.yes === true,
    readyz: defaultReadyz,
    version,
  };
  try {
    return await dispatch(ctx, spec.name, values, positionals);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`memmem-server: ${err.message}\n`);
      return 2;
    }
    if (err instanceof CliError || err instanceof ConfigError) {
      process.stderr.write(`memmem-server ${spec.name}: ${err.message}\n`);
      if (err instanceof CliError && err.hint) process.stderr.write(`  hint: ${err.hint}\n`);
      if (json) process.stdout.write(JSON.stringify({ ok: false, error: err.message, hint: err instanceof CliError ? err.hint : undefined }) + "\n");
      return 1;
    }
    throw err;
  }
}
