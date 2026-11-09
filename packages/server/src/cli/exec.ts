// Child processes: a capturing runner (injectable for tests) and a relay that
// streams a login flow's output to the operator and highlights the code/URL.
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { redact } from "../log.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Written to stdin, then stdin is closed. */
  input?: string;
  timeoutMs?: number;
}

/** Runs a command to completion and captures its output. Never throws: a missing binary is code 127. */
export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

export const defaultRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      resolvePromise(r);
    };
    let child;
    try {
      child = spawn(cmd, args, { env: opts.env ?? process.env, cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      done({ code: 127, stdout: "", stderr: (err as Error).message });
      return;
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          stderr += `\n(timed out after ${opts.timeoutMs} ms)`;
        }, opts.timeoutMs)
      : null;
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      done({ code: err.code === "ENOENT" ? 127 : 1, stdout, stderr: stderr + err.message });
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      done({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });

/** Absolute path of `cmd` on PATH, or null. */
export function which(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (isAbsolute(cmd)) return canExec(cmd) ? cmd : null;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, cmd);
    if (canExec(p)) return p;
  }
  return null;
}

function canExec(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Shell-like rendering of a command for dry-run output and messages. */
export function showCmd(cmd: string, args: string[]): string {
  return [cmd, ...args]
    .map((a) => (/^[A-Za-z0-9_@%+=:,./<>-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(" ");
}

const CODE_RE = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/;
const URL_RE = /(https?:\/\/[^\s'"<>]+)/;

export interface RelayOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  input?: string;
  /** Called for each output line (after printing). */
  onLine?: (line: string) => void;
  /** Where to print (default stderr, so --json stdout stays clean). */
  write?: (s: string) => void;
}

/**
 * Run an interactive login flow without a TTY: feed `input`, print every
 * output line indented, and call out the one-time code and URL so the
 * operator sees them even if the tool's own wording changes.
 */
export function relay(cmd: string, args: string[], opts: RelayOptions = {}): Promise<number> {
  const write = opts.write ?? ((s: string) => process.stderr.write(s));
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let shownCode: string | null = null;
    let shownUrl: string | null = null;
    const onText = (() => {
      const bufs = { out: "", err: "" };
      return (which: "out" | "err", chunk: string, flush = false) => {
        bufs[which] += chunk;
        const parts = bufs[which].split(/\r?\n/);
        bufs[which] = flush ? "" : parts.pop()!;
        for (const raw of parts) {
          // Strip ANSI escapes so the code/URL are matched and shown cleanly.
          const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd();
          if (!line) continue;
          write(`    | ${redact(line)}\n`);
          const code = line.match(CODE_RE)?.[1];
          const url = line.match(URL_RE)?.[1];
          if (url && url !== shownUrl && /device|login|activate|auth/i.test(url)) {
            shownUrl = url;
            write(`\n    >>> Open ${url}\n\n`);
          }
          if (code && code !== shownCode) {
            shownCode = code;
            write(`\n    >>> Enter the one-time code: ${code}\n\n`);
          }
          opts.onLine?.(line);
        }
      };
    })();
    child.stdout.on("data", (d: Buffer) => onText("out", d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => onText("err", d.toString("utf8")));
    child.on("error", (err) => {
      write(`    | ${err.message}\n`);
      resolvePromise(127);
    });
    child.on("close", (code) => {
      onText("out", "\n", true);
      onText("err", "\n", true);
      resolvePromise(code ?? 1);
    });
    child.stdin.on("error", () => undefined);
    // Same as `printf '<input>' | tool`: answer the prompts, then EOF.
    child.stdin.end(opts.input ?? "");
  });
}

/** Run with the terminal attached (for tools that prompt on a TTY themselves). */
export function runInherit(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, cwd: opts.cwd, stdio: "inherit" });
    child.on("error", () => resolvePromise(127));
    child.on("close", (code) => resolvePromise(code ?? 1));
  });
}
