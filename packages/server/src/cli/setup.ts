// memmem-server setup: resumable wizard. Every step checks first and is
// skipped when already done, so running it again is safe.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { str } from "./args.js";
import { failed, ghLogin, gitAuth, gitIdentity, hasGh, renderChecks, toolChecks } from "./checks.js";
import type { Ctx } from "./ctx.js";
import { relay } from "./exec.js";
import { CliError, statusTag, type Status } from "./io.js";
import { DEFAULT_MODEL, listModels, readProviders, readReflectionModel, uniqueHandles, writeReflectionModel } from "./letta-cli.js";
import { readProjectsFile, writeProjectsFile } from "./projects-file.js";
import { API_KEY_PROVIDERS, connectProvider, readStdin } from "./provider.js";
import { reportReload, requestReload } from "./runtime.js";

type Values = Record<string, string | boolean | undefined>;

export function ensureDataDirs(ctx: Ctx): void {
  const p = ctx.paths;
  for (const d of [p.home, p.lettaConfigDir, p.stateDir, p.reposDir, p.cwdBase, p.logsDir]) mkdirSync(d, { recursive: true });
}

async function gitConfig(ctx: Ctx, args: string[]): Promise<void> {
  const r = await ctx.run("git", ["config", "--global", ...args], { env: ctx.env });
  if (r.code !== 0) throw new CliError(`git config --global ${args.join(" ")} failed: ${r.stderr.trim()}`);
}

interface StepResult {
  step: string;
  status: Status;
  detail: string;
}

export async function cmdSetup(ctx: Ctx, values: Values): Promise<number> {
  const { out, paths, prompt } = ctx;
  const results: StepResult[] = [];
  const record = (step: string, status: Status, detail: string) => {
    results.push({ step, status, detail });
    out.result(status, step, detail);
  };
  out.line(`memmem-server setup`);
  out.line(`  data: ${paths.home}`);
  out.line(`  letta: ${paths.lettaConfigDir}   gitconfig: ${paths.gitConfig}`);
  out.line("");

  // 1. Tools.
  out.line("1. Checks");
  const tools = await toolChecks(ctx);
  out.line(renderChecks(tools, statusTag));
  if (failed(tools).length) {
    out.line("");
    out.line("Install the missing tools, then run `memmem-server setup` again:");
    for (const c of failed(tools)) out.line(`  ${c.fix}`);
    out.data({ ok: false, step: "checks", checks: tools });
    return 1;
  }
  const gh = hasGh(tools);

  // 2. Data dir and git identity (server-scoped gitconfig).
  out.line("");
  out.line("2. Data directory and git identity");
  ensureDataDirs(ctx);
  record("data dir", "ok", paths.home);
  const id = await gitIdentity(ctx);
  if (id.name && id.email) {
    record("git identity", "skip", `already set: ${id.name} <${id.email}>`);
  } else {
    const name = str(values["git-name"]) ?? (await prompt.ask("Git user.name for commits the server makes", id.name ?? "mem-mem"));
    const email = str(values["git-email"]) ?? (await prompt.ask("Git user.email", id.email ?? "mem-mem@localhost"));
    await gitConfig(ctx, ["user.name", name]);
    await gitConfig(ctx, ["user.email", email]);
    record("git identity", "ok", `${name} <${email}> in ${paths.gitConfig}`);
  }

  // 3. GitHub.
  out.line("");
  out.line("3. GitHub");
  const auth = await gitAuth(ctx);
  const mode = str(values.github);
  if (mode && !["gh", "token", "skip"].includes(mode)) throw new CliError("--github must be gh, token or skip");
  if (gh && mode !== "token" && mode !== "skip") {
    let login = await ghLogin(ctx);
    if (login.ok) {
      record("gh login", "skip", login.detail);
    } else {
      out.line("gh is not logged in. Starting `gh auth login` (device code). Open the URL and enter the code:");
      const code = await relay("gh", ["auth", "login", "-h", "github.com", "-p", "https", "-w"], { env: ctx.env, input: "Y\n\n" });
      login = await ghLogin(ctx);
      if (code !== 0 || !login.ok) throw new CliError(`gh auth login did not finish (exit ${code}): ${login.detail}`, "run memmem-server setup again");
      record("gh login", "ok", login.detail);
    }
    if (auth.helper === "gh") {
      record("git credentials", "skip", "gh credential helper already in the server gitconfig");
    } else {
      const r = await ctx.run("gh", ["auth", "setup-git", "-h", "github.com"], { env: ctx.env });
      if (r.code !== 0) throw new CliError(`gh auth setup-git failed: ${(r.stderr || r.stdout).trim()}`);
      record("git credentials", "ok", `gh credential helper written to ${paths.gitConfig}`);
    }
  } else if (auth.helper && mode !== "token") {
    record("git credentials", "skip", auth.detail);
  } else {
    const choice =
      mode ??
      (await prompt.choose(
        gh ? "How should the server authenticate to GitHub?" : "gh is not installed. How should the server authenticate to GitHub?",
        [
          { value: "token", label: "Paste a GitHub token (stored mode 0600 in the data dir; repos with `repo` scope)" },
          { value: "skip", label: "Skip: I will create repos myself and set up git credentials (e.g. SSH URLs)" },
        ],
        "skip",
      ));
    if (choice === "token") {
      const token = values["token-stdin"] ? await readStdin() : await prompt.secret("GitHub token");
      if (!token) throw new CliError("empty token");
      writeFileSync(paths.gitCredentials, `https://x-access-token:${token}@github.com\n`, { mode: 0o600 });
      chmodSync(paths.gitCredentials, 0o600);
      await gitConfig(ctx, ["--replace-all", "credential.https://github.com.helper", `store --file ${paths.gitCredentials}`]);
      let who = "";
      try {
        const res = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, "User-Agent": "memmem-server" }, signal: AbortSignal.timeout(10_000) });
        who = res.ok ? `, token belongs to ${((await res.json()) as { login?: string }).login}` : `, GitHub answered ${res.status} for this token`;
      } catch {
        who = ", could not verify the token (offline?)";
      }
      record("git credentials", "ok", `token store ${paths.gitCredentials}${who}`);
      if (!gh) out.line("        note: without gh, `project add` needs --memory-repo and --transcripts-repo (create the repos on GitHub first)");
    } else {
      record("git credentials", "skip", "skipped; create repos yourself and pass --memory-repo/--transcripts-repo to project add");
    }
  }

  // 4. Model provider.
  out.line("");
  out.line("4. Model provider");
  let providers = readProviders(paths);
  const want = str(values.provider);
  if (providers.length && !want) {
    record("provider", "skip", `connected: ${providers.map((p) => `${p.name} (${p.type})`).join(", ")}`);
  } else if (want === "skip") {
    record("provider", "skip", "skipped; turns and reflections fail until one is connected (memmem-server provider connect chatgpt)");
  } else {
    const choice =
      want ??
      (await prompt.choose(
        "Which model provider should the server use?",
        [
          { value: "chatgpt", label: "ChatGPT (Codex) login, device code" },
          { value: "apikey", label: "An API-key provider (Anthropic, OpenAI, Gemini, OpenRouter, ...)" },
          { value: "skip", label: "Skip for now" },
        ],
        "chatgpt",
      ));
    if (choice === "skip") {
      record("provider", "skip", "skipped");
    } else {
      const name = choice === "apikey" ? await prompt.choose("Provider", API_KEY_PROVIDERS.map((p) => ({ value: p, label: p })), "anthropic") : choice;
      const ok = await connectProvider(ctx, name, { apiKeyStdin: values["api-key-stdin"] === true });
      providers = readProviders(paths);
      if (!ok) throw new CliError(`no provider connected after letta connect ${name}`);
      record("provider", "ok", `connected: ${providers.map((p) => `${p.name} (${p.type})`).join(", ")}`);
    }
  }

  // 5. Models: default agent model and the reflection model.
  out.line("");
  out.line("5. Models");
  const file = readProjectsFile(paths);
  file.defaults ??= {};
  let model = str(values.model) ?? file.defaults.model;
  if (!model) {
    const handles = providers.length ? uniqueHandles((await listModels(ctx)) ?? []).map((m) => m.handle) : [];
    const def = handles.includes(DEFAULT_MODEL) || providers.some((p) => p.type === "chatgpt_oauth") || !handles.length ? DEFAULT_MODEL : handles[0]!;
    model =
      prompt.interactive && handles.length > 1
        ? await prompt.choose("Default model for new project agents", handles.slice(0, 40).map((h) => ({ value: h, label: h })), handles.includes(def) ? def : handles[0])
        : def;
    record("default model", "ok", model);
  } else {
    record("default model", file.defaults.model === model ? "skip" : "ok", model);
  }
  file.defaults.model = model;
  const reflection = str(values["reflection-model"]) ?? file.defaults.reflectionModel ?? model;
  const current = readReflectionModel(paths);
  let reflectionChanged = false;
  if (current === reflection) {
    record("reflection model", "skip", `${reflection} (already in ${join(paths.lettaConfigDir, "agents", "reflection.md")})`);
  } else if (current && !values["reflection-model"] && !(await prompt.confirm(`reflection.md uses ${current}. Replace it with ${reflection}?`, false))) {
    record("reflection model", "skip", `kept ${current}`);
  } else {
    writeReflectionModel(paths, reflection);
    reflectionChanged = true;
    record("reflection model", "ok", `${reflection} (server-wide)`);
  }
  file.defaults.reflectionModel = readReflectionModel(paths) ?? reflection;
  writeProjectsFile(paths, file);
  if (reflectionChanged) reportReload(ctx, await requestReload(ctx, "reflection model changed"));

  out.line("");
  out.line("Setup checklist:");
  for (const r of results) out.line(`${statusTag(r.status === "skip" ? "ok" : r.status)}${r.step}: ${r.detail}`);
  out.line("");
  out.line("Next:");
  out.line("  memmem-server project add <name> --owner <github-owner> --dry-run   # preview, then run without --dry-run");
  out.line("  memmem-server start                                                # or: memmem-server start --install-service");
  out.line("  memmem-server doctor");
  out.data({ ok: true, steps: results });
  return 0;
}
