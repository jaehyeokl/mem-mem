// Command table and argument parsing (node:util parseArgs, strict).
import { parseArgs } from "node:util";
import { UsageError } from "./io.js";

export interface OptSpec {
  type: "string" | "boolean";
  short?: string;
  desc: string;
  /** Placeholder shown in help for string options. */
  arg?: string;
}

export interface CommandSpec {
  /** "project add" */
  name: string;
  args: string;
  summary: string;
  options: Record<string, OptSpec>;
  positionals: [min: number, max: number];
  details?: string;
}

export const GLOBAL_OPTIONS: Record<string, OptSpec> = {
  json: { type: "boolean", desc: "Machine-readable output on stdout (one JSON document)" },
  yes: { type: "boolean", short: "y", desc: "Do not prompt; accept defaults and confirm" },
  home: { type: "string", arg: "dir", desc: "Data directory (default $MEMMEM_SERVER_HOME or ~/.local/share/memmem-server)" },
  help: { type: "boolean", short: "h", desc: "Show help" },
};

const project = { type: "string", short: "p", arg: "name", desc: "Project name" } as const;

export const COMMANDS: CommandSpec[] = [
  {
    name: "setup",
    args: "",
    summary: "Interactive, resumable first-time setup (checks, git identity, GitHub, model provider, reflection model)",
    positionals: [0, 0],
    options: {
      "git-name": { type: "string", arg: "name", desc: "Git user.name for server commits (default mem-mem)" },
      "git-email": { type: "string", arg: "email", desc: "Git user.email for server commits (default mem-mem@localhost)" },
      github: { type: "string", arg: "gh|token|skip", desc: "How the server authenticates to GitHub" },
      "token-stdin": { type: "boolean", desc: "With --github token: read the token from stdin" },
      provider: { type: "string", arg: "chatgpt|<name>|skip", desc: "Model provider to connect" },
      "api-key-stdin": { type: "boolean", desc: "With an API-key provider: read the key from stdin" },
      model: { type: "string", arg: "handle", desc: "Default agent model for new projects" },
      "reflection-model": { type: "string", arg: "handle", desc: "Reflection model (default: the agent model)" },
    },
  },
  {
    name: "doctor",
    args: "",
    summary: "Check tools, logins, the App Server, the worker and every project; exit 1 on a critical failure",
    positionals: [0, 0],
    options: {},
  },
  {
    name: "start",
    args: "",
    summary: "Run the Letta App Server and the ingest worker (foreground by default)",
    positionals: [0, 0],
    options: {
      foreground: { type: "boolean", desc: "Run in the foreground (the default)" },
      detach: { type: "boolean", desc: "Run in the background; output goes to logs/server.out" },
      port: { type: "string", arg: "n", desc: "App Server port on 127.0.0.1 (default $LETTA_APP_SERVER_PORT or 4500)" },
      "install-service": { type: "boolean", desc: "Write a systemd user unit (Linux) or launchd agent (macOS); does not enable it" },
    },
  },
  {
    name: "stop",
    args: "",
    summary: "Stop the running server (graceful: the current turn finishes)",
    positionals: [0, 0],
    options: {
      "wait-reflection": { type: "boolean", desc: "First wait (up to 10 min) until no reflection is in flight" },
    },
  },
  {
    name: "restart",
    args: "",
    summary: "Restart the App Server and worker in place (reloads agents); --hard restarts the process",
    positionals: [0, 0],
    options: {
      hard: { type: "boolean", desc: "Restart the whole process (via the service manager when installed)" },
    },
  },
  {
    name: "status",
    args: "",
    summary: "Server, App Server and per-project worker state",
    positionals: [0, 0],
    options: { project },
  },
  {
    name: "project add",
    args: "<name>",
    summary: "Create repos, Letta agent and memory layout for a project, register it, reload the App Server",
    positionals: [1, 1],
    options: {
      owner: { type: "string", arg: "org", desc: "GitHub owner for the repos (default: the gh user)" },
      model: { type: "string", arg: "handle", desc: "Agent model (default: setup's model, else openai-codex/gpt-5.6-sol)" },
      "reflection-model": { type: "string", arg: "handle", desc: "Reflection model (server-wide; default: the agent model)" },
      "force-reflection-model": { type: "boolean", desc: "Replace a different reflection model already configured" },
      summary: { type: "string", arg: "text", desc: "One-line project summary for project.md" },
      language: { type: "string", arg: "en|ko", desc: "Language the memory is written in (default en); recorded in projects.json and the transcripts repo's project.json" },
      "memory-repo": { type: "string", arg: "url|owner/name", desc: "Use this memory repo instead of creating one" },
      "transcripts-repo": { type: "string", arg: "url|owner/name", desc: "Use this transcripts repo instead of creating one" },
      "dry-run": { type: "boolean", desc: "Print the plan and commands; change nothing" },
      "no-reload": { type: "boolean", desc: "Do not reload the running App Server afterwards" },
      "skip-provider-check": { type: "boolean", desc: "Do not require a connected model provider" },
    },
  },
  { name: "project list", args: "", summary: "List projects", positionals: [0, 0], options: {} },
  { name: "project show", args: "<name>", summary: "Show one project's config and worker state", positionals: [1, 1], options: {} },
  {
    name: "project set-language",
    args: "<name> <en|ko>",
    summary: "Change a project's memory language (projects.json and the transcripts repo's project.json)",
    positionals: [2, 2],
    options: {},
    details: "Existing memory text is not translated; reflections and inits write the new language from the worker's next pass. Teammates update .memmem/config.json with `memmem setup --language <lang>` (memmem doctor warns until then).",
  },
  { name: "project pause", args: "<name>", summary: "Stop ingesting a project (enabled: false)", positionals: [1, 1], options: {} },
  { name: "project resume", args: "<name>", summary: "Resume a paused project", positionals: [1, 1], options: {} },
  {
    name: "project remove",
    args: "<name>",
    summary: "Unregister a project and delete its local worker state (GitHub repos are kept)",
    positionals: [1, 1],
    options: {
      "keep-repos": { type: "boolean", desc: "Keep the local transcripts clone under repos/<name>" },
      "delete-repos": { type: "boolean", desc: "Also delete both GitHub repos (asks you to type the project name)" },
      confirm: { type: "string", arg: "name", desc: "Non-interactive confirmation for --delete-repos (the project name)" },
    },
  },
  { name: "model list", args: "", summary: "List models the connected providers offer, and the configured ones", positionals: [0, 0], options: {} },
  {
    name: "model set",
    args: "<handle>",
    summary: "Set the agent model for one project (or every project and the default)",
    positionals: [1, 1],
    options: {
      project,
      reasoning: { type: "string", arg: "level", desc: "Reasoning level (default low)" },
    },
  },
  {
    name: "model set-reflection",
    args: "<handle>",
    summary: "Set the reflection model (server-wide in Letta Code 0.34)",
    positionals: [1, 1],
    options: {},
  },
  { name: "provider list", args: "", summary: "Connected model providers (no secrets)", positionals: [0, 0], options: {} },
  {
    name: "provider connect",
    args: "<name>",
    summary: "Connect a provider (chatgpt: device code; others: API key)",
    positionals: [1, 1],
    options: {
      "api-key-stdin": { type: "boolean", desc: "Read the API key from stdin" },
      "base-url": { type: "string", arg: "url", desc: "Base URL (openai-compatible and local providers)" },
    },
  },
  { name: "provider disconnect", args: "<name>", summary: "Remove a provider login", positionals: [1, 1], options: {} },
  {
    name: "reflect now",
    args: "",
    summary: "Reflect the project's current ingest conversation once (the worker's reflection path)",
    positionals: [0, 0],
    options: { project, timeout: { type: "string", arg: "s", desc: "How long to wait for the result (default 900)" } },
  },
  {
    name: "reflect retry",
    args: "",
    summary: "Retry the carried-forward and unreflected sessions once (marker turn + retry instruction)",
    positionals: [0, 0],
    options: { project, timeout: { type: "string", arg: "s", desc: "How long to wait for the result (default 900)" } },
  },
  {
    name: "init status",
    args: "",
    summary: "Project memory initialization: the current or last run, its question or error, processed requests",
    positionals: [0, 0],
    options: { project },
  },
  {
    name: "init run",
    args: "",
    summary: "Start the project's init now (re-runs the newest bootstrap requests even if already processed)",
    positionals: [0, 0],
    options: { project, timeout: { type: "string", arg: "s", desc: "How long to wait for the worker to pick it up (default 120)" } },
    details:
      "With a running server the worker starts the init in the background and this returns; follow it with `init status` or `logs -f`. Without one, the init runs in this process against the App Server and the command returns when it settles.",
  },
  {
    name: "init cancel",
    args: "",
    summary: "Cancel the project's init (abort the running turn, or drop a pending question); marks it failed",
    positionals: [0, 0],
    options: { project, timeout: { type: "string", arg: "s", desc: "How long to wait for the result (default 90)" } },
  },
  {
    name: "members",
    args: "",
    summary: "Team members registered in the transcripts repo (members/*.json): aliases, git authors, init contribution",
    positionals: [0, 0],
    options: { project },
    details: "Reads the worker's transcripts clone (as of its last pass) and the project state. Emails are not printed.",
  },
  {
    name: "logs",
    args: "",
    summary: "Show logs/worker.log",
    positionals: [0, 0],
    options: {
      project,
      follow: { type: "boolean", short: "f", desc: "Keep printing new lines" },
      lines: { type: "string", short: "n", arg: "n", desc: "Number of lines (default 200)" },
      raw: { type: "boolean", desc: "Print the JSON lines as they are" },
    },
  },
  {
    name: "usage",
    args: "",
    summary: "Token usage per day: ingest turns, reflection runs and init runs (tokens, cached, Letta's cost estimate)",
    positionals: [0, 0],
    options: {
      project,
      since: { type: "string", arg: "7d|30d|YYYY-MM-DD", desc: "First day to show (default 7d: today and the 6 days before)" },
    },
    details:
      "Reads the daily ledger in each project's state file (kept 90 days). Cost is known for reflections only. Cost is Letta's own estimate from its price table and is only notional when the provider reports no per-token price.",
  },
  { name: "version", args: "", summary: "Print the version", positionals: [0, 0], options: {} },
];

export interface ParsedCommand {
  spec: CommandSpec;
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
}

export type ParseResult =
  | { kind: "command"; cmd: ParsedCommand }
  | { kind: "help"; topic: string | null }
  | { kind: "version" };

const GROUPS = [...new Set(COMMANDS.filter((c) => c.name.includes(" ")).map((c) => c.name.split(" ")[0]!))];

export function parseCommandLine(argv: string[]): ParseResult {
  const words: string[] = [];
  for (const a of argv) {
    if (a.startsWith("-")) break;
    words.push(a);
    if (words.length === 2) break;
  }
  if (argv.length === 0 || (words.length === 0 && (argv[0] === "-h" || argv[0] === "--help"))) return { kind: "help", topic: null };
  if (words.length === 0 && (argv[0] === "--version" || argv[0] === "-v")) return { kind: "version" };
  if (words[0] === "help") return { kind: "help", topic: argv.slice(1).filter((a) => !a.startsWith("-")).join(" ") || null };
  let spec = words.length === 2 ? COMMANDS.find((c) => c.name === `${words[0]} ${words[1]}`) : undefined;
  let consumed = 2;
  if (!spec) {
    spec = COMMANDS.find((c) => c.name === words[0]);
    consumed = 1;
  }
  if (!spec) {
    if (words[0] && GROUPS.includes(words[0])) {
      if (words.length === 1 || argv.includes("-h") || argv.includes("--help")) return { kind: "help", topic: words[0] };
      throw new UsageError(`unknown command: ${words[0]} ${words[1]} (see memmem-server ${words[0]} -h)`);
    }
    throw new UsageError(`unknown command: ${argv[0]} (see memmem-server -h)`);
  }
  const rest = argv.slice(consumed);
  const options = Object.fromEntries(
    Object.entries({ ...GLOBAL_OPTIONS, ...spec.options }).map(([k, o]) => [k, o.short ? { type: o.type, short: o.short } : { type: o.type }]),
  );
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options, strict: true, allowPositionals: true });
  } catch (err) {
    throw new UsageError(`${(err as Error).message} (see memmem-server ${spec.name} -h)`);
  }
  const values = parsed.values as Record<string, string | boolean | undefined>;
  if (values.help) return { kind: "help", topic: spec.name };
  const [min, max] = spec.positionals;
  if (parsed.positionals.length < min) throw new UsageError(`memmem-server ${spec.name} needs ${spec.args}`);
  if (parsed.positionals.length > max) throw new UsageError(`unexpected argument: ${parsed.positionals[max]} (see memmem-server ${spec.name} -h)`);
  return { kind: "command", cmd: { spec, values, positionals: parsed.positionals } };
}

function optionLines(opts: Record<string, OptSpec>): string[] {
  return Object.entries(opts).map(([k, o]) => {
    const flag = `${o.short ? `-${o.short}, ` : "    "}--${k}${o.type === "string" ? ` <${o.arg ?? "value"}>` : ""}`;
    return `  ${flag.padEnd(36)} ${o.desc}`;
  });
}

export function helpText(topic: string | null, version: string): string {
  if (!topic) {
    const lines = [
      `memmem-server ${version}: mem-mem team memory server (Letta Code App Server + ingest worker)`,
      "",
      "Usage: memmem-server <command> [options]",
      "",
      "Commands:",
      ...COMMANDS.map((c) => `  ${`${c.name}${c.args ? ` ${c.args}` : ""}`.padEnd(30)} ${c.summary}`),
      "",
      "Global options:",
      ...optionLines(GLOBAL_OPTIONS),
      "",
      "Start here: memmem-server setup, then memmem-server project add <name>, then memmem-server start.",
    ];
    return lines.join("\n");
  }
  const group = COMMANDS.filter((c) => c.name.startsWith(`${topic} `));
  const spec = COMMANDS.find((c) => c.name === topic);
  if (!spec && group.length) {
    return [`Usage: memmem-server ${topic} <command>`, "", ...group.map((c) => `  ${`${c.name}${c.args ? ` ${c.args}` : ""}`.padEnd(30)} ${c.summary}`)].join("\n");
  }
  if (!spec) throw new UsageError(`no such command: ${topic}`);
  return [
    `Usage: memmem-server ${spec.name}${spec.args ? ` ${spec.args}` : ""} [options]`,
    "",
    spec.summary,
    ...(spec.details ? ["", spec.details] : []),
    "",
    "Options:",
    ...optionLines(spec.options),
    ...optionLines(GLOBAL_OPTIONS),
  ].join("\n");
}

export function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function intOpt(v: string | boolean | undefined, name: string, def: number, min = 0): number {
  if (v === undefined) return def;
  const n = Number(v);
  if (typeof v !== "string" || !Number.isInteger(n) || n < min) throw new UsageError(`--${name} must be an integer >= ${min}`);
  return n;
}
