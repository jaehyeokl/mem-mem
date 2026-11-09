// Structured one-line JSON logs on stdout, optionally also appended to a file
// (`memmem-server start` appends to <server home>/logs/worker.log).
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel: number = LEVELS[(process.env.MEMMEM_LOG_LEVEL as LogLevel) ?? "info"] ?? LEVELS.info;

let logFile: string | null = process.env.MEMMEM_LOG_FILE || null;
let logFileFailed = false;
let toStdout = true;

export function setLogLevel(level: LogLevel): void {
  minLevel = LEVELS[level];
}

/** Also append every log line to `path` (null: stdout only). */
export function setLogFile(path: string | null): void {
  logFile = path;
  logFileFailed = false;
  if (path) mkdirSync(dirname(path), { recursive: true });
}

/** Turn the stdout copy off (CLI commands that run worker code but print their own output). */
export function setLogStdout(enabled: boolean): void {
  toStdout = enabled;
}

/**
 * Remove credentials from anything that might contain a URL
 * (`https://user:token@host/...` -> `https://***@host/...`) and obvious
 * bearer/token query parameters.
 */
export function redact(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi, "$1***@")
    .replace(/((?:access_token|token|password|api_key|apikey)=)[^\s&'"]+/gi, "$1***")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, "$1***");
}

function sanitize(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (value instanceof Error) return redact(value.message);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitize(v);
    return out;
  }
  return value;
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < minLevel) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(sanitize(fields) as Record<string, unknown>) }) + "\n";
  if (toStdout) process.stdout.write(line);
  if (logFile && !logFileFailed) {
    try {
      appendFileSync(logFile, line, "utf8");
    } catch (err) {
      // Keep logging to stdout; report the file problem once.
      logFileFailed = true;
      process.stderr.write(`log file ${logFile} not writable: ${(err as Error).message}\n`);
    }
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return redact(err.message);
  return redact(String(err));
}
