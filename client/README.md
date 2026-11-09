# mem-mem client (`memmem`)

The client every team member installs. It connects Claude Code and Codex to a
project's team memory: hooks inject the memory index at session start and ship
redacted session transcripts to the team's transcripts repo, and a few commands
set the project up, initialize the memory, and show progress.

| Command | What it does |
|---|---|
| `memmem setup` | First member: writes `.memmem/config.json`, clones both repos, installs hooks, skills, the `AGENTS.md` block, and the `.gitignore` lines. Teammates: `memmem setup` (clone, register, check). The member handle is your GitHub login. The memory language comes from the transcripts repo's `project.json` (set on the server); `--language` overrides it with a warning. |
| `memmem init` | Initializes (or re-initializes) the team memory from this codebase and, only with your explicit yes, your past sessions of this project. The memory server does the work. |
| `memmem status` | Ingest counts for you, the last reflection, init progress, any question the server asked, and the team's token usage over 7 days. |
| `memmem doctor` | Checks binary, git, credentials, config, hooks, skills, PATH. |
| `memmem remember "<text>"` | Saves a note for the team (`inbox/<member>/`). The skills call it when you say "remember" (or its Korean equivalent). |
| `memmem uninstall` | Removes hooks, skills, and the `AGENTS.md` block. |
| `session-start`, `session-end`, `checkpoint`, `sync` | Called by the hooks (see [Hooks](#hooks)). |

Network: memmem talks only to the team's two git repos (memory and
transcripts), through your own git credentials. No telemetry, no other
servers. Client machines need no Node, no Letta Code, only git.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/jaehyeokl/mem-mem/main/scripts/install.sh | sh
```

What the script does:

1. Detects your OS and CPU (Linux or macOS, x64 or arm64).
2. Downloads `memmem-<os>-<arch>` and `SHA256SUMS` from the project's GitHub Releases (latest, or `sh -s -- --ref v0.2.0`) and verifies the checksum.
3. Installs it as `~/.local/bin/memmem` (`MEMMEM_INSTALL_DIR` to change), keeping the old binary until the new one passes `memmem --version`.
4. Tells you how to add the folder to `PATH` if it is missing; it never edits your shell files.

Windows (x64, PowerShell): `irm https://raw.githubusercontent.com/jaehyeokl/mem-mem/main/scripts/install.ps1 | iex`
(installs `%LOCALAPPDATA%\Programs\memmem\memmem.exe`). `GITHUB_TOKEN`, if set,
is sent to `api.github.com` only, to avoid the anonymous rate limit when
resolving the latest release. To update, run the installer again. Pin a
version in team docs with the tag in the URL
(`.../mem-mem/v0.2.0/scripts/install.sh`).

From source (contributors): Node >= 20 and

```bash
cd client && npm ci --workspaces=false   # one dependency: @letta-ai/trajectory
node bin/memmem.mjs --help               # or: npm install -g .
```

`zstd` is needed only for Codex sessions stored as `rollout-*.jsonl.zst`.

## Quick start

First member, in the project folder:

```bash
memmem setup --project acme --memory-repo acme-org/mem-acme --transcripts-repo acme-org/mem-acme-transcripts
git add .memmem/config.json .gitignore .claude/settings.json .claude/skills .agents/skills .codex/hooks.json AGENTS.md
git commit -m "Add team memory (mem-mem)"
```

Then initialize the memory: `/memmem-init` in Claude Code, `$memmem-init` in
Codex, or `memmem init` in a terminal. Follow progress with `memmem status`.

Each teammate, after pulling: `memmem setup` (member = GitHub login from `gh`, or `--member <login>`). In Codex, open the
project and trust the hooks in `/hooks` once (and again after they change).

## Checking that it works

1. Open a new session in the project folder and ask "what is in this project's
   team memory?". If it answers from the index (`MEMORY.md`, `project.md`, the
   `decisions/` list and so on), injection works.
2. Work briefly and end the session. A few seconds later
   `tail -n 5 ~/.local/share/memmem/<project>/logs/sync.log` should show
   `ok trajectories/...json committed=true`, and the file appears in the
   `mem-<project>-transcripts` repo on GitHub.
3. With the server running, a reflection commit appears in the `mem-<project>`
   repo after a few sessions, and the index reflects it at the next session
   start.
4. Say "remember this: ..." during a session; the model runs `memmem remember`
   and reports the saved path in one line.

`memmem doctor` checks the same things without a session.

## Commands

### `memmem setup`

```
memmem setup --project P --memory-repo R --transcripts-repo R [--member GITHUB_LOGIN]
             [--language en|ko] [--local] [--hooks-only] [--no-gitignore] [--memory-dir PATH] [--yes] [--dir D] [--no-clone]
             [--alias OLD_HANDLE] [--no-email]
```

**Member handle = GitHub login.** `--member` > `gh api user` (when `gh` is on
PATH and signed in) > the valid handle already in `.memmem/local.json` > a
"Your GitHub login" prompt (empty or malformed answers are asked again; no
terminal: `missing --member`). git `user.name` and the OS user are never used.
`MEMMEM_MEMBER` still overrides at run time. Transcripts-repo commits are
authored `<handle> <handle@users.noreply.github.com>`.

**`members/<handle>.json`** in the transcripts repo is written and pushed by
every setup that clones: `{handle, displayName (gh name or handle), gitAuthors:
[{name, email}] (this machine's git config, union with other machines),
joinedAt (kept), githubId?, aliases}`. `--alias OLD` adds an old handle; a changed handle
in `.memmem/local.json` adds the previous one automatically. `--no-email`
drops every email. No secrets. `githubId` is the numeric account id from
`gh api user`, recorded only when gh is signed in as the handle (kept once
present; a hand-typed handle without gh leaves it absent). Logins can be
renamed, the id cannot: when another `members/*.json` carries the same
`githubId` under a different handle, setup adds that handle to `aliases` and
prints `previous handle X (same GitHub account) kept as an alias`. The old file
is never deleted.

Run in the project folder (`--dir` to point elsewhere). Missing values are
asked interactively when stdin is a terminal; `--yes` takes the defaults
instead (project = folder name, transcripts repo = `<memory repo>-transcripts`,
language `en`). The language is not asked when the transcripts repo has a
`project.json` (written by `memmem-server project add` / `project
set-language`): setup clones the transcripts repo first and takes its
`language`; `--language` still wins, with a warning when it differs (and
`memmem doctor` keeps flagging it). Repos are `org/repo` (GitHub HTTPS), a full URL, or a local
path. Re-running is safe; it only rewrites what changed.

**First member** (no `.memmem/config.json` yet, or any of `--project`,
`--memory-repo`, `--transcripts-repo`, `--language`, `--memory-dir` given):

- `.memmem/config.json` = `{project, memoryRepo, transcriptsRepo, language, layoutVersion: 1, memoryDir?}` (committed).
- `.memmem/local.json` = `{member, lastSeenInit?}`: your handle stays on your machine (git-ignored); `lastSeenInit` is the session-start notice state.
- Clones the memory repo to `.memmem/memory/` and the transcripts repo to the data root ([Where files live](#where-files-live)).
- Hooks, project-scoped: Claude Code `.claude/settings.json` (or `.claude/settings.local.json` with `--local`) and Codex `.codex/hooks.json`. Existing hooks are kept; earlier memmem entries are replaced.
- Skills: `.claude/skills/remember/`, `.claude/skills/memmem-init/`, `.agents/skills/memmem-init/` ([Skills](#skills)).
- `AGENTS.md`: appends the memmem block between `<!-- memmem:begin ... -->` and `<!-- memmem:end -->` (refreshed on re-run; a hand-pasted copy is left alone).
- `.gitignore`: `.memmem/*` and `!.memmem/config.json`, plus `.claude/settings.local.json` when the safety net is written ([details](#gitignore)). `--no-gitignore` skips this.
- The [PATH safety net](#path-safety-net).
- Prints what to commit. setup does not commit for you.

**Teammate** (config exists, no config flags): records the handle in
`.memmem/local.json`, clones both repos, registers `members/<handle>.json`, checks that the committed hooks and
skills are present and current (warns and suggests `memmem setup --hooks-only`
otherwise), and writes the PATH safety net. `--local` also installs the hooks
into `.claude/settings.local.json` when the team did not commit them.

**`--hooks-only`**: hooks, skills, `AGENTS.md` block, safety net; no config, no
clones. `memmem install` is a hidden alias of it.

**`--local`**: Claude Code hooks go to `.claude/settings.local.json` with the
absolute path of this memmem, so nothing Claude-specific needs committing.
Codex has no local hooks file, so `.codex/hooks.json` is still written; leave
it uncommitted or ignore it if you want.

`--memory-dir <path>` clones the memory repo elsewhere (relative to the project
or absolute; stored as `memoryDir`). If that path is inside the project and not
git-ignored, setup says so.

#### PATH safety net

The committed hooks call `memmem ...` from `PATH`, so every teammate shares
the same file. Desktop apps sometimes start hooks with a shorter `PATH`. So
`setup` also writes the same four Claude Code hooks to
`.claude/settings.local.json` (git-ignored) with this machine's absolute
command (the binary's path, or `node /abs/client/bin/memmem.mjs` from source)
and a `--fallback` flag. Claude Code runs hooks from both files; a `--fallback`
copy exits immediately when `memmem` resolves on `PATH` (the shared hook does
the work), and does the work when it does not (the shared hook then fails with
"command not found", which Claude Code treats as a non-blocking error). Codex
reads hooks only from `hooks.json` / `config.toml` per layer and has no local
override file
([docs](https://learn.chatgpt.com/codex/hooks)), so there is no safety net for
Codex: it needs `memmem` on `PATH`. `memmem doctor` checks both.

### `memmem init`

```
memmem init [--depth standard|deep] [--repos a,b] [--style "<text>"] [--history yes|no]
            [--history-only] [--dry-run] [--yes]
memmem init --answer "<text>"
```

Asks the four questions of Letta Code's `/init` (in the project `language`):
research depth, other repositories the memory should know about, preferred
communication style, and whether to upload your past sessions of this project.
Flags answer them non-interactively; `--yes` takes the defaults (`standard`,
none, none, **no**). Then:

1. Code summary: branch, `git status --short`, `git log --oneline -n 10`,
   top five of `git shortlog -sn --all`, and the `origin` URL (credentials
   stripped). No code is uploaded; the server clones the repo itself.
2. Only with `--history yes` (or "yes" at the prompt): finds this machine's
   Claude Code and Codex sessions whose recorded working directory is the
   project folder or below (`$CLAUDE_CONFIG_DIR` or `~/.claude/projects`,
   `$CODEX_HOME` or `~/.codex/sessions`; compressed `.jsonl.zst` rollouts are not
   listed), normalizes and redacts each like `sync`, and writes
   `bootstrap/<member>/<source>/<startedAt>_<sessionId>.json` (a trajectory-v1
   record array) plus `bootstrap/<member>/manifest.json`. The manifest has the
   fields of Letta Code's `letta trajectories export` manifest
   (`version, generatedAt, outDir, sources{discovered,exported}, errors[], sessions[]`,
   each session with `source, id, sessionId, file, sourcePath, project, startedAt, endedAt, userMessages, assistantMessages, toolCalls, reasoningRecords, firstUserPrompt, records, bytes, diagnostics`)
   plus `member` and per-session `redactions`. Sessions without a user or an
   assistant message, or over `MEMMEM_MAX_BYTES`, are listed in `errors`.
3. `bootstrap/<member>/request.json`:
   `{layoutVersion, memmemVersion, requestedAt, project, member, language, historyOnly, answers: {depth, repos[], style, history}, codeRepo, codeSummary, sessions, reinit?}`.
   `reinit: true` only with `--reinit` (re-initialize even though the project is initialized).
4. Commits and pushes to the transcripts repo, then prints the memory repo URL
   and `progress: memmem status`. A new request replaces your previous
   `request.json` and `answer-*.md`; sessions are merged, not replaced, so
   several devices of one member add up: when `bootstrap/<member>/manifest.json`
   exists, the sessions are a union by `sessionId` (an existing entry and its
   file are kept unless the new copy has more `bytes`), `errors` are
   concatenated and `sources` counts recomputed, and `request.sessions` is the
   merged count. Sessions already listed under one of your aliases
   (`bootstrap/<alias>/manifest.json`, left untouched; the server reads every
   manifest) are not uploaded again. The output says how many were new and how
   many already uploaded (`and 1 new session(s), 2 already uploaded (3 listed under
   bootstrap/<member>)`). A request without `--history yes` uploads nothing and
   leaves the uploaded sessions in place.

`--state` pulls the transcripts clone and prints one JSON object, uploading
nothing: `{project, member, projectInit: {state, initialized, depth,
initializedBy[], initializedAt, myContribution: {state: reflected|not_reflected|requested|<server state>, sessions?, kind?, finishedAt?},
commits?, lastRun?, question?, error?}, localSessions: {total, byTool, bytes, redactions}, pulled}`.
The `memmem-init` skills run it first and branch: not initialized → the four
questions; initialized → who/when/depth, then your sessions (consent), style,
deepen to `deep` (only when `standard`), extra repos.

`--dry-run` prints the sessions it would upload (count per tool, total size,
redaction count, each file) and the request, and writes nothing.
`--history-only` sends only your sessions (no depth or code summary; needs
`--history yes`; `--style` / `--repos` given as flags are kept), for adding
your history after a teammate ran init. `--reinit` and `--history-only`
exclude each other. `--answer "<text>"` writes `bootstrap/<member>/answer-<n>.md` and pushes,
for when `memmem status` shows a question from the server.

Server side: the worker turns the request into a headless Letta `/init`
([design](../docs/design/project-initialization.md)). The server picks the
request up on its next pass (by default every 60 seconds); until then
`memmem status` shows it as requested.

### `memmem status`

```
memmem status [--watch] [--json]
```

Pulls the transcripts repo clone and the memory clone, then prints:

- ingest: how many of your session files the server ingested (entries in
  `ingest/log.jsonl` whose file is under your member), skipped (with the last
  reason), and waiting (your files in `trajectories/` with no log entry yet);
- the last reflection (outcome and memory commit), and the reflection outcome
  of your latest ingested session;
- init: `bootstrap/status.json`
  (`{state: queued|running|waiting_for_answer|done|failed, question?, error?, commits, depth, initializedBy, initializedAt,
  members: {handle: {kind, sessions, finishedAt, state, initId}}, lastRun}`):
  `init: done (standard, by alice, 2026-11-06)` and `  my sessions: reflected (6, contribute at 2026-11-06)` /
  `  my sessions: not reflected (run /memmem-init or memmem init --history-only --history yes)`;
  "requested" when only your `request.json` exists, or "not requested"; a
  pending question with the `memmem init --answer` command;
- `usage (7d): ingest N turns / X tokens · reflection N / Y · init N / Z (≈$C)`:
  the whole team's token usage over the last 7 days, summed from the
  `ingest/log.jsonl` entries that carry `usage` (ingest turns, reflection
  runs, init runs; the cost is known for reflections only. Cost is Letta's own
  estimate from its price table and is only notional when the provider
  reports no per-token price). Left out when no
  entry has usage. `--json`: `usage: {days, ingest,
  reflection, init}` with `{turns, total, cacheRead, costUsd}` each, or null;
- the memory repo's last five commits.

`--watch` repeats every 30 s (`MEMMEM_STATUS_INTERVAL_MS`); `--json` prints the
same data as one JSON object per poll.

### `memmem doctor`

Prints one line per check (`ok`, `WARN`, `FAIL`, `info`) and exits 1 if any
check fails: memmem version and runtime, git, `memmem` on `PATH`,
`.memmem/config.json` (fields, `layoutVersion`, `language`; a warning "memory
language is <x> on the server; local config says <y>" when it differs from the
transcripts clone's `project.json`), member (and a
warning when it differs from the `gh api user` login), `members/<handle>.json`
registered (info when missing), the git
credential helper for the transcripts repo URL, `git ls-remote` on both repos
(15 s timeout), both clones, data dir writable, memmem hooks in
`.claude/settings.json` / `settings.local.json` (the local copy must point at
an existing executable) and `.codex/hooks.json`, each skill present and equal
to this memmem's copy, the `AGENTS.md` block, and a reminder to trust the Codex
hooks. `--json` prints the list.

### `memmem uninstall`

```
memmem uninstall [--purge] [--keep-config]
```

Removes memmem hooks from `.claude/settings.json`, `.claude/settings.local.json`,
and `.codex/hooks.json` (other hooks stay; a file left empty is deleted), the
three skill folders (only if they are memmem's), and the `AGENTS.md` block.
Clones, `.memmem/config.json`, and the `.gitignore` lines stay. `--purge` also
deletes the memory clone, `.memmem/local.json`, the data dir of this project
(kept if the transcripts clone may hold unpushed commits), and
`.memmem/config.json` unless `--keep-config`.

## Language

Three layers:

- Conversation with the coding agent (the `/memmem-init` questions, `remember`
  confirmations) follows the user's own language; there is no setting.
- The stored memory has one language per project. Its single source is the
  server (`memmem-server project add --language en|ko`, default `en`;
  `project set-language` changes it), mirrored into the transcripts repo's
  `project.json`. `memmem setup` copies it into `.memmem/config.json`
  `language` (`"en"` default, or `"ko"`), which selects the injected intro
  and truncation notes and the `memmem init` questions. The server writes
  memory in that language whatever the request says. The intro says "This
  memory is written in <Language>. Talk to the user in their own language."
  A member's preferred conversation language belongs in `people/<handle>.md`.
- CLI and log output are English. Skill texts are English with Korean trigger
  words, so either language works with them.

## Layout version

`layoutVersion` (currently `1`) versions the repo layout contract between client
and server: it is written to `.memmem/config.json`, to every trajectory file's
`meta.layoutVersion`, and to `request.json`. The client reads one version below
and above its own; the server records it and does not check it yet. `doctor`
fails on a project with a layout this memmem cannot read and tells you to
update.

## Skills

| File | Agent | Invoked |
|---|---|---|
| `.claude/skills/remember/SKILL.md` | Claude Code | when you say "remember" (or its Korean equivalent) |
| `.claude/skills/memmem-init/SKILL.md` | Claude Code | `/memmem-init`: asks the four questions with `AskUserQuestion` (after reading `memmem init --state`), runs `memmem init --yes ...`, points to `memmem status` |
| `.agents/skills/memmem-init/SKILL.md` | Codex (CLI, IDE, app) | `$memmem-init` or `/skills`: same flow; uses a choice tool if one is available, otherwise one plain-text message |

They are copies embedded in the binary (sources in `claude/`, `agents/`,
`codex/` here); `setup` refreshes them and `doctor` flags stale copies. Codex
reads the "remember" behaviour from the `AGENTS.md` block. The push in
`memmem init` needs network access: Claude Code may ask to allow the command,
and Codex's default sandbox asks for network approval. The four questions are
adapted from Letta Code's `initializing-memory` skill (Apache-2.0).

## Hooks

| Hook | Command | What it does |
|---|---|---|
| `SessionStart` | `memmem session-start` | `git pull --ff-only` the memory clone (10 s timeout, failures ignored), `git fetch` the transcripts clone and read the upstream `bootstrap/status.json`, then injects the memory index (see [Injected context](#injected-context)). When the init state changed, the context opens with one line (`config.language`): `done` once per run ("Team memory initialization finished (N commits, by …)."), `failed` with the error and `waiting_for_answer` with the question and `memmem init --answer` at every session until resolved. Seen state: `.memmem/local.json` `lastSeenInit: {initId, state}`. |
| `SessionEnd` | `memmem session-end` | Detaches `memmem sync` in the background and exits at once (hook budget: 1.5 s in Claude Code, 1-3 s in Codex). |
| `Stop` | `memmem checkpoint` | After each response; detaches `memmem sync` at most every 30 minutes and only when the transcript grew ([Checkpoints](#checkpoints-long-running-sessions)). |
| `PreCompact` | `memmem checkpoint` | Always detaches `memmem sync` before compaction. |
| (detached) | `memmem sync` | Reads the transcript (`.jsonl`, or `.jsonl.zst` via `zstd`), normalizes it with [`@letta-ai/trajectory`](https://www.npmjs.com/package/@letta-ai/trajectory), redacts secret-like strings, commits and pushes it to the transcripts repo. |

The detached child is the same program: a compiled binary re-runs itself
(`process.execPath sync ...`), a source checkout runs `node bin/memmem.mjs sync ...`.

Claude Code entries: `SessionStart` (timeout 20 s), `SessionEnd`, `Stop` (5 s),
`PreCompact` (10 s). Codex: the same four events, `SessionStart` with
`"additionalContextLimit": 12000` ([Codex context limit](#codex-context-limit)).
Codex runs non-managed hooks only after you trust them, and it asks again for
every new or changed definition (the trust is bound to a hash of the exact
definition). Open Codex, run `/hooks`, review, and trust.

Hooks do nothing (no output, exit 0) in folders without `.memmem/config.json`
above them. `MEMMEM_DISABLE=1` turns them off.
(Exception: `checkpoint` always prints `{}` for Codex, because Codex expects a
JSON object on stdout from a `Stop` hook that exits 0.)

### Codex context limit

Codex caps a `SessionStart` hook's additional context at about 2,500 tokens by
default; above that it writes the full text to a temp file and gives the model
only a head-and-tail preview and the file path
([docs](https://learn.chatgpt.com/docs/hooks)). The injected context may grow to
the 24,000-character budget (`MEMMEM_CONTEXT_MAX_CHARS`), so the default would
cut it. The per-handler field `additionalContextLimit` (a positive integer, or
`0` for unlimited) raises that threshold; memmem sets `12000` tokens, enough
for the default budget even at roughly one token per Korean character, while
still bounding a runaway memory. Set `MEMMEM_CODEX_CONTEXT_TOKENS` when running
`memmem setup` to choose another value (`0` = unlimited). It is read at install
time only, and changing it changes the hook definition, so re-trust it in
`/hooks`. Claude Code has no such field.

## Where files live

What the model reads lives inside the project; what it must not see lives in
your per-user data directory.

| Side | Path | What | In git? |
|---|---|---|---|
| Project | `<project>/.memmem/config.json` | `project`, `memoryRepo`, `transcriptsRepo`, `language`, `layoutVersion`, optional `memoryDir` | Committed by the team |
| Project | `<project>/.memmem/local.json` | `member` (yours) | Ignored |
| Project | `<project>/.memmem/memory/` | Memory repo clone: pulled and indexed by `session-start`, read on demand by the model. Never edit it. | Ignored |
| Project | `.claude/settings.json`, `.codex/hooks.json`, skills, `AGENTS.md` | Hooks and instructions | Committed |
| Project | `.claude/settings.local.json` | PATH safety net (or `--local` hooks) | Ignored |
| Data | `<root>/<project>/transcripts/` | Transcripts repo clone (`sync`, `remember`, `init`, `status`) | n/a |
| Data | `<root>/<project>/logs/sync.log` | Hook and sync log | n/a |
| Data | `<root>/<project>/checkpoints/<sessionId>.json` | Checkpoint throttle state | n/a |
| Data | `<root>/<project>/transcripts.lock` | Lock that serializes writes to the clone | n/a |

`<root>`, the data root, is the first of:

1. `$MEMMEM_HOME`
2. `$XDG_DATA_HOME/memmem` (only when `XDG_DATA_HOME` is an absolute path)
3. `%LOCALAPPDATA%\memmem` on Windows
4. `~/.local/share/memmem` (Linux and macOS)

Member name: `$MEMMEM_MEMBER`, else `.memmem/local.json` (written by `setup`).

Keeping the memory clone inside the project means Codex and Claude Code read it
as part of the workspace, with no sandbox approval for a path outside it.

### .gitignore

`setup` appends `.memmem/*` and `!.memmem/config.json` to `<project>/.gitignore`
and prints one line when it does. It skips this when git already ignores
`.memmem/memory` (checked with `git check-ignore`, so any existing pattern
counts), when the lines are already there, when the folder is not inside a git
work tree, or with `--no-gitignore`. If an existing pattern also ignores
`.memmem/config.json` (for example `.memmem/`), it prints a note; add
`!.memmem/config.json` so teammates get the config. When it writes the safety
net it also adds `.claude/settings.local.json` unless git already ignores it.

## Checkpoints (long-running sessions)

Without checkpoints a session reaches team memory only when it ends. The
`Stop` and `PreCompact` hooks run `memmem checkpoint`, which only stats the
transcript and maybe spawns a detached `memmem sync` (it returns in well under
a second; it never exits non-zero).

- `PreCompact`: always launches a sync.
- `Stop`: launches a sync only when all of these hold:
  - the transcript file exists;
  - its size or mtime changed since the last launched sync;
  - at least `MEMMEM_CHECKPOINT_MINUTES` (default `30`) passed since then;
    `0` means every `Stop`;
  - it grew by at least `MEMMEM_CHECKPOINT_MIN_BYTES` (default `2048`). A file
    that got smaller counts its whole size.

  The first `Stop` of a session only records a baseline (unless the interval
  is `0`), so the first checkpoint comes 30 minutes into the session and
  short sessions are synced once, by `SessionEnd`.
- State: `<data root>/<project>/checkpoints/<sessionId>.json` =
  `{lastSyncAt, lastSize, lastMtime}`. It is written when a sync is launched,
  by `checkpoint` and by `session-end`, so a `Stop` right after a
  `PreCompact` or `SessionEnd` does not sync again. It records the launch, not
  the result: a failed sync is retried by the next checkpoint that sees new
  growth, or by `SessionEnd`.
- A checkpoint sync is an ordinary `memmem sync`: it overwrites the same
  `trajectories/...` file (the name uses the session's first timestamp), under
  the same lock. When the normalized JSON equals the file already in the local
  clone and nothing is waiting to be pushed, it logs `unchanged <path>` and
  skips the pull, commit, and push. The server worker sends only the new
  records of a re-synced session (`from-record`), and a session counts once
  toward its `stepCount` until a reflection covers it.
- Claude Code notes that the transcript "is written asynchronously and may
  lag"; the detached sync waits `MEMMEM_SYNC_DELAY_MS` (default `1500`) before
  reading it, and anything still missing goes out with the next checkpoint.

## Injected context

`session-start` gives the model an index of the team memory, not the whole
memory. The model reads the files it needs with its own file tools. The text,
in order:

1. A short intro in the project `language` (English by default, Korean with
   `"language": "ko"`): which language the memory is written in and to talk
   to the user in their own language, the absolute path of the memory clone inside the
   project (for example `/home/alice/work/acme/.memmem/memory`), that index entries point to files under
   that path and should be read when relevant, that the folder is hidden and
   git-ignored so file search (`rg`, glob) does not list it unless hidden and
   ignored files are included (read files by the paths in the index, for
   example with `cat` or the Read tool), and that those files must not be
   edited directly (the server updates them from session transcripts; "remember" (or its
   Korean equivalent) goes through `memmem remember`).
2. `## MEMORY.md`: the root index.
3. One `## <file>` section per root core file, frontmatter included:
   `project.md`, `human.md`, then any other root `*.md` that has frontmatter,
   alphabetically. `persona.md` is left out: it is the server-side memory
   agent's persona and would read as instructions to the coding model.
4. One `## <folder>/ (index)` section per first-level folder that has a
   `MEMORY.md` (`decisions/`, `changes/`, `context/`, `people/`, ...), with that
   folder's `MEMORY.md`. Folders appear in the order the root `MEMORY.md` first
   mentions them, then the rest alphabetically. The files inside the folders are
   not injected.

New decisions and changes therefore show up at the next session start as soon
as reflection links them from their folder's `MEMORY.md`.

Size budget: `MEMMEM_CONTEXT_MAX_CHARS` (default `24000`). Over budget, folder
index sections are truncated first (last folder first), then core files (last
first). A truncated section ends with a note naming the file to read for the
rest (for example `decisions/MEMORY.md`, relative to the clone). The intro and root `MEMORY.md` are never truncated, so the output exceeds
the budget only if those two alone do. Claude Code receives the text as
`hookSpecificOutput.additionalContext`, Codex as plain stdout; the text is the same.

## Hook formats relied on

Claude Code ([docs](https://code.claude.com/docs/en/hooks)):

- Settings shape: `{"hooks": {"SessionStart": [{"matcher": "...", "hooks": [{"type": "command", "command": "...", "timeout": 20}]}]}}`. `"*"`, `""`, or an omitted `matcher` means "Match all". memmem omits it: SessionStart then also fires on `resume`, `clear`, and `compact`, and memory is re-injected after compaction.
- Input (stdin JSON): `session_id`, `transcript_path`, `cwd`, `hook_event_name`, plus `source` (SessionStart) or `reason` (SessionEnd).
- `Stop` runs "when Claude finishes responding"; `PreCompact` before a manual or automatic compaction. Both entries omit `matcher`. Stop JSON output is optional; memmem prints nothing.
- SessionStart output: `{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "..."}}`. The docs list `SessionStart` among the events "where Claude Code adds plain-text stdout as context"; memmem uses the JSON form.
- SessionEnd: "SessionEnd hooks have a default timeout of 1.5 seconds" and "can't block session termination". memmem therefore detaches the sync process (`detached: true`, new process group) and returns.

Codex CLI 0.164 ([docs](https://learn.chatgpt.com/docs/hooks)):

- Locations: `~/.codex/hooks.json` or `<repo>/.codex/hooks.json` (same `hooks.<Event>[].hooks[]` shape). "Hooks are enabled by default."
- "Every command hook receives one JSON object on `stdin`", with `session_id`, `transcript_path` ("Path to the session transcript file, if any"), `cwd`, `hook_event_name`, `model`.
- SessionStart: "Plain text on `stdout` is added as extra developer context." (The JSON `hookSpecificOutput.additionalContext` form is also accepted.) memmem prints plain text for Codex. Additional context above an approximate 2,500-token threshold is replaced by a head-and-tail preview plus a temp-file path; the per-handler `additionalContextLimit` (positive integer, `0` = unlimited) raises it, and memmem sets `12000`.
- SessionEnd: "`SessionEnd` and `Interrupt` use `1` second by default and support up to `3` seconds." memmem sets `timeout: 3`, but returns in well under that.
- Events used: `SessionStart`, `SessionEnd`, `Stop`, `PreCompact` (Codex also has `UserPromptSubmit`, `PostCompact`, `Interrupt`, ...). "`Stop` expects JSON on `stdout` when it exits `0`", so `checkpoint` prints `{}` for Codex on both events.
- Trust: "Before a non-managed hook can run, Codex requires you to review and trust the exact hook definition."
- The docs warn that the transcript format "isn't a stable interface for hooks". If `transcript_path` is missing, memmem looks for `$CODEX_HOME/sessions/**/rollout-*-<session_id>.jsonl[.zst]`.

## Transcripts repo layout (shared with `packages/server`)

```
trajectories/<YYYY-MM>/<member>/<tool>/<startedAt>_<sessionId>.json   memmem sync
inbox/<member>/<YYYY-MM-DD>-<slug>.md                                memmem remember
bootstrap/<member>/request.json                                      memmem init
bootstrap/<member>/manifest.json, <source>/<startedAt>_<id>.json     memmem init --history yes
bootstrap/<member>/answer-<n>.md                                     memmem init --answer
bootstrap/status.json                                                server (init state)
ingest/log.jsonl                                                     server (read by memmem status)
```

- `<tool>` is `claude-code` or `codex`.
- `<startedAt>` is the earliest transcript timestamp in UTC, written as `2026-11-06T01-23-45Z`. `<YYYY-MM>` is taken from it.
- The file is `{"records": [...trajectory-v1 records...], "meta": {member, tool, sessionId, startedAt, cwd, project, normalizer, diagnostics, redactions, redactionsByType, layoutVersion}}`. `meta.startedAt` is a full ISO timestamp.
- Re-syncing a session overwrites the same file (checkpoints do this while the session runs), and an unchanged file creates no commit (logged as `unchanged`).
- Sessions without user or assistant records are skipped. Normalized files over 5 MB (`MEMMEM_MAX_BYTES`) are skipped and logged.
- Commits are pushed with up to 4 attempts, running `git pull --rebase` after a rejected push. A file-system lock serializes concurrent syncs.

## Privacy

- The raw transcript never leaves your machine. Only the normalized trajectory
  (your prompts, assistant replies, reasoning text where the CLI exposes it, tool
  calls and tool results) is pushed to the project's private transcripts repo,
  which everyone with access to that repo can read.
- Secret redaction is best-effort: AWS access keys, `aws_secret_access_key=`,
  `sk-...` API keys, GitHub `ghp_/gho_/ghu_/ghs_/ghr_/github_pat_` tokens,
  PEM private keys, JWT-like tokens, Slack `xox*-` tokens, Google `AIza` keys,
  and `password=`/`passwd:` values become `[REDACTED:<type>]`, and the count is
  recorded in `meta.redactions`. Anything else, such as customer data, internal
  hostnames, or secrets in other formats, is pushed as-is. Don't paste secrets
  into sessions in team projects. Set `MEMMEM_DISABLE=1` for a session that must
  stay private.
- `memmem remember` notes and `memmem init --answer` texts are redacted the same way.
- `memmem init` uploads past sessions only after an explicit yes (`--history yes`
  or "yes" at the prompt; `--yes` alone means no), and `--dry-run` shows
  beforehand exactly which sessions, how large, and how many values would be
  redacted. Only sessions recorded in this project's folder are considered.

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `MEMMEM_HOME` | unset | Data root (transcripts clone, logs, checkpoints, lock). Overrides `XDG_DATA_HOME`. |
| `XDG_DATA_HOME` | unset | Data root is `$XDG_DATA_HOME/memmem` when set to an absolute path. |
| `MEMMEM_MEMBER` | `.memmem/local.json` | Your member name, over `local.json` and `config.json`. |
| `MEMMEM_DISABLE` | unset | `1` turns all hooks off. |
| `MEMMEM_CONTEXT_MAX_CHARS` | `24000` | Size budget of the injected context. |
| `MEMMEM_CODEX_CONTEXT_TOKENS` | `12000` | `memmem setup` only: `additionalContextLimit` written to the Codex `SessionStart` handler. `0` = unlimited. |
| `MEMMEM_PULL_TIMEOUT_MS` | `10000` | Timeout of the memory pull at session start. |
| `MEMMEM_CHECKPOINT_MINUTES` / `MEMMEM_CHECKPOINT_MIN_BYTES` | `30` / `2048` | `Stop` checkpoint throttle. |
| `MEMMEM_SYNC_DELAY_MS` | `1500` | Wait before a detached sync reads the transcript. |
| `MEMMEM_MAX_BYTES` | `5242880` | Skip normalized transcripts larger than this. |
| `CLAUDE_CONFIG_DIR` / `CODEX_HOME` | `~/.claude` / `~/.codex` | Where `memmem init` looks for past sessions (`projects/`, `sessions/`). |
| `MEMMEM_STATUS_INTERVAL_MS` | `30000` | `memmem status --watch` poll interval. |
| `MEMMEM_INSTALL_DIR` | `~/.local/bin` | `install.sh` / `install.ps1` target folder. |

## Troubleshooting

- Log: `<data root>/<project>/logs/sync.log` (default `~/.local/share/memmem/<project>/logs/sync.log`) (session-start pull failures, detached sync launches tagged `[session-end]` / `[checkpoint:Stop]` / `[checkpoint:PreCompact]`, sync results `ok ... records=<n>` / `unchanged` / `skip` / `error`, remember). A `Stop` that does not sync logs nothing.
- Checkpoints never fire: in Codex, trust the `Stop`/`PreCompact` hooks in `/hooks`. Check `<data root>/<project>/checkpoints/<sessionId>.json`; for a quick test, `MEMMEM_CHECKPOINT_MINUTES=0`.
- No context injected: check that `.memmem/config.json` is in the session's cwd or a parent, that `memmem` is on the hook's `PATH`, and run `echo '{"cwd":"'$PWD'"}' | memmem session-start --tool claude-code` by hand. In Codex, check that the hooks are trusted (`/hooks`); after any change to the hook definitions they must be trusted again. If Codex shows the model only a preview and a temp-file path, the context exceeded `additionalContextLimit`: reinstall with a larger `MEMMEM_CODEX_CONTEXT_TOKENS` and re-trust.
- Nothing pushed: run `memmem sync --transcript <file> --tool claude-code --cwd <project>` in the foreground, then read the log. If a push failed, the commit stays in `<data root>/<project>/transcripts` and goes out with the next sync.
- Hooks fail with "memmem: command not found": run `memmem doctor`. Claude Code keeps working through the safety net in `.claude/settings.local.json` (re-run `memmem setup --member <you>` after moving the binary); Codex needs `memmem` on the `PATH` it was started with (restart the app after changing `PATH`).
- `zstd not available`: install `zstd` (Codex `.jsonl.zst` sessions only).
- `memmem init` request never picked up: `memmem status` shows "requested" until the server's next pass (default every 60 seconds) and "running" while the init job runs. If it stays "requested", check `memmem-server status` on the server; nothing is lost, the request stays in `bootstrap/<member>/`.

## Development and releases

- Tests: `cd client && npm ci --workspaces=false && npm test` (`pretest` regenerates `lib/assets.generated.mjs`). Tests use a temporary `HOME`, fixture session stores, and local bare repos, never your real `~/.claude`, `~/.codex`, or GitHub. `MEMMEM_TEST_BIN=dist/memmem-<os>-<arch> node --test test/*.test.mjs` runs the same suite against a compiled binary.
- Skill and snippet texts live in `claude/`, `agents/`, `codex/`; `scripts/embed-assets.mjs` embeds them (and the package version, shown by `memmem --version`) into `lib/assets.generated.mjs` so the binary reads no files. Commit the regenerated file; CI fails when it is stale (`--check`).
- Binaries: `npm run build:bin` (all five targets) or `npm run build:bin:host` with bun on `PATH` (or `BUN=/path/to/bun`): `bun build --compile --minify --target=bun-<os>-<arch>` into `dist/memmem-{linux-x64,linux-arm64,darwin-x64,darwin-arm64,windows-x64.exe}` (about 90 MB each; bun's runtime is embedded). bun is a build tool only.
- Release: bump `version` in `client/package.json` (same number as `packages/server`), commit, and push a tag `vX.Y.Z`. `.github/workflows/release.yml` checks the tag against the version, runs the tests (and again against the linux-x64 binary), builds the five binaries (macOS on a macOS runner, ad-hoc signed; Linux and Windows cross-compiled on Ubuntu), writes `SHA256SUMS`, and creates the GitHub Release with the binaries, the checksums, and the three install scripts (`install.sh`, `install.ps1`, `install-server.sh`). `.github/workflows/ci.yml` runs the client tests on every push and pull request.
- The installers download from `github.com/<OWNER>/mem-mem` with `OWNER` defaulting to the owner in the install URLs above (`MEMMEM_OWNER` overrides); change the default in all three install scripts when the repository moves.
