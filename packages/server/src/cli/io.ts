// Output and prompts. Human output goes to stdout unless --json is set, in
// which case stdout carries exactly one JSON document and progress goes to stderr.
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export interface Output {
  json: boolean;
  /** A line of human output (stderr when --json). */
  line(text?: string): void;
  /** One-line step result: "  ok  label: detail". */
  result(status: Status, label: string, detail?: string): void;
  /** The single JSON document for --json. */
  data(value: unknown): void;
  warn(text: string): void;
  error(text: string): void;
}

export type Status = "ok" | "warn" | "fail" | "skip" | "info" | "todo" | "plan";

const TAG: Record<Status, string> = {
  ok: "  ok  ",
  warn: " warn ",
  fail: " FAIL ",
  skip: " skip ",
  info: "  --  ",
  todo: " todo ",
  plan: " plan ",
};

export function statusTag(s: Status): string {
  return TAG[s];
}

export function createOutput(json: boolean, write: (s: string) => void = (s) => process.stdout.write(s), writeErr: (s: string) => void = (s) => process.stderr.write(s)): Output {
  const human = json ? writeErr : write;
  return {
    json,
    line: (text = "") => human(text + "\n"),
    result: (status, label, detail) => human(`${TAG[status]}${label}${detail ? `: ${detail}` : ""}\n`),
    data: (value) => {
      if (json) write(JSON.stringify(value, null, 2) + "\n");
    },
    warn: (text) => writeErr(`warning: ${text}\n`),
    error: (text) => writeErr(`error: ${text}\n`),
  };
}

/** A captured Output for tests. */
export function memoryOutput(json = false): Output & { text(): string; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const o = createOutput(json, (s) => stdout.push(s), (s) => stderr.push(s));
  return Object.assign(o, { stdout, stderr, text: () => stdout.join("") + stderr.join("") });
}

export interface Prompter {
  interactive: boolean;
  ask(question: string, def?: string): Promise<string>;
  confirm(question: string, def?: boolean): Promise<boolean>;
  choose(question: string, options: { value: string; label: string }[], def?: string): Promise<string>;
  /** Input not echoed (tokens, API keys). */
  secret(question: string): Promise<string>;
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

/** Prompts on stderr (stdout may be --json). Non-interactive: returns defaults, or throws when there is none. */
export function createPrompter(interactive: boolean): Prompter {
  const need = (what: string): never => {
    throw new UsageError(`${what} needs an answer; run in a terminal or pass the matching flag (see -h)`);
  };
  async function question(q: string, muted = false): Promise<string> {
    let mute = false;
    const output = new Writable({
      write(chunk, _enc, cb) {
        if (!mute) process.stderr.write(chunk);
        cb();
      },
    });
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    try {
      const p = rl.question(q);
      mute = muted;
      const answer = await p;
      if (muted) process.stderr.write("\n");
      return answer;
    } finally {
      rl.close();
    }
  }
  return {
    interactive,
    async ask(q, def) {
      if (!interactive) return def ?? need(q);
      const a = (await question(`${q}${def ? ` [${def}]` : ""}: `)).trim();
      return a || def || "";
    },
    async confirm(q, def = true) {
      if (!interactive) return def;
      const a = (await question(`${q} ${def ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
      if (!a) return def;
      return a === "y" || a === "yes";
    },
    async choose(q, options, def) {
      if (!interactive) return def ?? need(q);
      process.stderr.write(`${q}\n`);
      options.forEach((o, i) => process.stderr.write(`  ${i + 1}) ${o.label}\n`));
      const defIdx = def ? options.findIndex((o) => o.value === def) + 1 : 0;
      for (;;) {
        const a = (await question(`Choose 1-${options.length}${defIdx ? ` [${defIdx}]` : ""}: `)).trim();
        const n = a ? Number(a) : defIdx;
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]!.value;
      }
    },
    async secret(q) {
      if (!interactive) return need(q);
      return (await question(`${q}: `, true)).trim();
    },
  };
}

/** Wrong usage: printed without a stack trace, exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

/** An operation failed in an expected way: printed without a stack trace, exit code 1. */
export class CliError extends Error {
  override name = "CliError";
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return `${duration(now - t)} ago`;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "-";
}
