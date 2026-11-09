#!/usr/bin/env node
// mem-mem client CLI. Runs from source with `node`, or as a `bun build --compile` binary.
import { runDoctor } from "../lib/doctor.mjs";
import { runCheckpoint, runSessionEnd, runSessionStart } from "../lib/hooks.mjs";
import { INIT_BOOLEANS, runInit, USAGE as INIT_USAGE } from "../lib/init.mjs";
import { runRemember } from "../lib/remember.mjs";
import { VERSION } from "../lib/runtime.mjs";
import { runSetup, SETUP_BOOLEANS, USAGE as SETUP_USAGE } from "../lib/setup.mjs";
import { runStatus, STATUS_BOOLEANS, USAGE as STATUS_USAGE } from "../lib/status.mjs";
import { runSync } from "../lib/sync.mjs";
import { runUninstall, UNINSTALL_BOOLEANS } from "../lib/uninstall.mjs";
import { parseArgs } from "../lib/util.mjs";

const HELP = `memmem ${VERSION}: team memory for Claude Code and Codex

  setup --project P --memory-repo R --transcripts-repo R [--member GITHUB_LOGIN]
        [--language en|ko] [--local] [--hooks-only] [--no-gitignore] [--memory-dir PATH] [--yes] [--dir D]
        [--alias OLD_HANDLE] [--no-email]
        First member: config, clones, hooks, skills, AGENTS.md, .gitignore.
        Teammates (config already committed): memmem setup
        The member handle is your GitHub login (--member > \`gh api user\` > prompt);
        setup registers it in the transcripts repo as members/<handle>.json.
  init [--depth standard|deep] [--repos a,b] [--style "<text>"] [--history yes|no]
       [--history-only] [--reinit] [--dry-run] [--yes]   initialize the team memory (server side)
  init --state                                        JSON: init state, my contribution, local sessions
  init --answer "<text>"                              answer a question the server asked
  status [--watch] [--json]                           ingest, reflection, and init progress
  doctor [--json]                                     check the install
  remember "<text>"   |   remember - < file           save a note for the team
  uninstall [--purge] [--keep-config]                 remove hooks, skills, AGENTS.md block
  --version

  hooks (called by Claude Code / Codex; read hook JSON on stdin):
  session-start | session-end | checkpoint  [--tool claude-code|codex]
  sync --transcript FILE --tool T [--session ID] [--cwd DIR]

Project side: <project>/.memmem/config.json (commit it), .memmem/local.json (your member handle),
              .memmem/memory/ (memory repo clone, git-ignored)
Data side:    $MEMMEM_HOME | $XDG_DATA_HOME/memmem | %LOCALAPPDATA%\\memmem | ~/.local/share/memmem
`;

const HOOKS = new Set(["session-start", "session-end", "checkpoint"]);
const HOOK_USAGE = (name) => `usage: memmem ${name} [--tool claude-code|codex]   (hook: called by Claude Code / Codex with hook JSON on stdin)`;
/** Per-subcommand usage for `memmem <cmd> --help|-h`. */
const USAGES = {
  setup: SETUP_USAGE,
  install: "usage: memmem install   (same as: memmem setup --hooks-only)",
  init: INIT_USAGE,
  status: STATUS_USAGE,
  doctor: "usage: memmem doctor [--json]   check the install (config, clones, hooks, skills, PATH, member)",
  uninstall: "usage: memmem uninstall [--purge] [--keep-config]   remove hooks, skills, the AGENTS.md block (--purge: also the clones and .memmem/config.json unless --keep-config)",
  remember: 'usage: memmem remember "<text>"   |   memmem remember - < file   save a note for the team',
  sync: "usage: memmem sync --transcript FILE --tool claude-code|codex [--session ID] [--cwd DIR]   (hook helper: upload one transcript)",
  "session-start": HOOK_USAGE("session-start"),
  "session-end": HOOK_USAGE("session-end"),
  checkpoint: HOOK_USAGE("checkpoint"),
};
const [cmd, ...rest] = process.argv.slice(2);
/** `--help` / `-h` anywhere before a `--` asks for the subcommand's usage. */
const wantsHelp = (args) => { const end = args.indexOf("--"); return (end === -1 ? args : args.slice(0, end)).some((a) => a === "--help" || a === "-h"); };
let rc;
try {
  if (cmd && USAGES[cmd] && wantsHelp(rest)) { process.stdout.write(`${USAGES[cmd]}\n`); rc = 0; }
  else switch (cmd) {
    case "setup": rc = await runSetup(parseArgs(rest, { booleans: SETUP_BOOLEANS })); break;
    // An alias of `setup --hooks-only`.
    case "install": rc = await runSetup({ ...parseArgs(rest, { booleans: SETUP_BOOLEANS }), hooksOnly: true }); break;
    case "init": rc = await runInit(parseArgs(rest, { booleans: INIT_BOOLEANS })); break;
    case "status": rc = runStatus(parseArgs(rest, { booleans: STATUS_BOOLEANS })); break;
    case "doctor": rc = runDoctor(parseArgs(rest, { booleans: ["json"] })); break;
    case "uninstall": rc = runUninstall(parseArgs(rest, { booleans: UNINSTALL_BOOLEANS })); break;
    case "session-start": rc = runSessionStart(parseArgs(rest, { booleans: ["fallback"] })); break;
    case "session-end": rc = runSessionEnd(parseArgs(rest, { booleans: ["fallback"] })); break;
    case "checkpoint": rc = runCheckpoint(parseArgs(rest, { booleans: ["fallback"] })); break;
    case "sync": rc = runSync(parseArgs(rest)); break;
    case "remember": rc = runRemember(parseArgs(rest)); break;
    case "-v": case "--version": case "version": process.stdout.write(`${VERSION}\n`); rc = 0; break;
    case undefined: case "-h": case "--help": case "help": process.stdout.write(HELP); rc = cmd ? 0 : 2; break;
    default: process.stderr.write(`unknown command: ${cmd}\n${HELP}`); rc = 2;
  }
} catch (e) {
  process.stderr.write(`memmem ${cmd}: ${e?.stack || e}\n`);
  // Hooks must never break the host CLI.
  rc = HOOKS.has(cmd) ? 0 : 1;
}
process.exitCode = rc;
