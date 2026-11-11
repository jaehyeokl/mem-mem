# Team memory architecture

Written November 2026. This is the architecture of mem-mem, checked against
measurements of Letta Code ([research/letta-measurements.md](../research/letta-measurements.md)).

---

## 1. Design principles

1. Use Letta as it is: MemFS, reflection (Dreaming), trajectory normalization,
   the App Server, and its model providers.
2. Git is the truth. A project's memory is one repo in the GitHub
   organization. The server is the one that updates it; teammates consume it.
3. Do not alter the prompt. Only give an index and a note saying "read the
   files directly".
4. The client does not depend on Letta Code. Only git, hooks and one small
   binary.
5. Models are changed in one place.

## 2. Components

### A. Memory repo (GitHub organization, one per project): `<org>/mem-<project>`

The MemFS remote of the Letta agent. The layout follows the **MemFS
conventions verified in the measurements**.

```
MEMORY.md                 # Index. No frontmatter. Points to the root core files and the subdirectories
persona.md                # Created by Letta. The agent's identity (team memory keeper role, recording rules). name/description frontmatter
human.md                  # Created by Letta. Team introduction (members, roles). Injected into teammates' sessions (persona.md is not)
project.md                # Root core: project identity, current goals, core rules (short)
decisions/MEMORY.md       # Decision index
  YYYY-MM-DD-<slug>.md    #   Decision, reason, alternatives, change history. frontmatter: name, description (status, superseded_by, sources go in the body)
changes/MEMORY.md         # Change summaries
context/MEMORY.md         # Domain and external system context
people/MEMORY.md          # Ownership and conventions
```

- There is no `system/` folder in the MemFS conventions. **Root `.md` files are
  the core memory** (injected into the system prompt on every turn), and a
  subdirectory is memory only when it has its own `MEMORY.md`. Files in
  subdirectories must have `name` and `description` frontmatter (Letta's
  memory constraint hook checks this).
- Where reflection writes what is steered by **the rules in `persona.md` and
  `MEMORY.md`**. In the measurements, reflection respected the existing index
  structure and created files under `projects/`. When the template creates
  `decisions/` and the other folders in advance, reflection follows that
  structure (an item to verify).
- Reflection makes the commits. The message carries the trailers
  `Reviewed transcripts:` (the reflection input paths),
  `Generated-By: Reflection` and `Agent-ID:`. Human edits go through PRs.

### B. Transcripts repo (GitHub organization, one per project): `<org>/mem-<project>-transcripts`

Stores **normalized transcripts only**. Raw JSONL is not stored.

```
trajectories/<YYYY-MM>/<member>/<tool>/<startedAt>_<sessionId>.json   # @letta-ai/trajectory v1 format (~13% of the raw size)
inbox/<member>/<YYYY-MM-DD>-<slug>.md                                  # memmem remember notes
ingest/log.jsonl                                                       # Written by the worker: file -> agent conversation ID -> reflection commit SHA
```

The repo also holds `project.json` (project facts and memory language),
`members/<handle>.json` (member registration) and `bootstrap/` (project init,
see [project-initialization.md](project-initialization.md)).

- Size: in the measurements, three people produced about 400 MB of raw
  transcripts in one week, which normalizes to about 55 MB per week. That is
  around 2.5 GB a year, so **a retention policy is required**: month
  directories older than 90 days move to an `archive/<YYYY-MM>` branch (or to
  server disk), and `main` keeps only the last three months. This is not
  automated yet (`RETENTION.md` in the transcripts repo template describes it).
- Normalization happens **in the client hooks** (the `@letta-ai/trajectory`
  package, bundled into the single `memmem` binary; neither Node nor Letta
  Code is needed). Server-side normalization is possible, but then the raw
  transcript has to be sent and the size problem comes back.
- The raw transcripts stay on each teammate's machine (Claude Code
  `~/.claude/projects`, Codex `~/.codex/sessions`). The normalized version
  includes user and assistant messages, tool calls and results, so the need to
  "look up the basis of a decision again" is met by the normalized version.
- Before sending, secret-like strings are redacted (best-effort patterns,
  replaced with `[REDACTED:<type>]`) and normalized files over 5 MB are
  skipped.

### C. Memory engine server (one server of your own)

**Letta App Server**

- `letta server --backend local --listen ws://127.0.0.1:4500 --openai-api`,
  started by `memmem-server start` (loopback only. There are no external
  clients, so no auth configuration is needed).
- One agent per project (`letta agents create --name <project>`, run by
  `memmem-server project add`). Each agent's MemFS has
  `letta.memoryRepository.url` = repo A.
- Provider: a model provider connected with `letta connect`. The agent model
  (per project, recorded in `projects.json`) and the reflection model
  (`model:` in `<LETTA_CONFIG_DIR>/agents/reflection.md`, server-wide) are set
  with `memmem-server setup`, `project add`, `model set` and
  `model set-reflection`.
- Letta's own reflection trigger is not used: the worker opens its sessions
  with `dreaming: {trigger: "off"}` and launches every reflection itself
  (below), because an automatic reflection cannot carry the worker's
  instruction.

**Ingest worker (implemented here, Node/TypeScript, using Agent SDK 0.8.x)**

1. Poll repo B every `MEMMEM_POLL_SECONDS` (default 60; there is no webhook)
   and detect new or changed `trajectories/` and `inbox/` files. The
   position is kept in local state (the last commit SHA).
2. Turn the normalized transcript into **ingest text**: a header
   `<team-memory-ingest project= member= tool= session= started=>` + one line
   of instruction ("You are this project's team memory manager. Reply with one
   sentence only, and leave memory updates to the background reflection") + `[user]/[assistant]/[tool_call]/[tool_result]`
   lines. Split it when it exceeds a length limit (`ingestMaxChars`, default
   40k chars). A re-synced session sends only its new records.
3. **Inject a turn into the App Server**:
   `client.createSession(agentId, {cwd, dreaming:{trigger:"off"}})` for the
   project's daily ingest conversation (resumed while the date is the same)
   -> `session.send(text)` ->
   consume the stream until the result. One turn is about 20k tokens of system
   prompt plus the body.
4. **Reflection**: the worker launches every reflection itself (30 to 60
   seconds each), after every `stepCount` ingested sessions and once a day:
   `session.sendCommand({type:"execute_command", command_id:"reflect", args:"-- <instruction>", runtime:{agent_id, conversation_id}})`.
   The instruction carries the MemFS paths, the memory language, the member
   table and a required final `RESULT:` line.
5. **Completion detection and push**: detect a change of
   `last_reflection_succeeded_at` in
   `$LETTA_CONFIG_DIR/transcripts/<agent>/<conv>/state.json`, check whether
   MemFS `main` moved and classify the outcome (committed, nothing to save,
   failed) -> `git -C <memfs> push <A url> main:main`. **Letta's hooks do not
   push reflection results, so the worker must push.**
6. Record (file, conversation ID, reflection commit SHA, time) in
   `ingest/log.jsonl` and commit it to B.
7. Retry on failure; back off on provider errors (quota exhausted and so on).
   A failed reflection is retried once, then its sessions are carried forward
   to the next reflection.

**When Dreaming runs (aligned with Letta's own trigger)**

- Letta's step count is "number of agent steps", and one injected turn is one
  step. So `stepCount = N` means "one reflection per N sessions ingested".
  mem-mem's own `stepCount` setting counts distinct ingested session files, so
  a session synced several times counts once until a reflection covers it.
- As implemented: one **daily ingest conversation** per project (replaced by a
  new conversation every day so context does not pile up), `stepCount = 3`
  (one reflection per three sessions), and a daily `execute_command reflect`
  at `dailyReflectHour` (default 23, local time) for what is left (also
  acting as the trigger that copes with compaction). With quota to spare,
  `stepCount = 1`.
- A weekly "consolidation reflection": in a new conversation, pass an
  instruction (`--instruction <text>` as the args of `execute_command reflect`)
  that asks it to clean up duplicates and contradictions among the past week's
  decisions. Not implemented yet.

The headless `letta -p` path is not used, because it creates neither
transcripts nor reflections.

### D. Client adapter (each teammate's environment)

Common: `.memmem/config.json` in the working folder (project, memoryRepo,
transcriptsRepo, language, layoutVersion; the member handle is in the
git-ignored `.memmem/local.json`). The memory repo is cloned into
`<project>/.memmem/memory/` (git-ignored) and the transcripts repo into
`~/.local/share/memmem/<project>/transcripts/`. The memory the model has to
read lives inside the project (and so inside the agent's sandbox); the
transcripts live outside it. The client is one binary (no Node needed;
trajectory normalization is bundled); Claude Code and Codex differ only in
their hook configuration
(measured: the two CLIs' `SessionStart`/`Stop`/`SessionEnd` events and their
`transcript_path` and `additionalContext` fields are almost identical).

**Reading**

- `SessionStart` hook: `git pull` -> inject the root `MEMORY.md`, the root
  core files (`project.md`, `human.md` and so on; `persona.md` excluded) and
  each first-level folder's `MEMORY.md` as `additionalContext` (24,000
  character budget), together with a paragraph saying "There is a team
  memory. For details, read the files under `<project>/.memmem/memory/`
  directly."
- The model reads files when it needs them. The same as Letta's progressive
  discovery.
- Codex: `SessionStart` in `~/.codex/hooks.json` (user mode, the default) or
  `<repo>/.codex/hooks.json` (shared mode). In shared mode the `AGENTS.md`
  block carries fixed guidance and the remember behaviour; in user mode the
  injected intro points at `.memmem/guide/remember.md` instead.

**Writing (explicit notes)**

- The remember skill (a Claude Code skill; Codex gets the same instruction
  from the `AGENTS.md` block; in user mode both follow `.memmem/guide/remember.md`)
  runs `memmem remember`, which commits and pushes a note to `inbox/<member>/`
  in B. The worker includes it in a turn. When a sandbox makes the data folder
  read-only, the note waits in `<project>/.memmem/outbox/` until the next sync.
- Editing repo A directly is not allowed in phase 1. Use a PR if needed.

**Sync**

- `SessionEnd` hook (and, while a session runs, `Stop` at most every 30
  minutes when the transcript grew, and `PreCompact`): normalize the raw
  transcript at `transcript_path` with `@letta-ai/trajectory` -> redact
  secrets -> commit and push to `trajectories/` in B. Codex session files may
  be `.zst` compressed, so there is a decompression step. In Claude Code
  `SessionEnd` has a 1.5 second budget, so the real work is split off into a
  background process.
- When the same session is synced several times, the file with the same
  sessionId is overwritten (idempotent), and the worker sends only the new
  records.

### Why hooks and skills, not MCP

There are three ways to add outside functionality to Claude Code and Codex CLI.

| Way | When it runs | Who decides | Use in mem-mem |
|---|---|---|---|
| Hook | The CLI runs a command on **lifecycle events** such as session start, end of a response, right before compaction, session end | The CLI (automatic, no model involvement) | Injecting the memory index (`SessionStart`), sending transcripts (`Stop`, `PreCompact`, `SessionEnd`) |
| Skill / `AGENTS.md` | The model reads instructions and runs a command **on its own, based on the situation** | The model | The remember skill that calls `memmem remember` when you say "remember this" (Claude), and an `AGENTS.md` snippet with the same content (Codex); the `memmem-init` skills (`/memmem-init`, `$memmem-init`) |
| MCP server | The model uses an external server's functions through **tool calls** | The model | Not used |

Why not MCP: the team memory is **files**, cloned with git into each
teammate's project folder (`.memmem/memory/`). The index is injected at session
start, and the model reads the files it needs with its own file tools. There is
no reason to run a separate server or keep tool schemas resident in the model
context, and it is the same way Letta Code shows memory to its own model (an
index plus reading on demand). If the memory grows to the point where search is
needed, MCP tools (for example decision search) can be considered then.

In short: **what has to happen automatically is a hook; what reacts to what
the user says is a skill.**

## 3. Data flow

1. Session start -> the hook pulls A -> injects the index and the core files.
   The prompt stays as it is.
2. During work the model reads files in A.
3. "remember this" -> the remember skill -> `memmem remember` -> `inbox/` in B.
4. Session end (or a checkpoint) -> the hook normalizes and redacts ->
   `trajectories/` in B.
5. The worker detects B -> builds the ingest text -> App Server turn ->
   (every `stepCount` sessions, and daily) a reflection the worker launches ->
   MemFS commit -> **the worker pushes to A** -> records `ingest/log.jsonl`.
6. The next session goes back to step 1 and gets the updated index.

Measured: a turn takes 3 to 4 seconds, a reflection 30 to 60 seconds, and a
commit changes 1 to 3 memory files.

## 4. How the requirements are met

| Requirement | How | Measured basis |
|---|---|---|
| Everyone keeps their own Claude/Codex | D is git + hooks + one `memmem` binary | Codex and Claude Code hooks checked |
| Both tools use the same memory | Both read A and write B | trajectory supports both formats |
| Prompt unchanged, index guidance | Only MEMORY.md, core files and folder indexes at SessionStart | Same as how MemFS injects the root |
| Conversations and work results are reflected | Normalized transcript turn -> reflection | Worked for both synthetic and real sessions |
| Decisions, changes and reasons accumulate | decisions/ structure + Git history | Reflection recorded decisions, reasons, paths, open items |
| Look up the raw source and basis again | Normalized transcripts in B + ingest/log mapping | Normalized version includes user/assistant/tool |
| Use Dreaming | `execute_command reflect` launched by the worker (every stepCount sessions + daily) | Both checked |
| Hand-over | Index injected every session | n/a |
| Self-hosting | App Server local backend | Startup and SDK connection checked |
| Memory per project | A/B + agent per project | n/a |
| Git history | MemFS = Git, worker pushes | Manual push checked; automatic push added by the worker |

## 5. What is implemented here

1. **Ingest worker** (C): detection, ingest text conversion, SDK turns,
   reflection completion detection, push, logging, retries, and project init
   (Letta's `/init` run headless, see
   [project-initialization.md](project-initialization.md)). `projects.json`
   (project <-> agent <-> repo mapping, model handles, memory language,
   `stepCount`, `dailyReflectHour`).
2. **Client adapter** (D): the `memmem` binary (`session-start`, `sync`,
   `remember`, `init`, `status`) + Claude Code hook and skill configuration +
   Codex hook and skill configuration.
3. **Repo templates and creation script**: the initial layout of A
   (MEMORY.md, project.md, persona.md rules, empty indexes such as
   decisions/), the initial layout of B, and `memmem-server project add`,
   which creates the GitHub repo pair and creates and connects the agent in
   one go.
4. **(Later, not implemented) Raw transcript search**: expose
   `letta trajectories search` or our own full-text search on the server as an
   MCP server.
5. **(Later, not implemented) Permission routing**: GitHub repo permissions
   are used.

## 6. Decisions

1. Transport: **Git based**.
2. Transcript storage: **only normalized transcripts in Git**; raw transcripts
   stay on teammates' machines. 90-day retention policy (not automated yet).
3. Direct writes by teammates' AI: **not allowed in phase 1**, PRs only.
4. Reflection path: **App Server + SDK**, every reflection launched by the
   worker with `execute_command reflect` and its own instruction (Letta's
   automatic trigger is off).
5. Weekly consolidation: a forced reflect with `--instruction` (not
   implemented yet). "Agent reviews before applying"
   (`reflectionMerge: explicit`) is not used in phase 1.

## 7. Still to verify (during the build)

1. Exact token and quota consumption of one reflection (from the provider's
   usage reporting, or by watching consumption after a day of operation).
   Token counts are now recorded per ingest turn, reflection and init run
   (`memmem-server usage`); the provider-side quota is still unmeasured.
2. Whether reflection follows the structure created in advance by the
   template (`decisions/` and so on), and whether the persona rules steer it
   enough.
3. Prompt token growth and whether compaction happens when the ingest
   conversation is replaced daily.
4. `.zst` session handling and the `SessionEnd` time budget in Codex hooks.
   Done: the client decompresses `.zst` with `zstd` and detaches the sync from
   the hook.
5. Running the retention policy of repo B in practice (automating the move to
   the archive branch). Not automated yet.
6. Quality and speed differences when the model handle changes.

## 8. Phases

- **Phase 0, measurements**: done.
- **Phase 1, one person and one project** (two weeks of use): worker + Claude
  Code adapter + templates. Run it on one real project and check items 1 to 3
  of section 7. The worker, the Claude Code adapter and the templates are
  built.
- **Phase 2, team**: two more teammates, the Codex adapter, two or more
  projects. Items 4 and 5 of section 7. The Codex adapter, several projects
  per server and member handles are built; retention is not.
- **Phase 3, quality**: raw transcript search MCP, weekly consolidation,
  permissions. Not implemented.
