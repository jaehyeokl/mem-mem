// The doctor checklist (also step 1 of setup).
import { accessSync, constants } from "node:fs";
import { loadState } from "../state.js";
import type { Ctx } from "./ctx.js";
import { ago, duration, type Status } from "./io.js";
import {
  LETTA_CODE_MIN,
  LETTA_INSTALL,
  agentCreatedAt,
  authJsonPath,
  listAgents,
  memfsPresent,
  parseVersion,
  readProviders,
  readReflectionModel,
  versionAtLeast,
  type AgentInfo,
} from "./letta-cli.js";
import { readProjectsFile } from "./projects-file.js";
import { currentPort, runningServer } from "./runtime.js";

export interface Check {
  id: string;
  label: string;
  status: Extract<Status, "ok" | "warn" | "fail" | "skip" | "info">;
  detail: string;
  /** The exact command (or step) that fixes it. */
  fix?: string;
}

export const NODE_MIN = [24, 22, 0];

export interface CheckOptions {
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  now?: number;
}

function installHint(pkg: string, platform: NodeJS.Platform): string {
  return platform === "darwin" ? `brew install ${pkg}` : `sudo apt-get install -y ${pkg}`;
}

async function git(ctx: Ctx, args: string[]): Promise<string | null> {
  const r = await ctx.run("git", args, { env: ctx.env });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Node, Letta Code, git (required); gh, zstd (optional). */
export async function toolChecks(ctx: Ctx, opts: CheckOptions = {}): Promise<Check[]> {
  const platform = opts.platform ?? process.platform;
  const checks: Check[] = [];
  const nodeV = parseVersion(opts.nodeVersion ?? process.versions.node);
  checks.push(
    nodeV && versionAtLeast(nodeV, NODE_MIN)
      ? { id: "node", label: "Node.js", status: "ok", detail: `v${nodeV.join(".")}` }
      : {
          id: "node",
          label: "Node.js",
          status: "fail",
          detail: `v${opts.nodeVersion ?? process.versions.node}; Letta Code needs >= ${NODE_MIN.join(".")}`,
          fix: "install Node.js 24.22 or newer (https://nodejs.org, or `mise use -g node@24`)",
        },
  );
  const lv = await ctx.run("letta", ["--version"], { env: ctx.env, timeoutMs: 30_000 });
  const lver = lv.code === 0 ? parseVersion(lv.stdout) : null;
  if (lv.code === 127 || !lver) {
    checks.push({ id: "letta", label: "Letta Code", status: "fail", detail: lv.code === 127 ? "`letta` not found on PATH" : `\`letta --version\` failed: ${(lv.stderr || lv.stdout).trim().slice(0, 200)}`, fix: LETTA_INSTALL });
  } else if (!versionAtLeast(lver, parseVersion(LETTA_CODE_MIN)!) || lver[0] !== 0 || lver[1] !== 34) {
    checks.push({ id: "letta", label: "Letta Code", status: "fail", detail: `${lver.join(".")}; memmem-server is built for ^${LETTA_CODE_MIN} (0.34.x)`, fix: LETTA_INSTALL });
  } else {
    checks.push({ id: "letta", label: "Letta Code", status: "ok", detail: lver.join(".") });
  }
  const gv = await ctx.run("git", ["--version"], { env: ctx.env });
  checks.push(gv.code === 0 ? { id: "git", label: "git", status: "ok", detail: gv.stdout.trim().replace(/^git version /, "") } : { id: "git", label: "git", status: "fail", detail: "not found", fix: installHint("git", platform) });
  const ghv = await ctx.run("gh", ["--version"], { env: ctx.env });
  checks.push(
    ghv.code === 0
      ? { id: "gh", label: "gh (optional)", status: "ok", detail: ghv.stdout.split("\n")[0]!.replace(/^gh version /, "").trim() }
      : { id: "gh", label: "gh (optional)", status: "warn", detail: "not found: repos must be created by hand and git needs another credential helper", fix: installHint("gh", platform) },
  );
  const zv = await ctx.run("zstd", ["--version"], { env: ctx.env });
  checks.push(
    zv.code === 0
      ? { id: "zstd", label: "zstd (optional)", status: "ok", detail: zv.stdout.trim().split("\n")[0]!.slice(0, 80) }
      : { id: "zstd", label: "zstd (optional)", status: "warn", detail: "not found (needed only for compressed Codex sessions)", fix: installHint("zstd", platform) },
  );
  return checks;
}

export function hasGh(checks: Check[]): boolean {
  return checks.some((c) => c.id === "gh" && c.status === "ok");
}

export interface GitAuth {
  helper: "gh" | "store" | "other" | null;
  detail: string;
}

/** Which credential helper the server gitconfig uses for github.com. */
export async function gitAuth(ctx: Ctx): Promise<GitAuth> {
  const specific = (await git(ctx, ["config", "--global", "--get-all", "credential.https://github.com.helper"])) ?? "";
  const generic = (await git(ctx, ["config", "--global", "--get-all", "credential.helper"])) ?? "";
  const all = `${specific}\n${generic}`;
  if (/gh(\.exe)? auth git-credential/.test(all)) return { helper: "gh", detail: "gh credential helper" };
  if (/store --file/.test(all)) return { helper: "store", detail: `token store (${ctx.paths.gitCredentials})` };
  const other = all.split("\n").map((s) => s.trim()).filter(Boolean);
  if (other.length) return { helper: "other", detail: `credential helper: ${other.join(", ")}` };
  return { helper: null, detail: "no credential helper" };
}

export async function ghLogin(ctx: Ctx): Promise<{ ok: boolean; account?: string; detail: string }> {
  const r = await ctx.run("gh", ["auth", "status", "-h", "github.com"], { env: ctx.env, timeoutMs: 30_000 });
  const text = `${r.stdout}\n${r.stderr}`;
  const account = text.match(/account\s+(\S+)/)?.[1] ?? text.match(/Logged in to github\.com as\s+(\S+)/)?.[1];
  if (r.code === 0) return { ok: true, account, detail: account ? `logged in as ${account}` : "logged in" };
  return { ok: false, detail: text.trim().split("\n").find((l) => /not logged|no longer valid|invalid|failed/i.test(l))?.trim() ?? "not logged in" };
}

export async function gitIdentity(ctx: Ctx): Promise<{ name: string | null; email: string | null }> {
  return { name: await git(ctx, ["config", "--global", "user.name"]), email: await git(ctx, ["config", "--global", "user.email"]) };
}

export async function doctorChecks(ctx: Ctx, opts: CheckOptions = {}): Promise<Check[]> {
  const now = opts.now ?? Date.now();
  const checks = await toolChecks(ctx, opts);
  const { paths } = ctx;
  const ghOk = hasGh(checks);

  // Data directory and env.
  let writable = false;
  try {
    accessSync(paths.home, constants.W_OK);
    accessSync(paths.stateDir, constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  checks.push(
    writable
      ? { id: "data", label: "data dir", status: "ok", detail: `${paths.home} (letta: ${paths.lettaConfigDir})` }
      : { id: "data", label: "data dir", status: "fail", detail: `${paths.home} not initialized or not writable`, fix: "memmem-server setup" },
  );

  // Git identity and credentials (server gitconfig).
  const id = await gitIdentity(ctx);
  checks.push(
    id.name && id.email
      ? { id: "git-identity", label: "git identity", status: "ok", detail: `${id.name} <${id.email}> in ${paths.gitConfig}` }
      : { id: "git-identity", label: "git identity", status: "fail", detail: `user.name/user.email not set in ${paths.gitConfig}`, fix: "memmem-server setup" },
  );
  const auth = await gitAuth(ctx);
  let ghState: Awaited<ReturnType<typeof ghLogin>> | null = null;
  if (ghOk) ghState = await ghLogin(ctx);
  if (auth.helper === "gh") {
    checks.push(
      ghState?.ok
        ? { id: "github", label: "GitHub", status: "ok", detail: `${ghState.detail}; ${auth.detail}` }
        : { id: "github", label: "GitHub", status: "fail", detail: `git uses the gh helper but gh is ${ghState ? ghState.detail : "not installed"}`, fix: "memmem-server setup" },
    );
  } else if (auth.helper) {
    checks.push({ id: "github", label: "GitHub", status: "ok", detail: auth.detail + (ghState ? `; gh ${ghState.detail}` : "") });
  } else {
    checks.push({
      id: "github",
      label: "GitHub",
      status: "warn",
      detail: `no credential helper in ${paths.gitConfig}${ghState ? `; gh ${ghState.detail}` : ""} (fine only with SSH repo URLs)`,
      fix: "memmem-server setup",
    });
  }

  // Model provider.
  const providers = readProviders(paths);
  if (!providers.length) {
    checks.push({ id: "provider", label: "model provider", status: "fail", detail: `none connected (${authJsonPath(paths)} missing)`, fix: "memmem-server provider connect chatgpt" });
  } else {
    for (const p of providers) {
      let detail = `${p.name} (${p.type}${p.authType ? `, ${p.authType}` : ""})`;
      let status: Check["status"] = "ok";
      if (p.expires) {
        const when = new Date(p.expires).toISOString();
        if (p.expires > now) detail += `, access token valid until ${when}`;
        else if (p.hasRefresh) detail += `, access token expired ${ago(when, now)}; Letta refreshes it on the next request`;
        else {
          detail += `, access token expired ${ago(when, now)} and there is no refresh token`;
          status = "warn";
        }
      }
      checks.push({ id: `provider:${p.name}`, label: "model provider", status, detail, ...(status === "warn" ? { fix: `memmem-server provider connect ${p.type === "chatgpt_oauth" ? "chatgpt" : p.name}` } : {}) });
    }
  }
  const refl = readReflectionModel(paths);
  checks.push(
    refl
      ? { id: "reflection-model", label: "reflection model", status: "ok", detail: refl }
      : { id: "reflection-model", label: "reflection model", status: "warn", detail: "not set: reflection uses Letta's default model", fix: "memmem-server model set-reflection <handle>" },
  );

  // Server, App Server, worker.
  const srv = runningServer(paths);
  const port = currentPort(paths, ctx.env);
  const ready = await ctx.readyz(port);
  if (srv) {
    const up = srv.runtime?.startedAt ? `, up ${duration(now - Date.parse(srv.runtime.startedAt))}` : "";
    checks.push({ id: "server", label: "memmem-server", status: "ok", detail: `running (pid ${srv.pid}${up})` });
    checks.push(
      ready
        ? { id: "app-server", label: "App Server", status: "ok", detail: `ws://127.0.0.1:${port} ready` }
        : { id: "app-server", label: "App Server", status: "fail", detail: `ws://127.0.0.1:${port}/readyz does not answer (state: ${srv.runtime?.state ?? "?"})`, fix: "memmem-server logs -n 50; memmem-server restart" },
    );
    checks.push(
      srv.runtime?.state === "running"
        ? { id: "worker", label: "worker", status: "ok", detail: `running in pid ${srv.pid}` }
        : { id: "worker", label: "worker", status: "warn", detail: `server state: ${srv.runtime?.state ?? "unknown"}` },
    );
  } else {
    checks.push({ id: "server", label: "memmem-server", status: "warn", detail: "not running", fix: "memmem-server start" });
    checks.push(
      ready
        ? { id: "app-server", label: "App Server", status: "warn", detail: `ws://127.0.0.1:${port} answers but was not started by memmem-server` }
        : { id: "app-server", label: "App Server", status: "info", detail: `not running (port ${port})` },
    );
  }

  // Projects.
  let file;
  try {
    file = readProjectsFile(paths);
  } catch (err) {
    checks.push({ id: "projects", label: "projects", status: "fail", detail: (err as Error).message });
    return checks;
  }
  if (!file.projects.length) {
    checks.push({ id: "projects", label: "projects", status: "warn", detail: `none in ${paths.configPath}`, fix: "memmem-server project add <name>" });
    return checks;
  }
  const enabled = file.projects.filter((p) => p.enabled !== false).length;
  checks.push({ id: "projects", label: "projects", status: "ok", detail: `${file.projects.length} (${enabled} enabled) in ${paths.configPath}` });
  let agents: AgentInfo[] | null = null;
  const lettaOk = checks.some((c) => c.id === "letta" && c.status === "ok");
  if (lettaOk) {
    try {
      agents = await listAgents(ctx);
    } catch {
      agents = null;
    }
  }
  const appStarted = srv?.runtime?.appServerStartedAt ? Date.parse(srv.runtime.appServerStartedAt) : null;
  for (const p of file.projects) {
    const label = `project ${p.project}`;
    const problems: string[] = [];
    let status: Check["status"] = "ok";
    let fix: string | undefined;
    if (agents && !agents.some((a) => a.id === p.agentId)) {
      problems.push(`agent ${p.agentId} not found in Letta (${paths.lettaConfigDir})`);
      status = "fail";
      fix = `memmem-server project add ${p.project}`;
    }
    if (!memfsPresent(paths, p.agentId)) {
      problems.push("MemFS missing");
      status = "fail";
      fix = `memmem-server project add ${p.project}`;
    }
    const created = agentCreatedAt(paths, p.agentId);
    let loaded = "";
    if (appStarted && created && created > appStarted + 1000) {
      problems.push("agent created after the App Server started (not loaded)");
      if (status === "ok") status = "warn";
      fix ??= "memmem-server restart";
    } else if (appStarted && created) loaded = ", loaded";
    const st = await loadState(paths.stateDir, p.project).catch(() => null);
    if (st?.backoff?.until && Date.parse(st.backoff.until) > now) {
      problems.push(`backing off until ${st.backoff.until}: ${st.backoff.reason ?? ""}`.trim());
      if (status === "ok") status = "warn";
    }
    const base = `${p.enabled === false ? "paused, " : ""}agent ${p.agentId}${agents ? "" : " (agent list unavailable)"}${loaded}, MemFS ${memfsPresent(paths, p.agentId) ? "ok" : "missing"}`;
    checks.push({ id: `project:${p.project}`, label, status, detail: problems.length ? `${problems.join("; ")} (${base})` : base, ...(fix ? { fix } : {}) });
  }
  return checks;
}

export function renderChecks(checks: Check[], tag: (s: Status) => string): string {
  return checks
    .map((c) => `${tag(c.status)}${c.label}: ${c.detail}${c.fix && c.status !== "ok" ? `\n        fix: ${c.fix}` : ""}`)
    .join("\n");
}

export function failed(checks: Check[]): Check[] {
  return checks.filter((c) => c.status === "fail");
}
