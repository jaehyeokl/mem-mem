// memmem-server project add: registers a project with this server, in order:
//   a. GitHub repos <owner>/mem-<p> and <owner>/mem-<p>-transcripts (unless URLs are given)
//   b. transcripts repo initial layout (templates/transcripts-repo) + project.json
//   c. Letta agent (+ model)
//   d. MemFS initial layout (templates/memory-repo/<language>)
//   e. letta.memoryRepository.url and first push
//   f. reflection model (<LETTA_CONFIG_DIR>/agents/reflection.md)
//   g. projects.json entry
//   h. reload the running App Server so it loads the new agent
// Idempotent: every step checks whether it is already done. --dry-run prints
// the plan and the commands without running anything.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LANGUAGE, isMemoryLanguage, languageName, MEMORY_LANGUAGES } from "../language.js";
import type { Ctx } from "./ctx.js";
import { showCmd, type RunResult } from "./exec.js";
import { CliError } from "./io.js";
import {
  DEFAULT_MODEL,
  createAgent,
  listAgents,
  memfsMemoryDir,
  readProviders,
  readReflectionModel,
  reflectionFile,
  setAgentModel,
  writeReflectionModel,
} from "./letta-cli.js";
import { readProjectsFile, upsertProject, writeProjectsFile, type ProjectEntry } from "./projects-file.js";
import { requestReload, reportReload, type ReloadResult } from "./runtime.js";
import { isExampleDecision, memoryTemplateDir, renderTree, resolveTemplatesDir, templateCandidates } from "./templates.js";

export const INIT_MSG = "chore(mem-mem): initialize team memory layout";
export const TRANSCRIPTS_INIT_MSG = "chore(mem-mem): initialize transcripts layout";
export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const DEFAULT_SUMMARY: Record<string, string> = {
  en: "(Write a one-line project summary here.)",
  ko: "(프로젝트 한 줄 요약을 여기에 쓴다.)",
};
/** The transcripts repo's project facts for clients (`memmem setup` reads the memory language from it). */
export const PROJECT_JSON = "project.json";
export const PROJECT_LAYOUT_VERSION = 1;

export interface ProjectDoc {
  project: string;
  language: string;
  layoutVersion: number;
  createdAt: string;
  [key: string]: unknown;
}

const isoNow = (now = new Date()) => now.toISOString().replace(/\.\d{3}Z$/, "Z");

/** project.json content; keeps unknown keys and createdAt of `prev`. */
export function projectDoc(project: string, language: string, createdAt: string, prev?: Record<string, unknown> | null): ProjectDoc {
  return {
    ...(prev ?? {}),
    project,
    language,
    layoutVersion: typeof prev?.layoutVersion === "number" ? prev.layoutVersion : PROJECT_LAYOUT_VERSION,
    createdAt: typeof prev?.createdAt === "string" ? prev.createdAt : createdAt,
  };
}

export function readProjectJson(dir: string): Record<string, unknown> | null {
  try {
    const doc = JSON.parse(readFileSync(join(dir, PROJECT_JSON), "utf8")) as unknown;
    return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function writeProjectJson(dir: string, doc: ProjectDoc): void {
  writeFileSync(join(dir, PROJECT_JSON), JSON.stringify(doc, null, 2) + "\n");
}

/** `--language` checked against the memory templates; absent means `fallback`. */
export function parseLanguage(value: string | undefined, fallback: string = DEFAULT_LANGUAGE): string {
  const lang = value ?? fallback;
  if (!isMemoryLanguage(lang)) throw new CliError(`--language must be one of ${MEMORY_LANGUAGES.join(", ")} (got ${JSON.stringify(lang)})`);
  return lang;
}

/** Render the transcripts repo's initial layout plus project.json into `dir`. Returns the files written. */
export function renderTranscriptsLayout(templates: string, dir: string, vars: Record<string, string>, doc: ProjectDoc): string[] {
  const files = renderTree(join(templates, "transcripts-repo"), dir, vars);
  writeProjectJson(dir, doc);
  return [...files.filter((f) => f !== PROJECT_JSON), PROJECT_JSON].sort();
}

/** Render the memory template for `language` (without the example decision) into `dir`. */
export function renderMemoryLayout(templates: string, language: string, dir: string, vars: Record<string, string>): string[] {
  const src = memoryTemplateDir(templates, language);
  if (!src) throw new CliError(`no memory template for language ${language} in ${join(templates, "memory-repo")}`);
  return renderTree(src, dir, vars, isExampleDecision);
}

export interface AddOptions {
  name: string;
  owner?: string;
  model?: string;
  reflectionModel?: string;
  forceReflectionModel?: boolean;
  summary?: string;
  /** Memory language (`en` | `ko`; default en, or the existing entry's). */
  language?: string;
  memoryRepo?: string;
  transcriptsRepo?: string;
  dryRun?: boolean;
  noReload?: boolean;
  skipProviderCheck?: boolean;
}

export interface AddResult {
  project: string;
  dryRun: boolean;
  agentId: string;
  agentCreated: boolean;
  memoryRepo: string;
  transcriptsRepo: string;
  model: string;
  reflectionModel: string;
  language: string;
  entry: ProjectEntry;
  reload: ReloadResult | "skipped" | "not_needed";
  commands: string[];
}

/** `owner/name` or a URL -> clone URL; GitHub URLs also give `owner/name` for gh. */
export function normalizeRepo(input: string): { url: string; slug: string | null } {
  const s = input.trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) return { url: `https://github.com/${s.replace(/\.git$/, "")}.git`, slug: s.replace(/\.git$/, "") };
  const m = s.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return { url: s, slug: m ? `${m[1]}/${m[2]}` : null };
}

export function repoPlan(name: string, owner: string, o: Pick<AddOptions, "memoryRepo" | "transcriptsRepo">) {
  const mem = o.memoryRepo ? normalizeRepo(o.memoryRepo) : normalizeRepo(`${owner}/mem-${name}`);
  const tr = o.transcriptsRepo ? normalizeRepo(o.transcriptsRepo) : normalizeRepo(`${owner}/mem-${name}-transcripts`);
  return { mem: { ...mem, given: !!o.memoryRepo }, tr: { ...tr, given: !!o.transcriptsRepo } };
}

export async function projectAdd(ctx: Ctx, o: AddOptions): Promise<AddResult> {
  const { out, paths } = ctx;
  const dry = !!o.dryRun;
  const name = o.name;
  if (!PROJECT_NAME_RE.test(name)) throw new CliError(`project name must match ${PROJECT_NAME_RE.source}`);
  const templates = resolveTemplatesDir(ctx.env);
  if (!templates) throw new CliError(`templates not found (looked in ${templateCandidates(ctx.env).join(", ")})`, "set MEMMEM_TEMPLATES to a directory with memory-repo/ and transcripts-repo/");
  const file = readProjectsFile(paths);
  const existing = file.projects.find((p) => p.project === name);
  const existingLanguage = existing ? (existing.language ?? DEFAULT_LANGUAGE) : undefined;
  const language = parseLanguage(o.language, existingLanguage);
  if (existingLanguage && language !== existingLanguage) {
    throw new CliError(`${name} already exists with memory language ${existingLanguage}`, `memmem-server project set-language ${name} ${language}`);
  }
  const memTemplate = memoryTemplateDir(templates, language);
  if (!memTemplate) throw new CliError(`no memory template for language ${language} in ${join(templates, "memory-repo")}`);
  const createdAt = existing?.createdAt ?? isoNow();
  const model = o.model ?? existing?.model ?? file.defaults?.model ?? DEFAULT_MODEL;
  const reflectionModel = o.reflectionModel ?? file.defaults?.reflectionModel ?? model;
  const commands: string[] = [];
  const env = { ...ctx.env, GIT_TERMINAL_PROMPT: "0" };

  const step = (title: string) => out.line(`\n== ${title}`);
  const note = (text: string) => out.line(`  ${text}`);
  /** Run a state-changing command; in dry-run only print it. */
  const exec = async (cmd: string, args: string[], opts: { cwd?: string; allowFail?: boolean; show?: string } = {}): Promise<RunResult> => {
    const shown = opts.show ?? showCmd(cmd, args);
    commands.push(shown);
    out.line(`  $ ${shown}`);
    if (dry) return { code: 0, stdout: "", stderr: "" };
    const r = await ctx.run(cmd, args, { env, cwd: opts.cwd ?? paths.home, timeoutMs: 300_000 });
    if (r.code !== 0 && !opts.allowFail) throw new CliError(`${shown} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 800)}`);
    return r;
  };
  /** A read-only check (skipped in dry-run, where every step is shown as needed). */
  const probe = async (cmd: string, args: string[], cwd?: string): Promise<RunResult | null> => {
    if (dry) return null;
    return ctx.run(cmd, args, { env, cwd: cwd ?? paths.home, timeoutMs: 120_000 });
  };

  if (dry) {
    out.line("DRY RUN: state-changing and network commands are printed, not executed.");
    out.line("DRY RUN: existence checks are skipped and every step is shown as if it were needed.");
  }

  // `letta model set` rejects handles of providers that are not connected:
  // fail before creating anything rather than leaving a half-configured project.
  if (!dry && !o.skipProviderCheck && !readProviders(paths).length) {
    throw new CliError("no model provider connected", "memmem-server provider connect chatgpt (or pass --skip-provider-check)");
  }

  const needCreate = !o.memoryRepo || !o.transcriptsRepo;
  let owner = o.owner ?? "";
  if (needCreate && !owner) {
    if (dry) owner = "<gh-user>";
    else {
      const r = await ctx.run("gh", ["api", "user", "--jq", ".login"], { env });
      if (r.code === 127) throw new CliError("gh is not installed", "pass --memory-repo and --transcripts-repo (create both repos yourself), or install gh and run memmem-server setup");
      if (r.code !== 0 || !r.stdout.trim()) throw new CliError(`cannot read the GitHub user: ${(r.stderr || r.stdout).trim()}`, "memmem-server setup (GitHub step), or pass --owner");
      owner = r.stdout.trim();
    }
  }
  const repos = repoPlan(name, owner, o);
  let summary = o.summary;
  if (summary === undefined && !dry && ctx.prompt.interactive && !ctx.yes && !existing) {
    summary = await ctx.prompt.ask("One-line project summary for project.md (optional)", "");
  }
  summary ||= DEFAULT_SUMMARY[language] ?? DEFAULT_SUMMARY.en!;
  const vars = {
    PROJECT_NAME: name,
    PROJECT_SUMMARY: summary,
    MEMORY_REPO: repos.mem.slug ?? repos.mem.url,
    TRANSCRIPTS_REPO: repos.tr.slug ?? repos.tr.url,
  };

  out.line(`project ${name}`);
  out.line(`  memory repo       ${repos.mem.url}${repos.mem.given ? " (given)" : ""}`);
  out.line(`  transcripts repo  ${repos.tr.url}${repos.tr.given ? " (given)" : ""}`);
  out.line(`  memory language   ${language} (${languageName(language)})`);
  out.line(`  model ${model}   reflection model ${reflectionModel} (server-wide)`);
  out.line(`  data ${paths.home}   letta ${paths.lettaConfigDir}`);
  if (!dry && ctx.prompt.interactive && !ctx.yes && !(await ctx.prompt.confirm("Proceed?", true))) throw new CliError("cancelled");

  const work = mkdtempSync(join(tmpdir(), "memmem-add-"));
  try {
    // a. GitHub repos.
    step("a. GitHub repos");
    for (const r of [repos.mem, repos.tr]) {
      if (r.given) {
        note(`using ${r.url}`);
        continue;
      }
      const view = await probe("gh", ["repo", "view", r.slug!, "--json", "name"]);
      if (view && view.code === 0) note(`exists: ${r.slug}`);
      else await exec("gh", ["repo", "create", r.slug!, "--private", "--description", `mem-mem team memory (${name})`]);
    }

    // b. Transcripts repo layout.
    step("b. transcripts repo layout");
    const heads = await probe("git", ["ls-remote", "--heads", repos.tr.url]);
    if (heads && heads.code === 0 && heads.stdout.trim()) {
      note(`transcripts repo already has commits; skipping (memmem-server project set-language ${name} ${language} writes ${PROJECT_JSON} if it is missing)`);
    } else {
      if (heads && heads.code !== 0) throw new CliError(`cannot read ${repos.tr.url}: ${heads.stderr.trim().slice(0, 500)}`, "check git credentials: memmem-server doctor");
      const tdir = join(work, "transcripts");
      if (!dry) {
        mkdirSync(tdir, { recursive: true });
        renderTranscriptsLayout(templates, tdir, vars, projectDoc(name, language, createdAt));
      } else note(`render ${join(templates, "transcripts-repo")} + ${PROJECT_JSON} (language ${language}) -> <tmp>/transcripts`);
      await exec("git", ["init", "-q", "-b", "main"], { cwd: tdir });
      await exec("git", ["add", "-A"], { cwd: tdir });
      await exec("git", [...(await identityArgs(ctx, dry)), "commit", "-q", "-m", TRANSCRIPTS_INIT_MSG], { cwd: tdir });
      await exec("git", ["push", "-q", repos.tr.url, "main:main"], { cwd: tdir });
    }

    // c. Letta agent.
    step("c. Letta agent");
    let agentId = existing?.agentId ?? "";
    let agentCreated = false;
    if (!dry) {
      const found = (await listAgents(ctx, name)).filter((a) => a.name === name);
      if (existing && !found.some((a) => a.id === existing.agentId)) {
        throw new CliError(`projects.json has agent ${existing.agentId} for ${name}, but Letta does not know it`, `check LETTA_CONFIG_DIR (${paths.lettaConfigDir})`);
      }
      agentId = existing?.agentId ?? found[0]?.id ?? "";
    }
    const createArgs = ["agents", "create", "--name", name, "--description", `mem-mem team memory: ${name}`, "--tags", `mem-mem,project:${name}`];
    if (agentId) {
      note(`agent exists: ${agentId}`);
    } else if (dry) {
      commands.push(showCmd("letta", ["--backend", "local", ...createArgs]));
      out.line(`  $ ${commands[commands.length - 1]}`);
      agentId = "<agent-id>";
    } else {
      out.line(`  $ ${showCmd("letta", ["--backend", "local", ...createArgs])}`);
      commands.push(showCmd("letta", ["--backend", "local", ...createArgs]));
      agentId = await createAgent(ctx, { name, description: `mem-mem team memory: ${name}`, tags: ["mem-mem", `project:${name}`] });
      agentCreated = true;
      note(`created agent: ${agentId}`);
    }
    // Setting the same model again is harmless: keeps projects.json and the agent in sync.
    const modelArgs = ["--backend", "local", "model", "set", model, "--reasoning", "low", "--agent", agentId];
    commands.push(showCmd("letta", modelArgs));
    out.line(`  $ ${showCmd("letta", modelArgs)}`);
    if (!dry) await setAgentModel(ctx, agentId, model, "low");

    // d. MemFS layout.
    step("d. MemFS layout");
    const memfs = dry ? join(paths.lettaConfigDir, "lc-local-backend", "memfs", agentId, "memory") : memfsMemoryDir(paths, agentId);
    if (!dry) {
      const isRepo = await probe("git", ["rev-parse", "--git-dir"], memfs);
      if (!existsSync(memfs) || !isRepo || isRepo.code !== 0) throw new CliError(`MemFS is not a git repo: ${memfs}`);
    }
    const done = await probe("git", ["log", "--format=%H", "--fixed-strings", `--grep=${INIT_MSG}`, "-n", "1", "main"], memfs);
    if (done && done.code === 0 && done.stdout.trim()) {
      note(`MemFS already initialized (${memfs})`);
    } else {
      const mdir = join(work, "memory");
      // Our persona.md / human.md / MEMORY.md replace Letta's generated ones:
      // the persona defines the ingest role, so the template wins.
      const files = dry ? [] : renderMemoryLayout(templates, language, mdir, vars);
      if (dry) note(`render ${memTemplate} (without decisions/EXAMPLE-*) into ${memfs}`);
      else {
        for (const f of files) {
          mkdirSync(join(memfs, f, ".."), { recursive: true });
          cpSync(join(mdir, f), join(memfs, f));
        }
        note(`installed ${files.length} files into ${memfs}`);
      }
      // Commit before setting the memory repository URL so Letta's post-commit hook does not push yet.
      await exec("git", ["add", "--", ...(dry ? ["<template files>"] : files)], { cwd: memfs });
      await exec("git", [...(await identityArgs(ctx, dry)), "commit", "-q", "-m", INIT_MSG], { cwd: memfs });
    }

    // e. Memory repo remote and first push. Letta's post-commit hook pushes only
    // direct commits on main; reflection merges are pushed by the worker.
    step("e. memory repo remote");
    await exec("git", ["config", "--local", "letta.memoryRepository.url", repos.mem.url], { cwd: memfs });
    const local = await probe("git", ["rev-parse", "refs/heads/main"], memfs);
    const remote = await probe("git", ["ls-remote", repos.mem.url, "refs/heads/main"], memfs);
    if (local && remote && local.code === 0 && remote.code === 0 && remote.stdout.split(/\s/)[0] === local.stdout.trim()) {
      note("memory repo already has MemFS main");
    } else {
      await exec("git", ["push", "-q", repos.mem.url, "main:main"], { cwd: memfs });
    }

    // f. Reflection model: Letta Code 0.34 reads it only from
    // <LETTA_CONFIG_DIR>/agents/reflection.md (frontmatter `model:`), for all agents.
    step("f. reflection model");
    const current = dry ? null : readReflectionModel(paths);
    let reflectionChanged = false;
    let effectiveReflection = reflectionModel;
    if (current === reflectionModel) {
      note(`reflection.md already uses ${reflectionModel}`);
    } else if (current && !o.forceReflectionModel && !o.reflectionModel) {
      note(`${reflectionFile(paths)} uses ${current}; keeping it (pass --reflection-model ${reflectionModel} --force-reflection-model to replace)`);
      effectiveReflection = current;
    } else if (current && !o.forceReflectionModel) {
      out.warn(`${reflectionFile(paths)} uses '${current}' (wanted '${reflectionModel}'); keeping it. Use --force-reflection-model to replace.`);
      effectiveReflection = current;
    } else {
      commands.push(`write ${reflectionFile(paths)} (model: ${reflectionModel})`);
      out.line(`  $ write ${reflectionFile(paths)} (model: ${reflectionModel})`);
      if (!dry) writeReflectionModel(paths, reflectionModel);
      reflectionChanged = true;
    }

    // g. projects.json.
    step(`g. projects.json (${paths.configPath})`);
    const entry: ProjectEntry = { project: name, agentId, memoryRepo: repos.mem.url, transcriptsRepo: repos.tr.url, model, language, createdAt };
    const merged = upsertProject(file, entry);
    const finalEntry = merged.projects.find((p) => p.project === name)!;
    if (dry) {
      out.line(`  $ write ${paths.configPath} (merged entry for ${name})`);
      out.line(JSON.stringify(finalEntry, null, 2).replace(/^/gm, "    "));
    } else {
      writeProjectsFile(paths, merged);
      note(`wrote entry for ${name}`);
    }

    // h. Reload the App Server: Letta's local backend reads agents (and their
    // models, and the reflection subagent config) only at startup.
    step("h. App Server");
    let reload: AddResult["reload"] = "not_needed";
    const changed = agentCreated || !existing || existing.model !== model || reflectionChanged;
    if (dry) {
      note("would reload the running App Server (if any) so it loads the agent");
      reload = "skipped";
    } else if (!changed) {
      note("nothing changed that the App Server needs to reload");
    } else if (o.noReload) {
      note("not reloading (--no-reload); run memmem-server restart before the worker's next pass");
      reload = "skipped";
    } else {
      reload = await requestReload(ctx, `project ${name} added`);
      reportReload(ctx, reload);
    }

    out.line("");
    out.line(dry ? `Dry run done. Run again without --dry-run to apply.` : `Done: ${name} -> agent ${agentId}. The worker picks it up on its next pass.`);
    if (!dry) {
      out.line("Teammates then run, in their checkout of the project:");
      out.line(`  memmem setup --project ${name} --memory-repo ${repos.mem.slug ?? repos.mem.url} --transcripts-repo ${repos.tr.slug ?? repos.tr.url} --member <name>`);
      out.line(`  (setup reads the memory language, ${language}, from the transcripts repo's ${PROJECT_JSON})`);
    }
    return { project: name, dryRun: dry, agentId, agentCreated, memoryRepo: repos.mem.url, transcriptsRepo: repos.tr.url, model, reflectionModel: effectiveReflection, language, entry: finalEntry, reload, commands };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** `-c user.name=... -c user.email=...` only when the server gitconfig has no identity. */
export async function identityArgs(ctx: Ctx, dry: boolean): Promise<string[]> {
  if (dry) return [];
  const n = await ctx.run("git", ["config", "--global", "user.name"], { env: ctx.env });
  const e = await ctx.run("git", ["config", "--global", "user.email"], { env: ctx.env });
  const out: string[] = [];
  if (n.code !== 0 || !n.stdout.trim()) out.push("-c", "user.name=mem-mem");
  if (e.code !== 0 || !e.stdout.trim()) out.push("-c", "user.email=mem-mem@localhost");
  return out;
}
