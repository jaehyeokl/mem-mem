// model list | set <handle> [--project p] | set-reflection <handle>
import { str } from "./args.js";
import type { Ctx } from "./ctx.js";
import { CliError } from "./io.js";
import { DEFAULT_MODEL, listModels, readReflectionModel, reflectionFile, setAgentModel, uniqueHandles, writeReflectionModel } from "./letta-cli.js";
import { findProject, readProjectsFile, writeProjectsFile } from "./projects-file.js";
import { reportReload, requestReload } from "./runtime.js";

type Values = Record<string, string | boolean | undefined>;

export async function cmdModelList(ctx: Ctx): Promise<number> {
  const file = readProjectsFile(ctx.paths);
  const configured = {
    default: file.defaults?.model ?? null,
    reflection: readReflectionModel(ctx.paths),
    projects: Object.fromEntries(file.projects.map((p) => [p.project, p.model ?? null])),
  };
  const models = await listModels(ctx);
  const handles = models ? uniqueHandles(models) : null;
  if (ctx.out.json) {
    ctx.out.data({ models: handles, configured });
    return 0;
  }
  if (!handles) ctx.out.warn("`letta model list` failed (is a provider connected?); showing the configured handles only");
  else if (!handles.length) ctx.out.line("No models: connect a provider first (memmem-server provider connect chatgpt).");
  else {
    ctx.out.line("Available (letta model list):");
    for (const m of handles) {
      const tags: string[] = [];
      if (m.handle === configured.default) tags.push("default");
      if (m.handle === configured.reflection) tags.push("reflection");
      for (const [p, h] of Object.entries(configured.projects)) if (h === m.handle) tags.push(p);
      ctx.out.line(`  ${m.handle}${m.label ? `  (${m.label})` : ""}${tags.length ? `  <- ${tags.join(", ")}` : ""}`);
    }
  }
  ctx.out.line("");
  ctx.out.line(`Default for new projects: ${configured.default ?? `${DEFAULT_MODEL} (built-in)`}`);
  ctx.out.line(`Reflection (server-wide): ${configured.reflection ?? "not set (Letta's default)"}`);
  for (const [p, h] of Object.entries(configured.projects)) ctx.out.line(`Project ${p}: ${h ?? "-"}`);
  return 0;
}

export async function cmdModelSet(ctx: Ctx, handle: string, v: Values): Promise<number> {
  const file = readProjectsFile(ctx.paths);
  const only = str(v.project);
  const reasoning = str(v.reasoning) ?? "low";
  const targets = only ? [findProject(file, only)] : file.projects;
  if (!only && targets.length && !ctx.yes) {
    const ok = await ctx.prompt.confirm(`Set ${handle} for all ${targets.length} project(s) and as the default for new ones?`, true);
    if (!ok) return 1;
  }
  for (const p of targets) {
    await setAgentModel(ctx, p.agentId, handle, reasoning);
    p.model = handle;
    ctx.out.result("ok", p.project, `agent ${p.agentId} now uses ${handle} (reasoning ${reasoning})`);
  }
  if (!only) {
    file.defaults = { ...(file.defaults ?? {}), model: handle };
    ctx.out.result("ok", "default", `${handle} for new projects`);
  }
  writeProjectsFile(ctx.paths, file);
  if (targets.length) reportReload(ctx, await requestReload(ctx, `model set to ${handle}`));
  ctx.out.data({ ok: true, model: handle, projects: targets.map((p) => p.project), default: !only });
  return 0;
}

export async function cmdModelSetReflection(ctx: Ctx, handle: string): Promise<number> {
  if (!/^\S+$/.test(handle)) throw new CliError("model handle must not contain spaces");
  const current = readReflectionModel(ctx.paths);
  if (current === handle) {
    ctx.out.result("skip", "reflection model", `already ${handle}`);
  } else {
    writeReflectionModel(ctx.paths, handle);
    ctx.out.result("ok", "reflection model", `${handle} (${reflectionFile(ctx.paths)})`);
  }
  const file = readProjectsFile(ctx.paths);
  file.defaults = { ...(file.defaults ?? {}), reflectionModel: handle };
  writeProjectsFile(ctx.paths, file);
  ctx.out.line(
    "Server-wide: Letta Code 0.34 resolves the reflection subagent's model only from <LETTA_CONFIG_DIR>/agents/reflection.md; its per-agent reflectionSettingsByAgent holds trigger, step count and merge settings, not a model.",
  );
  if (current !== handle) reportReload(ctx, await requestReload(ctx, "reflection model changed"));
  ctx.out.data({ ok: true, reflectionModel: handle, scope: "server" });
  return 0;
}
