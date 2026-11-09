// Helpers for CLI tests: a Ctx on a temp data root with an injected runner.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyServerEnv } from "../dist/paths.js";
import { createPrompter, memoryOutput } from "../dist/cli/io.js";

export function tempHome(prefix = "memmem-cli-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * `responses` maps "cmd arg0 arg1" prefixes to {code, stdout, stderr}; the
 * longest matching prefix wins. Unmatched commands return code 127.
 */
export function fakeRunner(responses = {}, calls = []) {
  return async (cmd, args, opts = {}) => {
    const line = [cmd, ...args].join(" ");
    calls.push({ line, opts });
    const key = Object.keys(responses)
      .filter((k) => line === k || line.startsWith(k + " "))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) return { code: 127, stdout: "", stderr: `${cmd}: not found` };
    const r = responses[key];
    return { code: 0, stdout: "", stderr: "", ...(typeof r === "function" ? r(line) : r) };
  };
}

export function makeCtx(home, { run, readyz, json = false, env: extra = {} } = {}) {
  const env = { MEMMEM_SERVER_HOME: home, HOME: home, PATH: process.env.PATH, ...extra };
  const paths = applyServerEnv(env);
  return {
    env,
    paths,
    out: memoryOutput(json),
    prompt: createPrompter(false),
    run: run ?? fakeRunner(),
    yes: true,
    readyz: readyz ?? (async () => false),
    version: "0.0.0-test",
  };
}
