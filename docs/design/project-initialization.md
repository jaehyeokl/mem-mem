# Project memory initialization (init)

Written November 2026. This is the flow that organizes the "initial context"
once when an existing project is brought into mem-mem. The goal is to use
Letta Code's `/init` as unchanged as possible. The basis is
[research/letta-memory-initialization.md](../research/letta-memory-initialization.md).

## 1. Principles

- **Run Letta's `/init` as it is.** Do not copy the skill
  (`initializing-memory`), the cohort scripts, the subagent fan-out, or the
  verification and commit rules; let the Letta Code installed on the server
  run its own skill. What mem-mem does is put the materials Letta assumes are
  "on the developer's PC" (code, past sessions, answers to its questions) in
  front of the server agent.
- **License.** Letta code is not copied, so there is no issue. If the cohort
  grouping logic of `prepare-history.mjs` is reused when building a manifest
  from the transcripts repo, keep the Apache-2.0 notice. Letta trademarks and
  logos are not used.
- **Conversation with people happens inside the coding agent.** The four
  questions of the Letta skill (research depth, related repos, communication
  style, consent to analyze past sessions) come as one batch, and after that
  the skill proceeds on its own. So the teammate's coding agent (Claude Code
  or Codex) asks first and sends the collected answers, and the server's init
  runs without questions (headless). This is the same approach as Letta's PR
  #4825 (headless init).
- **Past sessions are uploaded only with explicit consent.** What will be
  uploaded (number of sessions, size, number of secrets removed) is shown
  first.

## 2. User experience

It comes down to three verbs.

| Command | What it does | Replaces |
|---|---|---|
| `memmem setup` | Writes `.memmem/config.json`, clones both repos, installs hooks and skills | `init` + `install` merged |
| `memmem init` | Fills the team memory for the first time from this project's code and past sessions (the counterpart of Letta's `/init`). After that, a run adds the member's sessions; `--reinit` re-initializes (section 3.5) | New |
| `memmem status` | Reads `ingest/log.jsonl` and `bootstrap/status.json` in the transcripts repo and shows ingest, reflection and init progress and any open question | New |

`memmem init` asks the four questions in the terminal, like `npm init`, and
takes all of them as flags too: `--depth standard|deep`, `--repos a,b`,
`--style "<text>"`, `--history yes|no`, `--yes` (accept defaults),
`--dry-run`, `--history-only` (add only my past sessions, no code research),
`--reinit` (re-initialize an initialized project), `--state` (print the
project's init state as JSON, used by the skills), `--answer "<text>"` (reply
to a question from the server). `--interactive` (section 3.4) is not
implemented.

Inside the coding agent there is a thin wrapper.

- Claude Code: `<project>/.claude/skills/memmem-init/SKILL.md`. It appears as
  `/memmem-init`; the model asks the four questions as choices with
  `AskUserQuestion`, runs `memmem init --yes --depth ... --history ...`, and
  then points to `memmem status`.
- Codex: `<project>/.agents/skills/memmem-init/SKILL.md`, called with
  `$memmem-init` or from `/skills` (section 5). The `AGENTS.md` block points
  to it.

Everything is installed at project scope. In any other folder the command
ends with "not a team project (no .memmem/config.json)".

## 3. Flow

### 3.1 Client: `memmem init` (teammate's PC)

1. Ask the four questions (or take the flags). The wording follows the
   questions of the Letta skill.
2. Build a code summary: branch, `git status --short`,
   `git log --oneline -n 10`, `git shortlog -sn --all | head -5`, remote URL
   (to identify the code repo). The code itself is not sent. The server
   clones the repo itself (3.2).
3. Past sessions (with consent): with `listTrajectories` from
   `@letta-ai/trajectory`, pick only those Claude Code and Codex sessions on
   this machine **whose working directory is this project**. Normalize each
   session, remove secrets, write it as
   `bootstrap/<member>/<source>/<startedAt>_<sessionId>.json`, and build
   `bootstrap/<member>/manifest.json` (the same fields as the manifest of
   Letta's `trajectories export`). `--dry-run` only shows the list, sizes and
   removal counts.
4. Write `bootstrap/<member>/request.json`: the four answers, the code summary,
   the code repo URL, the request time, the memmem version, plus the project,
   member, language, `layoutVersion`, `historyOnly`, the session count and
   `reinit` when given.
5. Commit and push to the transcripts repo and print "the memory server
   commits the initialized memory to `<memory repo URL>`" and
   "progress: memmem status".

### 3.2 Server: init handling in the worker

When the worker finds an unprocessed `bootstrap/*/request.json`, it runs the
init procedure as a background job, and that project's normal ingest passes
wait until the job settles (other projects keep running).

1. **Prepare the code.** Clone (or fetch) the code repo from `request.json`
   into the agent's working directory `MEMMEM_CWD/<project>/repo`, using the
   server's gh/git credentials. Related repos (answer 2) are cloned to
   `repo-<name>/` too. A clone failure is recorded as an init failure and the
   run stops.
2. **Lay out past sessions.** Spread the trajectory files from `bootstrap/*/`
   where the Letta skill expects them (`/tmp/letta-trajectories/<source>/...`
   + `manifest.json`, `MEMMEM_INIT_TRAJECTORIES_DIR`). Sessions from several
   teammates are merged and de-duplicated by session id; only the newest
   `settings.initMaxSessions` are kept.
3. **Pre-answer turn.** Open a new init-only conversation for the agent
   (separate from the normal ingest conversation) and send as the first turn
   "the following questions are already answered": research depth, related
   repos, communication style, consent to analyze sessions (names of the
   consenting teammates, number of sessions), the fact that past sessions are
   already exported to `/tmp/letta-trajectories`, the project git summary
   (Letta's `init` command builds the git summary from the App Server
   process's cwd, which is empty on the server), the members table, the memory
   language, and an instruction to follow the "Rules for reflection" in
   `MEMORY.md`. Only a one-sentence reply is asked for. The init session runs
   in the code clone with permission mode `unrestricted`.
4. **Run Letta `init`.** Send `execute_command` `init` to the App Server.
   Letta builds the `/init` message, reads the skill and goes through to the
   end. The worker consumes the stream and watches commits pile up on MemFS
   `main`. If the agent ends its turn while a Workflow or subagent it started
   is still running, the worker keeps the session open and follows the
   background turns.
5. **Decide the end.** The pre-turn asks for a final
   `INIT: done | INIT: question: <q> | INIT: failed: <reason>` line, which
   wins. Without one, if the last assistant message ends with a question
   (when the skill asks something more), record `state: waiting_for_answer`
   and the question text in `status.json` and stop. The teammate sends an
   answer with `memmem init --answer "<text>"`, and the worker puts that turn
   into the same conversation and continues. On a normal end, record
   `state: done`, the commit list and token usage.
6. **Push and record.** Push MemFS `main` to the memory repo (the usual
   logic). Write `event: "init"` to `ingest/log.jsonl`, write
   `bootstrap/status.json`, and mark each handled `bootstrap/*/request.json`
   as processed in the worker state (`state.initRequests`: blob,
   `processedAt`, outcome).
7. **Clean up.** Remove `/tmp/letta-trajectories`. The code clone stays for the
   next init (re-initialization). The server's code clone is only material for
   the memory and is not uploaded anywhere.

### 3.3 Re-initialization and additions

- Running `memmem init` again creates a new `request.json`. On an initialized
  project the server classifies it (section 3.5): only `--reinit` or a deeper
  depth runs a Letta re-initialization (step 1 of the skill reads the existing
  memory and restructures it); otherwise it is a session contribution.
- `--history-only` uploads only sessions, without a code summary or depth
  (a style or repos given as flags are kept).
  The server runs init with a pre-turn saying "reflect the past sessions into
  the existing memory" (the answers state that the skill skips code research
  in this case).

### 3.4 Option: interactive relay `--interactive`

Not implemented. An option for teams whose server App Server is exposed
externally with token authentication. `memmem init --interactive` opens a session with the server
agent and relays Letta's questions to the terminal. It preserves Letta's
behaviour most faithfully, but it needs the server exposed and someone
waiting, so it is not the default. To be decided together with the deployment
design (docker-compose).

### 3.5 Init with several teammates

Letta's `/init` assumes one person's memory and bundles "code research + that
person's past sessions" in one go. In a team these two have to be separated.

| Work | Unit | How often | Depth applies |
|---|---|---|---|
| **Project initialization** (code research, memory skeleton, promoting decisions and context) | Project | Once. Again only for an explicit re-initialization or a deeper depth | Yes |
| **Session contribution** (reflecting one teammate's past sessions into the existing memory) | Teammate | Once per teammate. New sessions after that are handled by the normal ingest | No |

The server classifies a request into three kinds **by comparing it with the
project state**, not by the flags in `request.json`.

| Situation | Classification | What the server does |
|---|---|---|
| No completed init (the worker's project record, else `status.json`; first request, including several requests in the same pass) | `project_init` | As before. Requests in the same pass are merged: deep wins for depth, repos are united, sessions come from every consenting teammate (for the same session id, the one larger copy) |
| `done` exists, a new teammate's request, depth equal to or lower than before | `contribute` | Stage only that teammate's sessions and run init with a pre-turn saying "reflect into the existing memory, no code re-research". The style answer goes to `people/<member>.md`; added repos are united |
| `done` exists, requested depth deeper than before (`standard` -> `deep`) | `deepen` | Re-initialization. Redo the code research at deep, and restage **every teammate's sessions** still in `bootstrap/*/`. Existing records follow the no-delete and superseded rules as usual |
| `done` exists, `--reinit` given | `project_init` | Re-initialization. Includes every teammate's sessions |

So the accident of "a second person sent a full init again" is absorbed by the
server. `--history-only` stays as a flag that forces `contribute`, and other
full requests after `done` are handled as `contribute` too (the log records
`classifiedAs`).

**Depth conflict rule.** Depth is a property of the project research, not of
a teammate. The first initialization sets the depth and it stays in
`status.json` as `depth`. If a later teammate picks a deeper depth, it is read
as a request to "redo the research deeper" and `deepen` runs (it costs
something, so the skill says so). A shallower depth does not downgrade; it is
ignored. Style is a per-teammate value, so it never conflicts, and the repo
list accumulates.

**The skill's questions depend on the state too.** `/memmem-init` (Claude
Code) and `$memmem-init` (Codex) first look at the project state with
`memmem init --state` (JSON; nothing is uploaded).

- Before initialization: the four questions (depth, related repos, style,
  consent to past sessions).
- After initialization: "This project was initialized by <who> on <when> at
  <depth>. Add your N sessions?" (consent), one line of style, and, only when
  the existing depth is standard, "Redo the code research at deep?" (default
  no). Adding repos is optional.

**Leave out sessions already reflected.** Sessions created after a teammate
ran `setup` have already been handled by the normal ingest and reflection.
Except on a first `project_init`, the server excludes session ids that have a
reflection result in `ingest/log.jsonl` from history staging (and records the
count as `alreadyReflected` in `init_estimate`). A `contribute` also leaves
out sessions an earlier init run already laid out (`alreadyStaged`). The value
lies in the sessions from before `setup`.

**State record.** There is one `status.json` per project, but it holds each
teammate's contribution.

```json
{
  "state": "done",
  "depth": "standard",
  "initializedAt": "...", "initializedBy": ["alice"],
  "members": {
    "alice": { "kind": "project_init", "sessions": 6, "finishedAt": "...", "initId": "..." },
    "bob":   { "kind": "contribute",   "sessions": 14, "finishedAt": "...", "initId": "..." }
  },
  "lastRun": { "initId": "...", "kind": "contribute", "requestedBy": ["bob"], "commits": [ ... ], "usage": { ... } }
}
```

`memmem status` shows **my** contribution, as in "init: done (standard, by
alice) · my sessions: reflected / not reflected". `memmem-server init status`
shows a per-teammate table.

**Concurrency.** One init run per project at a time. Requests that arrive
during a run stay unprocessed (their blob is not yet in `state.initRequests`)
and are picked up by the first pass after it ends; a new request while a run
waits for an answer supersedes that run. If a `contribute` arrives while a `deepen` runs, the later run
reflects only that teammate's sessions.

### 3.6 Member identity: the GitHub login

**Member handle = GitHub login.** The two repos of the team memory are on
GitHub, and every teammate already has a GitHub account with access to them,
so no separate name is invented: the GitHub login is used as the member
identifier. It is unique within the organization, it is the name people use
for each other in PRs and issues, and it can match the commit author.

The handle is used in transcript paths (`trajectories/<month>/<handle>/...`,
`bootstrap/<handle>/...`, `inbox/<handle>/...`), the `member` field of the
ingest header, `Sources:` in reflection commits, `people/<handle>.md`, and as
the transcripts repo commit author. The commit author is
`<handle> <handle@users.noreply.github.com>`, so GitHub attributes the commit
to that account.

**How it is obtained.** `memmem setup` works the handle out instead of asking.

1. If `gh api user --jq .login` works, that value. Only a confirmation message
   is shown.
2. If gh is missing or not signed in, ask for the GitHub login directly, and
   reject empty values and values in the wrong format (`[A-Za-z0-9-]+`,
   GitHub's rule). `--member` is the flag for this question.
3. git `user.name` and the OS username are never used as defaults. This keeps
   the OS username and the GitHub login from ending up as two different
   handles for one person.

`doctor` warns when the handle differs from the gh login
(`member bob != gh login alice`).

**Registration file.** `setup` writes `members/<handle>.json` in the
transcripts repo and commits and pushes it (no secrets).

```json
{ "handle": "alice", "displayName": "Alice",
  "gitAuthors": [{ "name": "alice", "email": "alice@users.noreply.github.com" }],
  "joinedAt": "2026-11-06T...", "aliases": ["alice-old"] }
```

- `gitAuthors` is that PC's git `user.name`/`user.email` (the union across
  several PCs). The server puts this table into the init pre-turn and the
  reflection instruction to say "git author X = member Y". This fills the gap
  where an agent cannot connect a git author to a differently named member
  handle and leaves it as "not confirmed". For a public repo, the email can be
  left out with `--no-email`.
- `displayName` is the `name` from `gh api user` (if any), otherwise the
  handle.
- `githubId`: the numeric `id` from `gh api user`. A login can be renamed but
  the id is fixed, so when another handle is registered with the same
  `githubId`, both treat it as a rename: `setup` adds the old handle to
  `aliases` in the file, and the server treats it as an alias without
  changing any file. A handle typed by hand without gh leaves
  it empty; a later setup on a device with gh fills it in. Paths and labels
  keep using the handle (a numeric id is not readable for people).
- Several devices: GitHub has no notion of devices (same account, same id).
  Each device's git author is merged into `gitAuthors`. No per-device field is
  recorded.
- Older data: records already uploaded under another handle are attributed
  through aliases, but rewriting all older records is not a goal. The
  baseline is that a newly set-up teammate is identified by their GitHub
  login from the start.
- If a file for the same handle already exists, it is treated as another PC of
  the same person and the `gitAuthors` are merged. GitHub logins are unique,
  so no conflict check is needed.
- `aliases` are old handles. Old paths and `people/<old>.md` stay as they are,
  and the server treats an alias as the same person (merging `Sources:` and
  people files is left to reflection).
- `memmem-server members` shows the registration files in a table with each
  teammate's contribution state. There is no delete (they are the authors of
  past records).

The member handle is **not access control.** Access is the GitHub repo
permission. The handle is for attribution (who decided and who had that
session). The server trusts a handle typed by hand without gh too: being able
to push to the repo is itself proof of being a teammate.

## 4. Server-side detail decisions

- **Separate conversation.** Init runs in a new conversation of the project
  agent (the run is named `init-<timestamp>`), not in the normal ingest
  conversation. It does not mix with the reflection
  step count, and a failure can be retried per conversation.
- **Model.** The Letta skill recommends a cheaper model for the history
  analysis subagents (`deepseek/deepseek-v4.1-flash`, or the current model if
  that is not available). Check which handle the connected provider offers,
  keep it in `settings.initHistoryModel` in `projects.json`, and write
  "the subagent model is X" in the pre-turn. Without it, the current model.
- **Cost cap.** Estimate the tokens from the laid-out session bytes (bytes /
  4), log it as `init_estimate` and write it to `status.json`
  (`estimatedTokens`); above `settings.initMaxSessions` (default 200), only the
  most recent sessions are kept.
- **Concurrency.** During init, normal ingest for that project is held back
  until the run settles (to avoid MemFS commit races); while the run waits for
  an answer, ingest goes on. Other projects are not affected.
- **Failure.** A code clone failure, an `INIT: failed` line, or a timeout
  (`settings.initTimeoutMinutes`, default 60) are all recorded in
  `status.json` and `ingest/log.jsonl`. A clone failure leaves the memory
  untouched; commits made before a later failure are kept and pushed.

## 5. Wrapping per coding agent (research results)

Research basis: Codex CLI 0.164, the desktop app (bundling codex 0.163), the
docs at learn.chatgpt.com/codex. "Verified" and "Assumed" follow the research
report.

| Surface | Skill exposure and explicit call | Choice UI | Hooks and AGENTS.md |
|---|---|---|---|
| Claude Code | `.claude/skills/memmem-init/SKILL.md` -> `/memmem-init` appears in the slash menu (Verified, same as the remember skill) | Button choices with `AskUserQuestion` (Verified) | Hooks in the project `.claude/settings.json` (Verified) |
| Codex TUI | `.agents/skills/memmem-init/SKILL.md`. Called from the `/skills` list or with `$memmem-init` (Verified). Individual skills do not appear as `/memmem-init` (Assumed) | Plain-text questions in the default mode. The button-style `request_user_input` is Plan mode only or needs the `default_mode_request_user_input` flag (unreleased) (Verified). Plan mode forbids writes, so it does not suit init | Applied after trusting in `/hooks`; AGENTS.md from git root to cwd (Verified) |
| Codex desktop app | Active skills appear in the slash command list and the `$` and `@` menus (Verified) | Same as the TUI (the handler exists, but default-mode exposure has the same limit) | In-app hook trust flow (Verified). Multi-folder projects use the main folder |
| Codex VS Code extension | `/skills`, `$memmem-init` (Verified) | Assumed: same as the desktop app | Assumed: same rules |

Decisions:

- **Claude Code**: the `/memmem-init` skill. It asks the four questions as
  `AskUserQuestion` choices, runs `memmem init --yes ...`, and points to
  `memmem status` when done.
- **Codex**: `.agents/skills/memmem-init/SKILL.md` committed to the repository
  (no install for teammates; a clone is enough). Called with `$memmem-init` or
  `/skills`. The questions are asked as **one plain-text batch** (the skill
  body lists the four questions and their defaults so the model asks them at
  once), and with the answers it runs `memmem init --yes ...`. Button choices
  get better automatically when Codex opens `request_user_input` in the
  default mode, so the skill only says "use a choice tool if there is one".
  The `AGENTS.md` snippet says to run `$memmem-init` (or `/skills`) to
  initialize the memory.
- **`memmem setup`** installs both skill files in their places and prints
  "codex: initialize the team memory with $memmem-init; Claude Code:
  /memmem-init".
- **Network approval**: Codex's default sandbox blocks the network, so the git
  push of `memmem init` brings up an approval prompt. The skill body says "the
  push step needs network approval" so the user is not caught off guard.
  (Claude Code follows its Bash tool permission policy.)
- Both skill bodies have the same content (four questions, consent wording,
  the command to run, status guidance) and differ only in the tool calls. The
  question wording is taken from the Letta skill as is (Apache-2.0 notice).

## 6. Verification plan (on a real project)

1. Clone the project's code repo on the server, and push this PC's sessions
   of that project (Claude Code and Codex) to `bootstrap/` (including the
   consent step).
2. The worker runs the pre-turn + `init`. Observe: does the skill load, does it
   proceed without questions, does it use the export directory placed in
   advance when `letta trajectories detect` returns 0, do Workflow subagents run
   on the local backend, are commits made per topic, how long does it take and
   how many tokens.
3. A person reads the resulting memory and judges the quality: did it avoid
   duplicating documents owned by the environment, is `Sources:` in the commit
   messages, did it stay within the root budget.
4. Is it reflected in the index at the start of the next session.

## 7. Open questions

- Does the Letta skill work without the Workflow tool (not verified on the
  local backend)? The worker assumes Workflow is available: the pre-turn asks
  for the analysis Workflow with `wait: true`, and the worker follows Workflow
  executions under `$LETTA_CONFIG_DIR/workflows/executions/`.
- Does the skill run `letta trajectories export` again and overwrite the
  directory we placed (the default of `--out` is the same path)? The pre-turn
  says the sessions are already exported and `letta trajectories
  detect/export` must not run again.
- Member attribution of past sessions: Letta infers the user from the git
  author, but our sessions name the `member` explicitly. The pre-turn says
  "the session's member field is the author".
- (Addressed in section 3.6.) The mapping between git authors and member
  handles is given to the server through `members/<handle>.json`. Measured: in
  a real project's init, the agent could not connect a git author to a
  differently named member handle and left it as "not confirmed".
- (Addressed in section 3.5.) Init with several teammates: same-pass merging
  and serialization, state-based classification
  (`project_init`/`contribute`/`deepen`), leaving out sessions already
  reflected, and per-teammate `status.json` are implemented. The skill's
  state-dependent questions follow `memmem init --state`.
