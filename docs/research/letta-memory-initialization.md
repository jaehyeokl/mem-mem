# How Letta Code 0.34.41 initializes memory: `/init` and Claude Code / Codex history

Written November 2026. Purpose: write down, step by step, how Letta first
fills a memory, so that mem-mem can use the same approach. No recommendation
is made.

Notation

- **Verified**: checked directly in the code, skills, docs or PR text.
  **Assumed**: an interpretation combining sources, or no primary source found.
- `LC` = the installed `@letta-ai/letta-code` package directory
  (`<node prefix>/lib/node_modules/@letta-ai/letta-code`, 0.34.41,
  Apache-2.0). `letta.js:N` is a line number in the bundle, `SKILL:N` a line
  number in `LC/skills/initializing-memory/SKILL.md`.
- `docs:<path>` = `https://docs.letta.com/<path>/index.md` (read in November
  2026). PRs are `letta-ai/letta-code#<number>`.
- Only read-only commands were run: the `--help` family and
  `letta trajectories detect` (only counts local sessions). No agent was
  created, `~/.letta` was not modified, and no model was called.

## Summary

1. `/init` is both a TUI slash command and an App Server remote command
   (`execute_command` `init`). Both paths put **one** `<system-reminder>` user
   turn, carrying a git summary and the MemFS path, into the current
   conversation and have the model load the `initializing-memory` skill.
   Everything after that is decided by the skill text.
2. The skill procedure has ten steps: read the existing memory ->
   `letta trajectories detect` -> infer the user from git -> one batch of
   questions -> (with consent) history export and cohort split -> research the
   codebase directly -> read-only Workflow fan-out -> coverage check and
   curation -> structure verification -> per-topic commits.
3. "Importing" Claude Code and Codex history exists only as **a step inside
   `/init` that analyzes it with the user's consent**. There is no separate
   import command, no `/migrate`, and no import menu in first-run onboarding in
   0.34.41. `letta trajectories` has only export/detect/list/view/search.
4. `/reflect` only handles the agent's own Letta conversations. There is no
   argument that takes an external transcript file. The `[transcript_file]`
   argument written in the docs does not match the 0.34.41 code.
5. History is not copied into memory. Subagents return
   `claim/evidence/sessionIds`, and the parent agent synthesizes them into rules
   and facts. Quotes and session ids stay in the commit message's `Sources:`,
   not in memory files.
6. Explicitly not to be copied: the content of `AGENTS.md`, `CLAUDE.md`, README
   and repository skills (owned by the environment, so link them and record
   only the difference), secrets, one-off items (tickets, commit hashes,
   session notes).
7. The resulting shape has no fixed file names. It consists of a root
   `MEMORY.md` without frontmatter (a map to what is not loaded yet),
   `persona.md` and `human.md`, and folders named after the real project
   (`orchard/MEMORY.md` ...). The root stays under about 10% of the context
   (15 to 20k tokens).
8. No team or organization level init or memory template feature was found. A
   headless "import history and run /init without questions" feature is open
   as PR #4825 and not yet merged.

## 1. `/init`

### 1.1 Trigger and the injected message

- **Verified**: the TUI command list at `letta.js:495975`: `"/init"`,
  description "Initialize (or re-init) your agent's memory", no arguments.
  The same list has no `/import`, `/migrate` or `/onboard` (checked by
  extracting every command key).
- **Verified**: the TUI handler at `letta.js:534351`. It refuses if a tool call
  is waiting for approval. It shows the progress text "Building your memory
  palace... Start a new conversation with `letta --new` to work in parallel.",
  then goes through `gatherInitGitContext()` and
  `buildInitMessage({gitContext, memoryDir})` and sends the result **as a user
  message in the current conversation**. It runs in the main conversation, not
  as a background subagent.
- **Verified**: the App Server (WebSocket listener) supports `init` too. It is
  in `SUPPORTED_REMOTE_COMMANDS` (`letta.js:237258`), and `handleInitCommand`
  (`letta.js:465996`) builds the message with the same builder, hands it to
  `handleIncomingMessage`, and returns "Memory initialization completed". The
  MemFS path is included only when `settingsManager.isMemfsEnabled(agentId)`.
- **Verified**: the git summary (`letta.js:465241`) is `branch`,
  `git status --short`, `git log --oneline -n 10`. `gatherGitContextSnapshot`
  uses `process.cwd()` when it is not given a cwd (`letta.js:237080`). init
  does not pass a cwd. The git user (identity) is computed too but not put in
  the message. Outside a git repository the summary says "(not a git
  repository)".
- **Verified**: the message body (`letta.js:465269`) starts with "The user has
  requested memory initialization via /init." It continues with the MemFS
  path, an instruction to call `initializing-memory` with the `Skill` tool, four
  lines of fallback guidance in case loading the skill fails (questions,
  research by depth, incremental writing, verification), and the git summary.
- **Verified**: there is no automatic run, only hints. When a new agent is
  created it shows "Tip: use /init to initialize your agent's memory system!"
  (`letta.js:527327`), and the welcome hint of a conversation without messages
  includes `/init` (`letta.js:534814~534831`).
- **Assumed**: a web search snippet had old docs text saying "MemFS agents run a
  shallow background init on the first message" (that page,
  `docs.letta.com/letta-code/memory`, is now a 404). The 0.34.41 bundle still
  contains quick init subagent definitions `init.md`/`init-v2.md`
  (`letta.js:106655`, `:106762`), but no call that launches them was found
  (`spawnBackgroundSubagentTask` is called only for reflection,
  general-purpose and the normal Task tool). `init` is on the list of
  subagents hidden from the model (`letta.js:107200`). So this is treated as a
  legacy path.

### 1.2 Steps of the `initializing-memory` skill (SKILL.md, 225 lines)

The skill opens with "You own this task through completion" and says research
may be delegated but integration must be done personally (SKILL:10).

| Step | What it does | Source |
|---|---|---|
| 1 Check existing memory | Read the existing memory before changing it. For a new agent, replace the defaults; for an existing agent, restructure. Some files may be shared with other agents | SKILL:84-85 |
| 2 Detect history | `letta trajectories detect`. It has to run before the questions so the agent knows whether to ask about history analysis | SKILL:87-91 |
| 3 Identify the user | Infer without asking: `git shortlog -sn --all \| head -5`, `git log --format="%an <%ae>" \| sort -u`, `git config user.email` | SKILL:93-94 |
| 4 Batch of questions | See 1.3 | SKILL:96-97 |
| 5 History export and cohorts | Only with consent. `letta trajectories export --out /tmp/letta-trajectories` -> `prepare-history.mjs`. See 2.1 | SKILL:99-110 |
| 6 Research the code directly | Read README, `AGENTS.md`/`CLAUDE.md` (including nested ones), package manifests, entry points and recent git history directly. The bar is "can I trace one core feature from entry point to implementation". Write what the docs already cover as a **no-copy list**, and split the research into subsystem areas the docs do not explain and the related repositories received in step 4. In deep mode, add more areas, look for conventions in the git history, trace to the end, and put architecture notes in deferred memory | SKILL:112-115 |
| 7 Analysis Workflow | One `/init` permits one read-only Workflow plus one follow-up for unread cohorts. Subagent tools use the Read/Grep/Glob default. Results are validated with `agent(prompt, {schema})`. The fan-out model is `deepseek/deepseek-v4.1-flash`, or the current model if that is not available. Memory synthesis is not done with the fan-out model. If Workflow is not available, the parent analyzes per cohort and area itself | SKILL:117-153 |
| 8 Curation | Check coverage with `history-coverage.mjs`. Store verified claims as facts and replace stale claims with current facts. Check authorship. After merging, remove duplicates and add up correction counts per cohort. Cover all three categories (identity, rules/preferences, project context), and keep repeated procedures as skill candidates | SKILL:155-176 |
| 9 Verification | Structure (indexes, frontmatter, no `foo.md` next to `foo/`), whether the root earns its place, no duplication of docs, file granularity and names, persona quality, no change of meaning or over-deletion | SKILL:178-185 |
| 10 Commit and report | Commit per topic and list repositories, files and sessionIds in `Sources:`. Do not `git push` (the harness pushes after the turn). If a commit is blocked, report initialization as incomplete | SKILL:187-200 |

### 1.3 What the user is asked (SKILL:96-97)

- **Verified**: with AskUserQuestion if available, otherwise in a normal
  message, all **at once**. The items are (1) research depth (standard/deep),
  (2) other repositories to know about, (3) communication style, (4) only if
  step 2 found sessions, whether to analyze the history, naming the detected
  sources.
- **Verified**: when asking for consent, it must say that "read-only subagents
  read the transcripts with `deepseek/deepseek-v4.1-flash` (or the current
  model)". It must not ask what can be learned from files, git or history, and
  it must wait for the answer. The question tool call finishing is not taken
  as approval.

### 1.4 "Other repositories"

- **Verified**: related repositories received from the user in step 4 are
  included in the research areas in step 6 (SKILL:115). Cohorts are split by
  the session's recorded cwd (`project`), and the `repo` field is filled only
  when that path still exists (`prepare-history.mjs:76-99`). Subagents must
  compare the cohort's `repo` with the current tree and report what changed
  (SKILL:127).
- **Verified**: the example structure gives each project a folder with its
  real name (SKILL:39, 65-78). Several repositories go into one MemFS, split
  by folder.

### 1.5 Size and budget

- **Verified**: the root stays under about 10% of the context (15 to 20k
  tokens); overflow moves down into indexed subfolders with a link left
  behind. Nothing is deleted (SKILL:35).
- **Verified**: the default pre-commit limits are 65,536 chars for all root
  Markdown together (`maxCoreMemoryCharacters`) and 20,000 chars per file
  (`maxFileCharacters`). They are adjusted with `fileCharacterLimits` and
  `readOnlyFiles` in `$MEMORY_DIR/.memfs.config.json`
  (`LC/skills/maintaining-core-memory/SKILL.md:39-45`).
- **Verified**: history cohorts are about 200 KB or 20 sessions each
  (`--max-bytes 200000`, `--max-sessions 20`). The Workflow subagent timeout is
  10 minutes and can be raised with `timeoutMs` (SKILL:110, 128).

## 2. Paths for bringing in existing Claude Code and Codex material

### 2.1 The path in 0.34.41: `/init` steps 5, 7 and 8

- **Verified**: `letta trajectories` does not appear in the top-level `--help`,
  but it works. Its subcommands are `export`, `detect`, `list`, `view`,
  `search`. The help says "Normalize historical coding-agent sessions into a
  single directory of trajectory-v1 JSON files, ready for review by memory
  workers" (`letta trajectories --help`, `letta.js:482844`). Detection and
  normalization are done by `listTrajectories`/`normalizeTranscript` from
  `@letta-ai/trajectory`.
- **Verified**: on the measured host, `detect` found claude-code 71, codex 55,
  letta-code 6, and 0 for deepagents, hermes, openclaw and openhands.
- **Verified**: export options are `--source` (repeatable),
  `--root <source>:<path>`, `--transcript <source>:<path>` (files copied from
  another device, repeatable), `--project <path>` (cwd prefix filter), `--json`.
  The output is `<out>/<source>/<startedAt>_<sessionId>.json` (an array of
  records) and `manifest.json`
  (`version, generatedAt, outDir, sources{discovered,exported}, errors[], sessions[]`).
  The session entry fields are `source, id, sessionId (hash), file, sourcePath,
  project (meta.cwd), startedAt, endedAt, userMessages, assistantMessages,
  toolCalls, reasoningRecords, firstUserPrompt, records, bytes, diagnostics`
  (`letta.js:482577-482700`).
- **Assumed**: no secret removal step was seen in the export code. The skill
  only tells subagents "Never copy secrets" (SKILL:125).
- **Verified**: `prepare-history.mjs` (219 lines) records an exclusion reason in
  the ledger for each manifest session with 0 `userMessages`. The remaining
  sessions are rendered to text with
  `letta trajectories view <file> --out <exportDir> --tools` and written to
  `<out>/rendered/<source>/<session>.txt`. This is because Workflow subagents
  can only use Read/Grep/Glob. Then it builds size-capped cohorts per project
  in time order and writes `cohorts.json`
  (`{historyCohorts:[{id, repo, sessions:[{sessionId,path,source,project,startedAt,userMessages}]}]}`)
  and `ledger.json` (the exclusion list with reasons, export errors).
- **Verified**: when rendering, tool results are cut at 500 chars, reasoning at
  300, and tool arguments at 150 (`letta.js:482834`).
- **Verified**: there are two Workflow result schemas (SKILL:131-149). For
  history: `{sessionsRead:[cohort sessionId enum], findings:[{claim, evidence, sessionIds}]}`;
  for code areas: `{area, findings:[{claim, evidence, paths}]}`. Coverage is
  counted only from `sessionsRead` (SKILL:151).
- **Verified**: `history-coverage.mjs` (129 lines) collects only validated
  `sessionsRead` from the Workflow `journal.jsonl`
  (`${LETTA_CONFIG_DIR:-~/.letta}/workflows/executions/<id>/journal.jsonl`) and
  reports analyzed, unread, excluded and export errors. Unread sessions are
  split into smaller cohorts and written to `retry.json` (SKILL:158-166). If
  coverage is incomplete, the agent must say so and record the gap in deferred
  memory.
- **Verified**: there are authorship rules too. The `user` turns of Claude Code
  and Codex worker sessions may be prompts written by a parent agent, and a
  `<system-reminder>` injected by the harness is not something a person said
  (SKILL:124). Repetition alone cannot establish authorship: a template reused
  in 50 sessions just repeats 50 times (SKILL:170). The skill puts it as:
  "other coding agents' `user` turns are not necessarily your human
  collaborator speaking" (SKILL:20).

### 2.2 What 0.34.41 does not have

- **Verified**: no import, migrate or onboard command. Not among all the TUI
  command keys, and not among the `letta --help` subcommands (`letta install`
  installs skills and modes). The `letta memory` subcommands are only
  `status, diff, backup, backups, restore, export, pull, tokens`. `letta setup`
  is a menu to choose "local mode or Letta login".
- **Verified**: the `/reflect` arguments are
  `[--recent N | --conversation ID ... | --auto] [--instruction TEXT]` (parser at
  `letta.js:465430`, command list `"/reflect"`). Any other argument gives a
  Usage error. The payload is built by `buildMultiReflectionPayload`
  (`letta.js:460134`), which cuts the unreflected part out of **the agent's own
  conversation transcripts** (up to 50 turns per conversation, 150,000 chars in
  total). docs:platform/cli/slash-commands says `/reflect [transcript_file]`,
  which differs from the code.
- **Verified**: `--personality claude|codex` is a persona preset ("Vanilla
  Claude flavors"/"Vanilla Codex flavors", `letta.js:101941`). It has nothing
  to do with importing history.
- **Verified**: `native-session-capture` (`letta.js:248946~`) reads
  `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR`) and `~/.codex/sessions` (or
  `$CODEX_HOME`). But this is a feature that uploads Claude Code and Codex
  sessions that Letta **launched itself** through the Agent tool to Letta
  Cloud. It works only with a cloud server URL and does not import past
  history.
- **Verified**: `CLAUDE.md` and `AGENTS.md` are not imported. The model just
  reads them in step 6. The one place they load automatically is the path that
  attaches the root `AGENTS.md` to the result of the `EnterWorktree` tool
  (`letta.js:236423`). The bundled `project.mdx` block template has the
  sentence "read AGENTS.md, CLAUDE.md, README early if present", but it is not
  among the default block labels (`persona`, `human`) (`letta.js:100834`).
- **Verified**: the docs have no import page either. The llms.txt index has no
  document on importing from or migrating off Claude Code, Codex or Cursor.
  docs:configuration/memory only says about `/init` that it "inspects the
  repository" and "can review prior coding sessions using subagents".

### 2.3 History (GitHub)

- **Verified**: #907 (2026-02-12) added the `history-analyzer` subagent and a
  "Migrating from Codex and Claude Code" skill. That skill is still on
  skills.sh but no longer in the repository's `src/skills/builtin`. The last
  change to that path was #1609 (2026-04-02).
- **Verified**: #1707 "add /migrate command for Claude Code / Codex history
  analysis" was closed without merging (2026-07-03). Its test plan included
  detecting `~/.claude/history.jsonl`.
- **Verified**: #4643 (merged 2026-09-25, v0.33.2) created the current
  structure. It introduced trajectory cohorts, a read-only Workflow validated
  by schema, and the coverage script, and retired `history-analyzer`. The PR
  text says the local backend classified memory as v1 at the time, so "Local
  `/init` therefore must not be treated as validated v2 behavior". It also
  states that a real full `/init` run was not verified.
- **Verified**: #4825 (open, not merged) adds
  `letta --backend local import <trajectory-folder> --agent <id>`. It creates
  one out-of-context local conversation per session and runs an initialization
  turn "like /init" headless. That turn's `<system-reminder>` says to read the
  skill but not ask questions, not to detect other history, to always analyze
  with Workflow, and to treat source text as untrusted evidence. After that it
  keeps sending reminders in the same conversation with the journal results,
  up to 50 unread sessionIds, and up to 4 follow-up runs, until coverage is
  complete. Success means a validated read of every session and a new MemFS
  commit. A second import into the same agent is refused.

## 3. What must not go into memory: environment-owned versus agent-owned

- **Verified**: skill principle (SKILL:18): `AGENTS.md`, `CLAUDE.md`, README
  and repository skills are owned by the environment. Any agent in that
  environment reads them directly, and a copy goes stale first. So link the
  original and keep only "my difference", for example rules that keep being
  broken, or what the docs get wrong or leave out. It adds that this principle
  does not mean information only I have (stable preferences, chronic
  corrections, real pitfalls) may be compressed away.
- **Verified**: the system prompt (`letta.js:100074`): "Skills and files
  belonging to the environment stay with the environment (e.g. `AGENTS.md` or
  `.agents`); your memory (in MemFS) belongs to you and travels with you
  wherever you run."
- **Verified**: step 6 builds the no-copy list (SKILL:115). Code area subagents
  are told which docs cover their area and report only what is missing from,
  contradicts, or is stale in those docs (SKILL:126). Step 9 greps the memory
  for such rules, and especially checks that repository conventions did not
  end up in files about people (SKILL:182).
- **Verified**: what must not go into the root (core) is one-off items:
  tickets, commit hashes, session notes (SKILL:14). Store patterns, not
  anecdotes. Sentences like "Prefers terse responses" or "debugged the March 3
  crash" are not memory; a rule with the concrete command, path, and the
  failure it prevents is (SKILL:22). Generic repository facts are skipped
  unless they change how work is done (SKILL:174).
- **Verified**: provenance (quotes, who, when, sessionId) goes into the commit
  body and `Sources:`, not into memory files (SKILL:174, 216). The results in
  `/tmp` and the journal are temporary files that do not remain as evidence.
- **Verified**: secrets are forbidden (SKILL:125, 221). The system prompt says
  memory is tracked in git and may sync off the device, so refer to secrets as
  `$SECRET_NAME` (`letta.js:99946~` letta_root_memfs). Content that is easy to
  get again through conversation search or by re-reading a file is not written
  into core either (same prompt).

## 4. The shape of memory after initialization

- **Verified**: harness constraints (SKILL:28-33). A root `MEMORY.md` must
  exist, and no `MEMORY.md` has frontmatter. **Every directory** on the path to
  a memory file must have a `MEMORY.md`. Other files have **only two keys**,
  `name` and `description`. `description` states the purpose and category, not
  the content. A file and a folder with the same name, like `human.md` and
  `human/`, cannot coexist. Skills go in `skills/<name>/SKILL.md` and are not
  put in the index. Beyond that there are no fixed file names, counts or
  depths.
- **Verified**: skill examples (SKILL:59-78). The skill calls them
  "Illustrations, not templates to fill in".
  - Minimal: a single `MEMORY.md`.
  - Expanded: `MEMORY.md`, `persona.md`, `human.md`,
    `orchard/{MEMORY.md, architecture.md, gotchas.md, history/{MEMORY.md, corrections.md}}`.
- **Verified**: the root `MEMORY.md` example (SKILL:43-51) has one line on who
  you work with and on what, one line saying "repository conventions are in
  `AGENTS.md`, read them there", and the link `[orchard](orchard/MEMORY.md)`
  with when to read it. It does not list again the root files already in the
  system prompt (SKILL:41). An index that points to nothing is worse than the
  content it pushed out (SKILL:53).
- **Verified**: the compiled format (`maintaining-core-memory/SKILL.md:8-37`).
  Root files become blocks like
  `<human><description>...</description>body</human>` in alphabetical order of
  file name, followed at the end by `<memory>` (the body of the root
  `MEMORY.md` + the auto-generated
  `<deferred-memory><directory path index/>`). The frontmatter example is
  `name: human` / `description: Who the user is and how they want to work together.`
  Changes take effect only after a commit, and from the next system prompt on.
- **Verified**: the initial MemFS of a new local backend agent is `MEMORY.md`
  (`# Memory`), `human.md`, `persona.md`; the layout policy is `root-marker`
  and there is no `system/` (our own measurement). The default `persona.md`
  body is "I'm a coding assistant, ready to be shaped by how we work together."
  (`letta.js:100255`).
- **Verified**: the commit format (SKILL:206-221) is
  `memory(<origin>): <what was learned>` + a body with the background + a
  `Sources:` line (conversation id and message id, who, date, what happened).
  The origin is `self` for a direct edit and `dream` for reflection or
  dreaming. One commit per learning, with author
  `--author="${AGENT_NAME:-$AGENT_ID} <$AGENT_ID@letta.com>"` (SKILL:190).
- **Verified (legacy)**: the `init-v2.md` subagent (no current call path, see
  1.1) has a simpler shape. It reads `CLAUDE.md` or `AGENTS.md`, the manifests
  and README in one go. It creates 5 to 8 flat files named after the project at
  the root, such as `letta-code-overview.md`, each 15 to 30 lines; the overview
  is a 10 to 15 line index. `human.md` and `persona.md` are written
  independently of the project. The commit message is
  `feat(init): initialize memory for project`, and no worktree is used
  (`letta.js:106762-106865`).

## 5. Team or organization level initialization

- **Assumed (not found)**: there is no team memory init procedure or memory
  template feature anywhere in the bundle, the skills or the docs
  (teams/quickstart, concepts/shared-memory, agent-sdk/repositories).
  docs:teams/quickstart only describes sharing at the level of "Users in a team
  can shared agents and memory with each other".
- **Verified**: a shared memory repository
  (`LC/skills/managing-shared-memory/SKILL.md`) is a git repository hosted by
  Letta Cloud and owned by the organization. The commands are
  `letta shared-memory list/create/attach/detach/sync/history`, and it can also
  be handled with the SDK's `client.repositories` and REST `/v1/repositories`.
  There is no step to put in initial content or choose a template at creation.
  It is outside the system prompt, so writing to it does not change the
  in-context memory (same file :105). Cloud only
  ([letta-memory-organization.md](letta-memory-organization.md), summary item
  5).
- **Verified**: the means of pre-filling memory when creating an agent is
  `letta agents create --body <json>`. It uses the request's system prompt,
  model, memory blocks and tags as given. There is also a `--personality`
  preset (`letta agents --help`). Another way, as `memmem-server project add`
  does, is to put files into MemFS and commit them directly.

## 6. What mem-mem can take as is, and what has to change (facts only)

### 6.1 What can be taken as is

- **Input list**: README, `AGENTS.md`/`CLAUDE.md` (including nested ones),
  package manifests, entry points, recent git history (SKILL:113). For user
  identification, `git shortlog` and `git log --format` (SKILL:94). Past
  sessions are in the trajectory-v1 record format.
- **Scripts (Apache-2.0, reusable with the notice kept)**:
  `LC/skills/initializing-memory/scripts/prepare-history.mjs`,
  `history-coverage.mjs`. They need a manifest
  (`sessions[].{sessionId, source, file, project, startedAt, userMessages}`) and
  the session JSON, and rendering uses `letta trajectories view` (the
  executable can be set with the `--letta` option). The mem-mem server image
  already contains letta 0.34.41.
- **Skill text worth taking verbatim** (Apache-2.0): the five principles
  (SKILL:12-22), the harness constraints (SKILL:24-35), the Workflow subagent
  requirements and schemas (SKILL:120-151), the curation rules
  (SKILL:168-176), the verification checklist and `find` commands
  (SKILL:178-185), the commit format (SKILL:202-221). The commit format is
  repeated in `managing-shared-memory/SKILL.md:82-101`.
- **The App Server remote command `init`**: through the same `execute_command`
  path the mem-mem worker uses to send `reflect`, it can send `init` too
  (`letta.js:237258`, `:465996`). All this command does is put in one user turn
  with the git summary and the instruction to call the skill.
- **Precedent for a headless variant**: the initialization reminder design of
  #4825 (no questions, the consent scope stated, sources untrusted, Workflow
  required, unread ids injected again when coverage falls short, up to 4 times,
  completion judged by a new commit). It is not merged, so it is not in
  0.34.41.

### 6.2 What differs because of the mem-mem structure

- **There is no person**: step 4 of the skill says to send the batch of
  questions and wait for the answer (SKILL:97). The mem-mem agent only receives
  turns sent by the worker on the server, so sending `init` as is could stop at
  this step or proceed without answers (Assumed). Depth, related repositories,
  communication style and consent to history analysis have to be put into the
  instruction in advance. #4825 replaced this step with "do NOT ask the user
  questions".
- **History lives elsewhere**: `letta trajectories detect/export` reads
  `~/.claude`, `~/.codex` and so on **of the machine it runs on**. The mem-mem
  server has no teammate sessions. The sessions are already normalized in
  transcripts repo B under `trajectories/<month>/<teammate>/<tool>/...json`. So
  instead of detect/export, build a manifest from B (fields in 6.1), or use
  `--transcript <source>:<path>` when the raw file is available. Whether B's
  files are plain record arrays or have a `meta` wrapper needs checking for
  `trajectories view` compatibility (not verified). mem-mem took a third way:
  `memmem init` uploads, with consent, plain record-array copies and a
  manifest under `bootstrap/<member>/`, and the worker lays them out where the
  skill expects an export
  ([project-initialization.md](../design/project-initialization.md)).
- **The code is not on the server**: step 6 assumes reading the repository
  directly. The `init` git summary is computed from the App Server process's
  cwd (`letta.js:237080`). At the time of this research, the mem-mem server
  container had only the memory repo and the transcripts repo, no clone of the
  project source. Code research needs either a source clone on the server, or
  the client (`memmem init`) collecting and sending README, `AGENTS.md`,
  `CLAUDE.md` and a git summary. mem-mem now does the first: the worker clones
  the code repo named in the request, and the client sends only a git
  summary.
- **It is several people's history**: Letta's authorship check is a rule that
  separates "one human + other agents' prompts". mem-mem can tell teammates
  apart by the path and the `member` in `meta`, but it is still true that the
  `user` turns of Claude Code and Codex worker sessions may not be a person
  speaking (SKILL:124).
- **human/persona mean something else**: in Letta, `human.md` is the one person
  you collaborate with and `persona.md` the agent identity. The mem-mem template
  has `human.md` (the team), `persona.md` (for the server agent, left out of
  the client injection), `project.md`, and `decisions/ changes/ context/ people/`.
  As long as Letta's constraints are kept (a `MEMORY.md` per folder, two
  frontmatter keys), fixed file names do not fail verification (SKILL:33
  "Nothing else is mandated").
- **Fan-out model**: if `deepseek/deepseek-v4.1-flash` is not available, use the
  current model (SKILL:129).
- **Workflow and the local backend**: the Workflow SDK loader in the 0.34.41
  bundle has `createLocalClient` (`backend: "local"`) (`letta.js:256207`).
  #4825 says it fixed SDK and App Server connection problems for local
  Workflow. Whether Workflow actually runs on the mem-mem server was not checked
  (not verified). If it does not, the fallback the skill defines is for the
  parent to analyze per cohort itself (SKILL:153).
- **Push responsibility**: the skill says not to `git push`; the harness pushes
  (SKILL:198). In mem-mem, Letta does not push reflection merges, so the worker
  pushes `main` to A. Init commits are made directly to MemFS by the main
  conversation, so they may be covered by the post-commit push hook (Assumed;
  that hook acts only on direct commits to `main`). The mem-mem worker pushes
  `main` after an init run either way.
- **Where the conversation runs**: `/init` puts its turn into the current
  conversation. Putting it into mem-mem's daily ingest conversation would mix it
  with the ingest records. #4825 creates a separate conversation per session and
  runs the initialization turn separately. mem-mem runs each init in a new
  conversation of the project agent.
- **Secrets**: Letta's export shows no removal step (Assumed). The mem-mem
  client removes secrets before pushing. Because of this difference, input built
  from B is one step more sanitized than an export.
