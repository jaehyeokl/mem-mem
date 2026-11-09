// How this process was started: `node bin/memmem.mjs` from a source tree, or a
// `bun build --compile` single binary. Used to re-launch ourselves (detached
// `sync`) and to write absolute hook commands (PATH safety net).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "./assets.generated.mjs";
import { shellQuote } from "./util.mjs";

export { VERSION };

export const MEMMEM_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "memmem.mjs");

/* global __MEMMEM_COMPILED__ */
/**
 * True inside a compiled binary. The release build passes
 * `--define __MEMMEM_COMPILED__=true`; as a fallback, bun's embedded file
 * system shows up in module URLs (`/$bunfs/` on POSIX, `~BUN` on Windows).
 */
export function isCompiled({ moduleUrl = import.meta.url, defined = typeof __MEMMEM_COMPILED__ !== "undefined" && __MEMMEM_COMPILED__ } = {}) {
  return Boolean(defined) || /\$bunfs|~BUN/.test(moduleUrl);
}

/**
 * Command + leading args that start this program again. Compiled: the binary
 * itself (`process.execPath`), so `[execPath, "sync", ...]`. From source: the
 * runtime plus the script, `[node, /abs/bin/memmem.mjs, "sync", ...]`.
 */
export function selfInvocation({ compiled = isCompiled(), execPath = process.execPath, script = MEMMEM_BIN } = {}) {
  return compiled ? { cmd: execPath, args: [] } : { cmd: execPath, args: [script] };
}

/** `selfInvocation` as a hook command prefix with absolute, quoted paths. */
export function selfCommand(opts = {}, platform = process.platform) {
  const { cmd, args } = selfInvocation(opts);
  return [cmd, ...args].map((p) => shellQuote(p, platform)).join(" ");
}

export function runtimeDescription({ compiled = isCompiled() } = {}) {
  if (compiled) return `binary ${process.execPath}${process.versions.bun ? ` (bun ${process.versions.bun})` : ""}`;
  return `node ${process.version} ${MEMMEM_BIN}`;
}
