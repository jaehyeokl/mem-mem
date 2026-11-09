// project add | list | show | set-language | pause | resume | remove
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LANGUAGE, languageName } from "../language.js";
import { loadState, statePath } from "../state.js";
import { str } from "./args.js";
import type { Ctx } from "./ctx.js";
import { CliError } from "./io.js";
import { identityArgs, normalizeRepo, parseLanguage, PROJECT_JSON, projectAdd, projectDoc, readProjectJson, writeProjectJson } from "./project-add.js";
import { findProject, readProjectsFile, writeProjectsFile } from "./projects-file.js";
import { projectStatus, renderProject } from "./status.js";

type Values = Record<string, string | boolean | undefined>;

export async function cmdProjectAdd(ctx: Ctx, name: string, v: Values): Promise<number> {
  const result = await projectAdd(ctx, {
    name,
    owner: str(v.owner),
    model: str(v.model),
    reflectionModel: str(v["reflection-model"]),
    forceReflectionModel: v["force-reflection-model"] === true,
    summary: str(v.summary),
    language: str(v.language),
    memoryRepo: str(v["memory-repo"]),
    transcriptsRepo: str(v["transcripts-repo"]),
    dryRun: v["dry-run"] === true,
    noReload: v["no-reload"] === true,
    skipProviderCheck: v["skip-provider-check"] === true,
  });
  ctx.out.data(result);
  return 0;
}

export async function cmdProjectList(ctx: Ctx): Promise<number> {
  const file = readProjectsFile(ctx.paths);
  if (ctx.out.json) {
    ctx.out.data({ configPath: ctx.paths.configPath, settings: file.settings, defaults: file.defaults ?? {}, projects: file.projects });
    return 0;
  }
  if (!file.projects.length) {
    ctx.out.line(`No projects in ${ctx.paths.configPath}. Add one: memmem-server project add <name>`);
    return 0;
  }
  const head = ["PROJECT", "STATE", "LANG", "AGENT", "MODEL"];
  const rows = file.projects.map((p) => [p.project, p.enabled === false ? "paused" : "enabled", p.language ?? DEFAULT_LANGUAGE, p.agentId, p.model ?? "-", normalizeRepo(p.memoryRepo).slug ?? p.memoryRepo]);
  const widths = head.map((h, i) => Math.max(...rows.map((r) => r[i]!.length), h.length));
  const fmt = (r: string[]) => r.map((c, i) => (i < head.length ? c.padEnd(widths[i]!) : c)).join("  ");
  ctx.out.line(fmt([...head, "MEMORY REPO"]));
  for (const r of rows) ctx.out.line(fmt(r));
  return 0;
}

export async function cmdProjectShow(ctx: Ctx, name: string): Promise<number> {
  const file = readProjectsFile(ctx.paths);
  const p = findProject(file, name);
  const st = await loadState(ctx.paths.stateDir, name);
  const status = projectStatus(p, st);
  if (ctx.out.json) {
    ctx.out.data({ entry: p, status, stateFile: statePath(ctx.paths.stateDir, name) });
    return 0;
  }
  ctx.out.line(renderProject(status, Date.now()).join("\n"));
  const lang = p.language ?? DEFAULT_LANGUAGE;
  ctx.out.line(`  memory language ${lang} (${languageName(lang)})`);
  ctx.out.line(`  memory repo ${p.memoryRepo}`);
  ctx.out.line(`  transcripts repo ${p.transcriptsRepo}`);
  if (p.createdAt) ctx.out.line(`  created ${p.createdAt}`);
  ctx.out.line(`  state file ${statePath(ctx.paths.stateDir, name)}`);
  return 0;
}

/**
 * Change the project's memory language: projects.json (the worker reads it at
 * its next pass) and the transcripts repo's project.json (clients read it in
 * `memmem setup` and `memmem doctor`). Existing memory is not translated.
 */
export async function cmdProjectSetLanguage(ctx: Ctx, name: string, value: string): Promise<number> {
  const language = parseLanguage(value);
  const file = readProjectsFile(ctx.paths);
  const p = findProject(file, name);
  const before = p.language ?? DEFAULT_LANGUAGE;
  if (p.language === language) ctx.out.result("skip", "projects.json", `${name} already uses ${language}`);
  else {
    p.language = language;
    writeProjectsFile(ctx.paths, file);
    ctx.out.result("ok", "projects.json", `${name}: ${before} -> ${language}; the worker applies it at its next pass`);
  }
  const pushed = await pushProjectJson(ctx, p.transcriptsRepo, projectDocFor(name, language, p.createdAt));
  if (pushed.ok) ctx.out.result(pushed.changed ? "ok" : "skip", PROJECT_JSON, pushed.changed ? `pushed to ${p.transcriptsRepo}` : `already says ${language}`);
  else ctx.out.result("fail", PROJECT_JSON, `${pushed.error} (run the command again once the transcripts repo is reachable)`);
  ctx.out.line(`Note: existing memory text is not translated; reflections from now on write ${languageName(language)}.`);
  ctx.out.line(`Teammates: \`memmem doctor\` warns while .memmem/config.json says another language; \`memmem setup --language ${language}\` updates it (commit the file).`);
  ctx.out.data({ ok: pushed.ok, project: name, language, previous: before, projectJson: pushed.ok ? (pushed.changed ? "pushed" : "unchanged") : "failed" });
  return pushed.ok ? 0 : 1;
}

function projectDocFor(name: string, language: string, createdAt: string | undefined) {
  return (prev: Record<string, unknown> | null) => projectDoc(name, language, createdAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), prev);
}

/** Clone the transcripts repo into a temp dir, write project.json, commit and push when it changed. */
async function pushProjectJson(
  ctx: Ctx,
  repo: string,
  build: (prev: Record<string, unknown> | null) => ReturnType<typeof projectDoc>,
): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
  const env = { ...ctx.env, GIT_TERMINAL_PROMPT: "0" };
  const work = mkdtempSync(join(tmpdir(), "memmem-lang-"));
  const dir = join(work, "transcripts");
  const git = (args: string[], timeoutMs = 120_000) => ctx.run("git", args, { env, cwd: dir, timeoutMs });
  const fail = (what: string, r: { stderr: string; stdout: string }) => ({ ok: false as const, error: `${what}: ${(r.stderr || r.stdout).trim().split("\n")[0] ?? ""}` });
  try {
    const c = await ctx.run("git", ["clone", "--quiet", "--no-tags", repo, dir], { env, cwd: work, timeoutMs: 600_000 });
    if (c.code !== 0) return fail(`cannot clone ${repo}`, c);
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch.code !== 0 || !branch.stdout.trim() || branch.stdout.trim() === "HEAD") return fail(`${repo} has no branch (empty repository?)`, branch);
    const prev = readProjectJson(dir);
    const doc = build(prev);
    if (prev && JSON.stringify(prev) === JSON.stringify(doc)) return { ok: true, changed: false };
    writeProjectJson(dir, doc);
    const add = await git(["add", "--", PROJECT_JSON]);
    if (add.code !== 0) return fail("git add failed", add);
    const commit = await git([...(await identityArgs(ctx, false)), "commit", "--quiet", "--no-verify", "-m", `chore(mem-mem): memory language ${doc.language}`]);
    if (commit.code !== 0) return fail("git commit failed", commit);
    const push = await git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch.stdout.trim()}`], 300_000);
    if (push.code !== 0) return fail(`push to ${repo} failed`, push);
    return { ok: true, changed: true };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function cmdProjectEnable(ctx: Ctx, name: string, enabled: boolean): Promise<number> {
  const file = readProjectsFile(ctx.paths);
  const p = findProject(file, name);
  const was = p.enabled !== false;
  if (was === enabled) {
    ctx.out.result("skip", name, `already ${enabled ? "enabled" : "paused"}`);
  } else {
    if (enabled) delete p.enabled;
    else p.enabled = false;
    writeProjectsFile(ctx.paths, file);
    ctx.out.result("ok", name, `${enabled ? "resumed" : "paused"}; the worker applies it at its next pass`);
  }
  ctx.out.data({ ok: true, project: name, enabled });
  return 0;
}

export async function cmdProjectRemove(ctx: Ctx, name: string, v: Values): Promise<number> {
  const file = readProjectsFile(ctx.paths);
  const p = findProject(file, name);
  const deleteRepos = v["delete-repos"] === true;
  if (!ctx.yes) {
    if (!ctx.prompt.interactive) throw new CliError("removing a project needs confirmation", "pass --yes");
    if (!(await ctx.prompt.confirm(`Unregister ${name} and delete its local worker state? (GitHub repos ${deleteRepos ? "WILL BE DELETED" : "are kept"})`, false))) return 1;
  }
  const slugs = [normalizeRepo(p.memoryRepo).slug, normalizeRepo(p.transcriptsRepo).slug];
  if (deleteRepos) {
    if (slugs.some((s) => !s)) throw new CliError("--delete-repos works only for GitHub repos");
    const typed = str(v.confirm) ?? (ctx.prompt.interactive ? await ctx.prompt.ask(`Type the project name (${name}) to delete ${slugs.join(" and ")} on GitHub`) : "");
    if (typed !== name) throw new CliError("confirmation did not match; nothing was deleted", `pass --confirm ${name} to delete the repos without a prompt`);
  }
  writeProjectsFile(ctx.paths, { ...file, projects: file.projects.filter((x) => x.project !== name) });
  ctx.out.result("ok", "projects.json", `removed ${name}`);
  rmSync(statePath(ctx.paths.stateDir, name), { force: true });
  rmSync(join(ctx.paths.cwdBase, name), { recursive: true, force: true });
  ctx.out.result("ok", "worker state", `deleted state/${name}.json and agentcwd/${name}`);
  if (v["keep-repos"]) ctx.out.result("skip", "local clone", `kept ${join(ctx.paths.reposDir, name)}`);
  else {
    rmSync(join(ctx.paths.reposDir, name), { recursive: true, force: true });
    ctx.out.result("ok", "local clone", `deleted repos/${name}`);
  }
  const deleted: string[] = [];
  if (deleteRepos) {
    for (const slug of slugs as string[]) {
      const r = await ctx.run("gh", ["repo", "delete", slug, "--yes"], { env: ctx.env, timeoutMs: 60_000 });
      if (r.code === 0) {
        deleted.push(slug);
        ctx.out.result("ok", "GitHub", `deleted ${slug}`);
      } else ctx.out.result("fail", "GitHub", `could not delete ${slug}: ${(r.stderr || r.stdout).trim()} (gh needs the delete_repo scope: gh auth refresh -s delete_repo)`);
    }
  } else {
    ctx.out.result("info", "GitHub", `kept ${slugs.filter(Boolean).join(" and ") || "the repos"}`);
  }
  ctx.out.line(`The Letta agent ${p.agentId} and its MemFS stay in ${ctx.paths.lettaConfigDir}; nothing uses them now.`);
  ctx.out.data({ ok: true, removed: name, deletedRepos: deleted });
  return 0;
}
