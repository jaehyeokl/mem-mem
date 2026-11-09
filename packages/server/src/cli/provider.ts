// provider list | connect <name> | disconnect <name>
import { str } from "./args.js";
import type { Ctx } from "./ctx.js";
import { relay, runInherit } from "./exec.js";
import { CliError } from "./io.js";
import { authJsonPath, providerMatches, readProviders, removeProviders, type ProviderInfo } from "./letta-cli.js";
import { reportReload, requestReload } from "./runtime.js";

/** API-key providers `letta connect` accepts (Letta Code 0.34.41). */
export const API_KEY_PROVIDERS = ["anthropic", "openai", "gemini", "openrouter", "zai", "zai-coding", "minimax", "moonshot", "kimi-code", "openai-compatible"];

export function isChatGPT(name: string): boolean {
  return name === "chatgpt" || name === "codex";
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function describe(p: ProviderInfo, now = Date.now()): string {
  let s = `${p.name} (${p.type}${p.authType ? `, ${p.authType}` : ""})`;
  if (p.expires) s += p.expires > now ? `, access token valid until ${new Date(p.expires).toISOString()}` : `, access token expired${p.hasRefresh ? " (refreshed automatically)" : ""}`;
  return s;
}

export async function cmdProviderList(ctx: Ctx): Promise<number> {
  const providers = readProviders(ctx.paths);
  if (ctx.out.json) {
    ctx.out.data({ authFile: authJsonPath(ctx.paths), providers });
    return 0;
  }
  if (!providers.length) {
    ctx.out.line(`No provider connected (${authJsonPath(ctx.paths)}). Connect one: memmem-server provider connect chatgpt`);
    return 0;
  }
  for (const p of providers) ctx.out.line(describe(p));
  return 0;
}

/**
 * Connect a provider with the server's Letta state. ChatGPT uses the device
 * code flow with the code relayed to this terminal; API-key providers take
 * the key from stdin (`apiKeyStdin`) or let `letta` prompt on the terminal.
 * Returns true when a provider is connected afterwards.
 */
export async function connectProvider(ctx: Ctx, name: string, opts: { apiKeyStdin?: boolean; apiKey?: string; baseUrl?: string } = {}): Promise<boolean> {
  const n = name.toLowerCase();
  if (isChatGPT(n)) {
    ctx.out.line("Starting the ChatGPT device-code login (Letta Code). Open the URL in any browser and enter the code:");
    const code = await relay("letta", ["--backend", "local", "connect", "chatgpt", "--method", "device-code"], { env: ctx.env, cwd: ctx.paths.home });
    if (code !== 0) throw new CliError(`letta connect chatgpt failed (exit ${code})`);
  } else {
    const args = ["--backend", "local", "connect", n];
    if (opts.baseUrl) args.push("--base-url", opts.baseUrl);
    let key = opts.apiKey;
    if (!key && opts.apiKeyStdin) key = await readStdin();
    if (key) {
      // The key is on letta's argv for a moment (visible to local `ps` on this host).
      const r = await ctx.run("letta", [...args, "--api-key", key], { env: ctx.env, cwd: ctx.paths.home, timeoutMs: 120_000 });
      const msg = (r.stdout + r.stderr).split(key).join("***").trim();
      if (r.code !== 0) throw new CliError(`letta connect ${n} failed: ${msg.slice(0, 500)}`);
      if (msg) ctx.out.line(msg);
    } else if (ctx.prompt.interactive) {
      const code = await runInherit("letta", args, { env: ctx.env, cwd: ctx.paths.home });
      if (code !== 0) throw new CliError(`letta connect ${n} failed (exit ${code})`);
    } else {
      throw new CliError(`connecting ${n} needs an API key`, `printf %s "$KEY" | memmem-server provider connect ${n} --api-key-stdin`);
    }
  }
  const after = readProviders(ctx.paths);
  return isChatGPT(n) ? after.some((p) => p.type === "chatgpt_oauth") : after.length > 0;
}

export async function cmdProviderConnect(ctx: Ctx, name: string, values: Record<string, string | boolean | undefined>): Promise<number> {
  const existing = readProviders(ctx.paths).filter((p) => providerMatches(p, name));
  if (existing.length) {
    const again = ctx.yes || (await ctx.prompt.confirm(`${existing.map((p) => p.name).join(", ")} is already connected. Log in again?`, false));
    if (!again) {
      ctx.out.result("skip", "provider", `already connected: ${existing.map((p) => describe(p)).join("; ")}`);
      return 0;
    }
  }
  const ok = await connectProvider(ctx, name, { apiKeyStdin: values["api-key-stdin"] === true, baseUrl: str(values["base-url"]) });
  if (!ok) throw new CliError(`no ${name} provider in ${authJsonPath(ctx.paths)} after connecting`);
  ctx.out.result("ok", "provider", readProviders(ctx.paths).filter((p) => providerMatches(p, name)).map((p) => describe(p)).join("; ") || name);
  reportReload(ctx, await requestReload(ctx, `provider ${name} connected`));
  ctx.out.data({ ok: true, providers: readProviders(ctx.paths) });
  return 0;
}

export async function cmdProviderDisconnect(ctx: Ctx, name: string): Promise<number> {
  const matches = readProviders(ctx.paths).filter((p) => providerMatches(p, name));
  if (!matches.length) throw new CliError(`no connected provider matches ${name}`, "memmem-server provider list");
  if (!ctx.yes) {
    if (!ctx.prompt.interactive) throw new CliError("disconnecting needs confirmation", "pass --yes");
    if (!(await ctx.prompt.confirm(`Remove ${matches.map((p) => p.name).join(", ")}? Turns and reflections that use it will fail.`, false))) return 1;
  }
  const removed = removeProviders(ctx.paths, name);
  ctx.out.result("ok", "provider", `removed ${removed.join(", ")}`);
  reportReload(ctx, await requestReload(ctx, `provider ${name} removed`));
  ctx.out.data({ ok: true, removed });
  return 0;
}
