// Letta Code CLI and local-backend files, always with the server's
// LETTA_CONFIG_DIR and `--backend local`.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ServerPaths } from "../paths.js";
import type { Ctx } from "./ctx.js";
import { CliError } from "./io.js";
import type { RunResult } from "./exec.js";

export const LETTA_CODE_MIN = "0.34.41";
export const LETTA_INSTALL = `npm i -g --allow-scripts=@letta-ai/letta-code,node-pty @letta-ai/letta-code@${LETTA_CODE_MIN}`;
export const DEFAULT_MODEL = "openai-codex/gpt-5.6-sol";

export async function letta(ctx: Ctx, args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<RunResult> {
  // Letta reads project settings from the cwd; run it in the data root, never in the operator's cwd.
  mkdirSync(ctx.paths.home, { recursive: true });
  return ctx.run("letta", ["--backend", "local", ...args], { env: ctx.env, cwd: ctx.paths.home, timeoutMs: opts.timeoutMs ?? 120_000, input: opts.input });
}

function parseJson(r: RunResult, what: string): unknown {
  if (r.code !== 0) throw new CliError(`${what} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new CliError(`${what}: unexpected output: ${r.stdout.trim().slice(0, 300)}`);
  }
}

export interface AgentInfo {
  id: string;
  name: string;
  tags?: string[];
}

export async function listAgents(ctx: Ctx, name?: string): Promise<AgentInfo[]> {
  const args = ["agents", "list", "--limit", "200"];
  if (name) args.push("--name", name);
  const raw = parseJson(await letta(ctx, args), "letta agents list") as { items?: unknown; agents?: unknown } | unknown[];
  const items = Array.isArray(raw) ? raw : ((raw as { items?: unknown[] }).items ?? (raw as { agents?: unknown[] }).agents ?? []);
  return (items as Record<string, unknown>[])
    .filter((a) => typeof a.id === "string")
    .map((a) => ({ id: a.id as string, name: String(a.name ?? ""), tags: Array.isArray(a.tags) ? (a.tags as string[]) : undefined }));
}

export async function createAgent(ctx: Ctx, opts: { name: string; description: string; tags: string[] }): Promise<string> {
  const raw = parseJson(
    await letta(ctx, ["agents", "create", "--name", opts.name, "--description", opts.description, "--tags", opts.tags.join(",")]),
    "letta agents create",
  ) as { id?: string; agent?: { id?: string } };
  const id = raw.id ?? raw.agent?.id;
  if (!id) throw new CliError("could not read the agent id from `letta agents create`");
  return id;
}

export async function setAgentModel(ctx: Ctx, agentId: string, handle: string, reasoning = "low"): Promise<void> {
  const r = await letta(ctx, ["model", "set", handle, "--reasoning", reasoning, "--agent", agentId]);
  if (r.code !== 0) throw new CliError(`letta model set ${handle} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`, "connect the model's provider first: memmem-server provider connect <name>");
}

export interface ModelInfo {
  handle: string;
  label?: string;
  id?: string;
  reasoning_levels?: string[];
  context_window_limit?: number;
}

export async function listModels(ctx: Ctx): Promise<ModelInfo[] | null> {
  const r = await letta(ctx, ["model", "list"]);
  if (r.code !== 0) return null;
  try {
    const raw = JSON.parse(r.stdout) as unknown;
    const items = Array.isArray(raw) ? raw : ((raw as { models?: unknown[] }).models ?? []);
    return (items as ModelInfo[]).filter((m) => typeof m.handle === "string");
  } catch {
    return null;
  }
}

/** One entry per handle (Letta lists one per reasoning level). */
export function uniqueHandles(models: ModelInfo[]): ModelInfo[] {
  const m = new Map<string, ModelInfo>();
  for (const x of models) if (!m.has(x.handle)) m.set(x.handle, x);
  return [...m.values()];
}

export function localBackendDir(paths: ServerPaths): string {
  return join(paths.lettaConfigDir, "lc-local-backend");
}

export function authJsonPath(paths: ServerPaths): string {
  return join(localBackendDir(paths), "providers", "auth.json");
}

export interface ProviderInfo {
  name: string;
  type: string;
  category?: string;
  authType?: string;
  /** Access token expiry (ms since epoch), when the login is OAuth. */
  expires?: number;
  hasRefresh?: boolean;
  createdAt?: string;
}

interface AuthFile {
  version?: number;
  providers?: Record<string, { name?: string; provider_type?: string; provider_category?: string; auth?: Record<string, unknown>; created_at?: string }>;
}

function readAuth(paths: ServerPaths): AuthFile | null {
  try {
    return JSON.parse(readFileSync(authJsonPath(paths), "utf8")) as AuthFile;
  } catch {
    return null;
  }
}

/** Connected providers from auth.json, without secrets. */
export function readProviders(paths: ServerPaths): ProviderInfo[] {
  const auth = readAuth(paths);
  return Object.entries(auth?.providers ?? {}).map(([key, p]) => ({
    name: p.name ?? key,
    type: p.provider_type ?? "unknown",
    category: p.provider_category,
    authType: typeof p.auth?.type === "string" ? (p.auth.type as string) : undefined,
    expires: typeof p.auth?.expires === "number" ? (p.auth.expires as number) : undefined,
    hasRefresh: typeof p.auth?.refresh === "string" && (p.auth.refresh as string).length > 0,
    createdAt: p.created_at,
  }));
}

/** `chatgpt`/`codex` match the ChatGPT OAuth provider; other names match the provider name or type. */
export function providerMatches(p: ProviderInfo, name: string): boolean {
  const n = name.toLowerCase();
  if ((n === "chatgpt" || n === "codex") && p.type === "chatgpt_oauth") return true;
  return p.name.toLowerCase() === n || p.type.toLowerCase() === n;
}

/** Remove matching providers from auth.json (Letta's CLI has no disconnect). Returns the removed names. */
export function removeProviders(paths: ServerPaths, name: string): string[] {
  const auth = readAuth(paths);
  if (!auth?.providers) return [];
  const removed: string[] = [];
  for (const [key, p] of Object.entries(auth.providers)) {
    const info: ProviderInfo = { name: p.name ?? key, type: p.provider_type ?? "" };
    if (providerMatches(info, name)) {
      delete auth.providers[key];
      removed.push(info.name);
    }
  }
  if (removed.length) {
    const file = authJsonPath(paths);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }
  return removed;
}

export function reflectionFile(paths: ServerPaths): string {
  return join(paths.lettaConfigDir, "agents", "reflection.md");
}

/** The `model:` of `<LETTA_CONFIG_DIR>/agents/reflection.md`, the only reflection-model override in Letta Code 0.34. */
export function readReflectionModel(paths: ServerPaths): string | null {
  try {
    const m = readFileSync(reflectionFile(paths), "utf8").match(/^model:[ \t]*(\S+)/m);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export function writeReflectionModel(paths: ServerPaths, handle: string): void {
  const file = reflectionFile(paths);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `---\nname: reflection\nmodel: ${handle}\n---\n`);
}

export function agentRecordPath(paths: ServerPaths, agentId: string): string {
  return join(localBackendDir(paths), "agents", `${Buffer.from(agentId).toString("base64url")}.json`);
}

export function memfsMemoryDir(paths: ServerPaths, agentId: string): string {
  return join(localBackendDir(paths), "memfs", agentId, "memory");
}

/** When the agent record was created (birth time, else mtime), or null when it is missing. */
export function agentCreatedAt(paths: ServerPaths, agentId: string): number | null {
  try {
    const st = statSync(agentRecordPath(paths, agentId));
    return st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
  } catch {
    return null;
  }
}

export function memfsPresent(paths: ServerPaths, agentId: string): boolean {
  return existsSync(join(memfsMemoryDir(paths, agentId), ".git"));
}

/** "0.34.41 (Letta Code)" -> [0, 34, 41] */
export function parseVersion(text: string): number[] | null {
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function versionAtLeast(v: number[], min: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if ((v[i] ?? 0) !== (min[i] ?? 0)) return (v[i] ?? 0) > (min[i] ?? 0);
  }
  return true;
}
