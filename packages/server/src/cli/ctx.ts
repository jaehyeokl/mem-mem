// What every command gets: env (already the server env), paths, output,
// prompts, and the injectable command runner / readiness probe.
import type { ServerPaths } from "../paths.js";
import type { Runner } from "./exec.js";
import type { Output, Prompter } from "./io.js";

export interface Ctx {
  env: NodeJS.ProcessEnv;
  paths: ServerPaths;
  out: Output;
  prompt: Prompter;
  run: Runner;
  /** --yes: never prompt, accept defaults. */
  yes: boolean;
  /** true when GET http://127.0.0.1:<port>/readyz answers 2xx. */
  readyz: (port: number) => Promise<boolean>;
  version: string;
}

export async function defaultReadyz(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}
