# memmem-server: the ingest worker

This is the worker half of `memmem-server` (operator commands: [README.md](README.md)).
`memmem-server start` runs it in-process next to the Letta App Server.

The worker reads normalized session transcripts from each project's
transcripts repo and sends them to the project's Letta agent, one turn per
session, through the Letta Code App Server. It then triggers Letta's
background reflection ("dreaming") with its own instruction, waits for it to
update the agent's MemFS, and pushes MemFS `main` to the project's memory
repo.

TypeScript, Node 24, ESM. Runtime dependencies: `@letta-ai/letta-agent-sdk`
(0.8.70, remote/portable entry only) and `ws`.

## How a pass works

The worker runs one pass every `MEMMEM_POLL_SECONDS`. It handles projects one
at a time, and an error in one project never stops the others.

1. **Pull.** Clone the transcripts repo, or fetch it and hard-reset to the
   remote's default branch, under `$MEMMEM_REPOS_DIR/<project>/transcripts`.
   The worker never keeps local commits there.
2. **Detect.** Queue the files that were added or modified under
   `trajectories/**/*.json` and `inbox/**/*.md`, using
   `git diff --name-only --diff-filter=AM <lastSeenCommit> HEAD`. On the first
   run, or when the cursor commit no longer exists, it lists every file and
   skips any whose blob was already ingested.
3. **Convert.** Turn each file into ingest text (see `src/ingest-text.ts`):
   - Trajectories (`@letta-ai/trajectory` v1, either `{records:[...]}` or a
     bare array) become
     `<team-memory-ingest project member tool session started>`, then one
     English instruction line (reply with one sentence, leave memory updates
     to reflection), then `[user]`, `[assistant]`, `[tool_call]` and
     `[tool_result]` lines.
     - `member`, `tool`, `session` and `started` come from the path
       `trajectories/<YYYY-MM>/<member>/<tool>/<startedAt>_<sessionId>.json`.
       When the path doesn't match, they fall back to the `meta` record.
     - Each message is capped at `messageMaxChars`, tool args at 300 chars and
       tool results at 400 chars. `reasoning` and `meta` records are not sent.
     - A session longer than `ingestMaxChars` is split into parts
       (`part="i/n"`), one turn per part.
   - Inbox notes become `<team-memory-note project member file>`, then an
     instruction line, then the note content.
   - **Incremental sessions.** The client syncs a session at `SessionEnd`
     and also while it runs: a `Stop` checkpoint at most every 30 minutes
     when the transcript grew, and before every compaction (`PreCompact`).
     Each sync overwrites the same session file (the name carries the
     session's first timestamp, so it does not change). The worker remembers
     how many records it has already sent (`state.files[file].records`) and
     sends only the new tail. The header then carries `from-record="<n>"`,
     `turn_done` logs `fromRecord`, and the `ingest` log entry has
     `records: "<from>-<to>"`. A file rewritten shorter than what was sent is
     sent again from record 0. A session kept open for days therefore
     reaches memory in pieces, each piece sent once.
4. **Turn.** The worker opens the project's **daily ingest conversation**
   (`state.conversation = {id, date}`), sends each text with `session.send()`,
   and reads the stream until the `result` message. The session is opened
   with `dreaming: {trigger: "off"}`: Letta never starts a reflection on its
   own, because an automatic reflection cannot carry the worker's
   instruction (see below).
   - A new conversation starts when the local date changes. Before switching,
     the worker reflects the old conversation if it still has unreflected
     steps.
5. **Reflection.** The worker launches every reflection itself with the App
   Server `execute_command` `reflect` and `args: "-- <instruction>"`:
   - after every `stepCount` ingested sessions (`stepCount = N` means one
     reflection per N sessions), right inside the ingest loop. The count is
     of **distinct files** with unreflected content, not of pushes: a
     re-ingest of a session that is still unreflected in the same
     conversation updates its `unreflected` entry (`sentAt` and metadata)
     instead of adding one, so a long session synced five times counts once
     until a reflection covers it, and once more for content that arrives
     after that reflection. Because `sentAt` moves to the latest part, a
     reflection that started before that part was sent does not mark the
     session covered (it stays unreflected and is reflected again);
   - once per day, at or after `dailyReflectHour` (local time; set `TZ`), on
     leftover sessions.
   - It then polls
     `$LETTA_CONFIG_DIR/transcripts/<agent>/<conversation>/state.json` until
     `last_reflection_succeeded_at` advances, for up to
     `reflectionWaitSeconds`, checks whether MemFS `main` moved, and
     classifies the outcome (see "Reflection outcomes" below).
6. **Push.** Whenever MemFS `main` has moved since the last push, the worker
   runs `git push <memoryRepo> main:main` from
   `$LETTA_CONFIG_DIR/lc-local-backend/memfs/<agent>/memory`. Letta does not
   push reflection merges itself: they are fast-forwards, so its
   post-commit hook never fires. The worker never force-pushes.
7. **Log.** Append entries to `ingest/log.jsonl` in the transcripts repo,
   commit, and push. Entries that fail to push stay in the state file and are
   retried on the next pass.

### Failure handling

- **Provider, connection and timeout errors** (quota exhausted, App Server
  down, ...) stop the project's batch and set an exponential backoff: 1, 2,
  4 ... minutes, capped at 1 hour. The file stays queued and doesn't count an
  attempt.
- **Other turn failures** count an attempt against the file. After
  `maxAttemptsPerFile` attempts the file is dropped and logged as `skip`.
- **Malformed JSON** is dropped right away and logged as `skip`.
- **Project-level errors** (bad repo URL, missing MemFS, ...) are logged as
  `project_error` and back off from the poll interval.
- **Backoff does not survive a restart.** On its first pass for a project,
  a new worker process clears any backoff saved in the state file (logged as
  `backoff_reset` with the previous failure count, deadline and reason). An
  operator who fixed the cause and restarted does not wait out the old timer.
- **SIGTERM/SIGINT** stops after the current turn. Exit is forced after 30 s,
  or immediately on a second signal.

### Reflection instruction

Letta appends the instruction to its reflection prompt ("Additional
user-provided reflection instruction"). It is built in `src/reflection.ts`
and says:

- the primary agent id, and that its MemFS is
  `$LETTA_CONFIG_DIR/lc-local-backend/memfs/<agentId>/memory` with the
  subagent's `$MEMORY_DIR` being a reflection worktree under
  `.../memfs/<agentId>/memory-worktrees/`;
- write memory files only inside `$MEMORY_DIR`; every absolute path given to
  Edit or Write must start with `.../memfs/<agentId>/` and be copied from
  `printf "%s\n" "$MEMORY_DIR"`, never retyped, and never with a guessed or
  combined agent id (the subagent's own id is different and not allowed);
- if an edit is denied (for example by the cross-agent memory guard), fix the
  path and retry; do not finish before planned changes are committed;
- the memory language (projects.json `language`, default `en`): "Language:
  write memory in <Language>. Sessions and remember notes in other languages
  are recorded in <Language>. Keep proper nouns, titles, identifiers and code
  verbatim." (`src/language.ts`; English, or Korean with its native name in parentheses);
- end the report with exactly one line `RESULT: committed`,
  `RESULT: nothing-to-save` or `RESULT: failed: <one-line reason>`;
- the sessions still waiting to be reviewed, if any (see below).

The instruction names `$MEMORY_DIR` rather than asking for edits in
`.../memory` itself: Letta Code 0.34.41 runs reflection in a git worktree
and merges it into `memory` after the subagent commits. Edits made directly in
the main checkout would not be committed by the reflection, and a dirty main
checkout makes Letta skip later reflections (`parent_dirty`).

### Reflection outcomes

What is worth saving is decided by Letta's reflection subagent under the
Rules for reflection in `MEMORY.md`, not by the worker. The worker only
checks whether that decision was technically carried out. Letta marks a
reflection as succeeded even when the subagent gave up without committing
(for example after the memory guard denied an edit to a mistyped worktree
path), and a reflection that correctly found nothing worth keeping also
leaves MemFS `main` where it was. So after each reflection the worker
classifies it (`explainReflectionOutcome` in `src/reflection.ts`), first rule
that applies:

1. **MemFS `main` moved:** `committed`, whatever the report says.
2. **The report has a `RESULT:` line** (the last one wins; markdown
   decoration is tolerated): `nothing-to-save` is `nothing_to_save`,
   `failed: <reason>` is `failed`. `committed` while `main` did not move is
   `failed`, with a `reflection_result_mismatch` warning.
3. **Failed tool results in the subagent's conversation**
   (`readReflectionToolErrors` in `src/letta.ts`): `failed`. Matched are
   `isError: true` results that name a denial or failure (the memory guard's
   `Permission denied by cross-agent memory guard (...)` on `Edit`/`Write`),
   and Bash results that start `Exit code: <n>` (Letta keeps these at
   `isError: false`) with a git or permission failure line such as `fatal: `,
   `error: ` or `index.lock`. Printed data (JSON lines, `[user] ...` ingest
   lines, indented text) is skipped, because subagents print transcripts
   that may contain such words.
4. **The report's prose:** failure wording (`denied`, `guard`, `blocked`,
   `could not` / `failed to` + write/edit/commit/save) in the `Commit` or
   `Issues` section (anywhere, when the report has no sections), a `Commit`
   section that claims a commit, or an `Issues` section that is not
   `None`: `failed`. "No commit" / "Skipped" wording with no issues:
   `nothing_to_save`. Sections are read from `## Name`, `### Name`,
   `4. **Name** — ...` and `Name: ...` lines.
5. **No report found** (or a report with none of the above): `unknown`.

What the worker does with each:

- **`committed`:** recorded; carried sessions (below) are mapped to the
  commit.
- **`nothing_to_save`:** accepted. The covered sessions are recorded with
  `reflectionCommit: null` and `outcome: "nothing_to_save"`, there is no
  retry and no carry-forward, and the worker logs `reflection_empty`
  (info). Carried sessions that this reflection's instruction named are
  accepted too and leave the list.
- **`failed` / `unknown`:**
  1. **Retry once, immediately.** Letta reflects only transcript content
     after its cursor, and a "successful" reflection has already moved the
     cursor. So the worker first sends a short marker turn
     (`<team-memory-retry project sessions>`, a one-sentence reply) and then
     runs `reflect` again. The instruction starts with "The previous
     reflection could not save its changes (<reason or 'unknown'>). Record
     what is worth keeping under the Rules for reflection; if nothing is,
     end with RESULT: nothing-to-save." and lists each session (id, member,
     tool) with the path of the conversation's `transcript.jsonl`
     (`$LETTA_TRANSCRIPT_ROOT/<agent>/<conversation>/`), which holds the
     full ingest text. A retry that classifies as `committed` or
     `nothing_to_save` is accepted.
  2. **Carry forward.** If the retry is `failed` or `unknown` too (or does
     not finish), the worker logs `reflection_no_commit` (warn) and keeps
     the sessions in `pendingReflection` in the state file. Every later
     reflection's instruction lists them ("Sessions still to review"). A
     daily reflection with no new sessions but a non-empty list runs the
     retry step directly.
  3. **Recorded later.** When a reflection commits (or finds nothing worth
     saving in the sessions it was given), the list is cleared and
     `ingest/log.jsonl` gets an extra `reflection` entry with
     `"carriedForward": true` and that reflection's `outcome`.
  4. **Bounded.** The list keeps at most 20 sessions (the newest), and drops
     a session after 4 reflections that included it and failed. Drops are
     logged as `reflection_pending_dropped` (warn). Dropped sessions stay in
     the ingest conversation history but are not in memory.

Reflections recorded without a wait (`collected`, such as a rollover) are
classified the same way: `nothing_to_save` logs `reflection_empty`,
`failed` / `unknown` logs `reflection_no_commit` and carries the sessions
forward (no immediate retry).

### Reflection subagent report

After each reflection the worker reads the hidden reflection subagent's final
message and logs a 500-character excerpt (head and tail; the report ends with
`## Commit`, `## Issues` and the `RESULT:` line) as `report` on
`reflection_done`, `reflection_empty` and `reflection_no_commit`, with
`reflectionAgentId`. The outcome is classified from the full report, not the
excerpt. The subagent's tool results are read from the same
`messages.jsonl`. Where Letta Code 0.34.41
keeps it (local backend):

- each reflection creates a hidden agent
  `lc-local-backend/agents/<base64url(agentId)>.json` with tags
  `type:reflection` and `parent:<primary agent id>`;
- its conversation is
  `lc-local-backend/conversations/<base64url("default:<subagent id>")>/`,
  with `conversation.json` (`agent_id`, `created_at`) and `messages.jsonl`
  (one pi session entry per line; the last `assistant` message with `text`
  content is the report, and tool results are entries
  `{"type":"message","message":{"role":"toolResult","toolName","isError","content":[{"type":"text","text"}]}}`).

The worker picks the newest reflection subagent of the agent created between
the reflection's start (minus 10 s) and its success time. This is best effort:
if the layout changes, the excerpt is just missing. These hidden agents pile
up, one per reflection, and are not pruned by the worker.

### Token usage

Every ingest turn, reflection and init run records its token usage in one
normalized shape:

```json
{"input":12971,"output":460,"cacheRead":38992,"cacheWrite":64,"reasoning":40,"total":52487,"costUsd":0.08}
```

`input` is the input not served from the prompt cache, `cacheRead` /
`cacheWrite` the cached input read / written, `reasoning` is part of
`output`, and `total` = input + output + cacheRead + cacheWrite (Letta's own
`totalTokens`). Where the numbers come from:

- **Ingest and init turns**: the App Server's `usage_statistics` on the SDK
  turn result (`prompt_tokens` -> `input`, `completion_tokens` -> `output`,
  `cached_input_tokens` -> `cacheRead`, `cache_write_tokens` -> `cacheWrite`,
  `reasoning_tokens`, `total_tokens`). Letta Code fills these from the same
  per-message counters as below. `costUsd` is `null`: the turn result has no
  cost.
- **Reflections**: the reflection subagent's conversation
  (`lc-local-backend/conversations/<base64url("default:<subagent id>")>/messages.jsonl`,
  found as in "Reflection subagent report"). Letta Code 0.34.41 writes a
  `usage` object on each `assistant` message
  (`{"input","output","cacheRead","cacheWrite","reasoning","totalTokens","cost":{...,"total"}}`,
  next to `provider` and `model`); the worker sums them. This is a read-only
  dependency on Letta's file layout: if the records move or change, the
  reflection's `usage` is just missing (the run still counts on the ledger).
- **Reused conversation rule.** A subagent conversation can outlive one run,
  so only messages written inside this reflection count: the entry's
  `timestamp` (else the message's own `timestamp` or `metadata.created_at`)
  must fall within [reflection start − 10 s, success time + 5 s]. Messages
  without any timestamp are skipped, and an entry id seen twice counts once.
- `model` is the subagent's `<provider>/<model>` handle from the same
  records (comma-joined if a run used more than one).

`costUsd` is not a bill. Cost is Letta's own estimate from its price table and
is only notional when the provider reports no per-token price. Costs of
different kinds are summed only where known, and `≈$` in the CLI marks them
as estimates.

Where usage shows up:

- `turn_done` and `ingest` log entries (summed over the file's parts),
  `reflection_done` / `reflection_recorded` and `reflection` log entries
  (with `model`; a `carriedForward` copy of the same run carries no usage, so
  summing the log counts each run once), `init` entries and
  `bootstrap/status.json` (the run's running total: the newest entry per
  `initId` is the run's usage), and `state.lastReflection`.
- The daily ledger `state.usage[YYYY-MM-DD][ingest|reflection|init] =
  {turns, input, output, cacheRead, cacheWrite, reasoning, total, costUsd}`
  (local date of when each finished; `turns` counts ingest turns, including
  the retry marker turn and turns of a file whose later part failed,
  reflection runs and init runs). An init run's whole usage lands on the day
  it finishes. The ledger keeps 90 days. `memmem-server usage` and the
  `usage 7d` line of `memmem-server status` read it; the client's
  `memmem status` sums the last 7 days of `ingest/log.jsonl` instead.

## Project init

`memmem init` on a team member's machine (client) writes
`bootstrap/<member>/request.json` to the transcripts repo: the answers to the
four questions of Letta Code's `/init` (research depth, other repositories,
communication style, past-session consent), a git summary, the code repo URL,
and, with consent, redacted session copies under `bootstrap/<member>/<source>/`
plus a `manifest.json` in the shape of `letta trajectories export`. The worker
turns that into a run of Letta's own `/init` on the project agent (design:
`docs/design/project-initialization.md`). Code: `src/init.ts` (pure
parts), `src/init-runner.ts` (the job).

1. **Detect.** After syncing the transcripts repo, a pass lists
   `bootstrap/*/request.json` with their blob ids. A request whose blob is not
   in `state.initRequests[path]` is new. All new requests are handled by one
   run (`requestedBy` lists their members; the newest full request supplies
   the code summary, `deep` wins, related repos are merged). A run that waits
   for an answer looks for `bootstrap/*/answer-<n>.md` files it has not seen
   (`answersSeen`, path and blob; the files present when the run started
   count as seen).
   **Fresh state.** A state with no processed request and no run (a new
   install, or a wiped state file) next to a `bootstrap/status.json` with
   `state: done` does not run that init again: the paths the status names in
   `requests`, and any `bootstrap/*/request.json` whose `requestedAt` is not
   newer than the run's `finishedAt`, are marked processed (outcome `done`,
   the old `initId`; log `init_requests_marked_done`) before new requests are
   looked for. A request newer than that run stays new. The project init
   record is seeded from that status (`src/init-recovery.ts`).
   **Classification.** The merged requests are then classified against the
   project's init record (`state.initProject`, written to `status.json`), not
   by their flags alone (design 3.5); `init_classified` logs `kind`,
   `reason`, `requestedBy`, `depthBefore`, `depthAfter`, and the `init` entry
   of `ingest/log.jsonl` carries `classifiedAs`:

   | Project state | Requests | Kind | Sessions laid out |
   |---|---|---|---|
   | no completed init | any full request (several are merged) | `project_init` | every member's, including already reflected ones |
   | any | only `historyOnly` requests | `contribute` | the requesting members' |
   | completed init | depth equal or lower than recorded, no `reinit` | `contribute` | the requesting members' |
   | completed init | `deep` while the recorded depth is `standard` | `deepen` | every member's (`bootstrap/*/manifest.json`) |
   | completed init | `reinit: true` in a full request | `project_init` (re-run) | every member's |

   A shallower depth never lowers the recorded one
   (`init_depth_downgrade_ignored`; a `reinit` keeps `deep`). A recorded
   depth that is unknown (a record derived from `done` marks alone) counts as
   `standard`. "Completed init" means a `project_init` or `deepen` that
   finished `done`; when the state has no record, it is taken from
   `bootstrap/status.json` (`initializedAt`), then from `done` marks in
   `state.initRequests`. Except on a first
   `project_init`, sessions that a reflection already handled are left out
   (`already reflected`, counted as `alreadyReflected` in `init_estimate`
   and `status.json`): session ids of `ingest` entries in `ingest/log.jsonl`
   whose `reflectionOutcome` is `committed` / `nothing_to_save` (or that
   carry a `reflectionCommit`), and of the trajectory files listed by
   `reflection` entries with such an outcome. A `contribute` with no session
   left and nothing else to record (history-only, or no style and no
   repositories) finishes `done` without a Letta turn
   (`init_nothing_to_contribute`); a history-only request that uploaded no
   session at all fails as before.
   **Already analysed.** The client merges `bootstrap/<member>/manifest.json`
   across a member's devices (earlier entries are kept), so a second request
   lists the sessions of the first run again. When a run finishes `done`, the
   sessions it laid out are recorded in `state.initStagedSessions`
   (session id -> `initId`, `member`). A `contribute` leaves those out
   (`already analysed by init <initId>` in the layout's `errors[]`, counted as
   `alreadyStaged` in `init_estimate`, `lastRun` of `status.json` and the
   `init` log entry); `deepen` and a `reinit` still lay out every member's
   sessions. A state without this map (a fresh state next to an earlier init)
   is seeded once (`init_staged_sessions_seeded`, `src/init-recovery.ts`) when the project
   has a completed init: every session in a `bootstrap/<member>/manifest.json`
   whose member's record is `done` counts as analysed by that record's run,
   except for a member whose request is still pending (its manifest may hold
   sessions no run has seen, so they are analysed again).
2. **Background job, ingest paused.** The run is a background job: other
   projects keep their passes, and this project's passes are skipped until
   the job settles (`waiting_for_answer`, `done` or `failed`). One job per
   project. While a run waits for an answer, ingest goes on.
3. **Code.** `request.codeRepo` is cloned or fetched (hard reset to the
   default branch) into `$MEMMEM_CWD/<project>/repo` with the server git
   environment (`GIT_CONFIG_GLOBAL`, credential helper,
   `GIT_TERMINAL_PROMPT=0`). Each `answers.repos` entry (`org/repo` or a URL)
   goes to `$MEMMEM_CWD/<project>/repo-<name>`. Any clone failure fails the
   run with git's message; memory is not touched. A request without
   `codeRepo` fails unless the run is a `contribute` (then an earlier clone
   is reused if present). The clone is kept for re-init and never pushed.
4. **History.** The `bootstrap/<member>/manifest.json` files the
   classification selects, and the session files they list, are laid out in `$MEMMEM_INIT_TRAJECTORIES_DIR`
   (`/tmp/letta-trajectories`, the default `--out` of `letta trajectories
   export`) as `<source>/<file>` plus a merged `manifest.json` (`version,
   generatedAt, outDir, sources{discovered, exported}, errors[], sessions[]`).
   Sessions are deduplicated by `sessionId` (the larger copy wins), only the
   newest `settings.initMaxSessions` are kept, and the rest go to `errors[]`
   with the reason. Each session keeps `member` (an alias is mapped to its
   handle; the uploaded name is kept as `uploadedAs`); its `project` is set to the
   server clone (the client's path is kept as `clientProject`) so Letta's
   `prepare-history.mjs` fills the cohort's `repo`. The estimate (bytes / 4)
   is logged as `init_estimate` before any model call.
5. **Conversation.** A **new** conversation on the project agent (never the
   daily ingest conversation), cwd = the code clone, permission mode
   `unrestricted` (nobody is there to approve tools; the memory guard still
   applies). First a pre-answer turn (`<memmem-init ...>`, one-sentence
   reply): the run kind and its reason; the four answers, by kind (a
   `contribute` says the memory is already initialized, by whom, when and at
   what depth, to reflect these members' sessions into it without
   re-researching the code beyond verifying claims, to record each member's
   style answer in `people/<handle>.md`, and to add new related repositories;
   a `deepen` or `reinit` says the research depth and that existing records
   are marked superseded, never deleted); the members table (below); that
   the sessions are already exported to the
   trajectories dir and `letta trajectories detect/export` must not run
   again; that each session's `member` names its author; the subagent model
   (`settings.initHistoryModel` or the current model); the language line
   (the same sentence as in the reflection instruction, from the project's
   `language` in projects.json: a request whose `language` differs is
   overridden and logged as `init_language_overridden` with `requested` and
   `language`); that
   the analysis Workflow must run with `wait: true`; the clone path and the
   client's git summary (Letta's own `/init` git summary is computed in the
   App Server's directory, not the repo); the Rules for reflection in
   `MEMORY.md` and the existing layout win over the skill's examples;
   existing decision and change records are marked, not deleted; and a
   final line `INIT: done | INIT: question: <q> | INIT: failed: <reason>`.
   Then App Server `execute_command` `init` (`command_id: "init"`, no args).
   Letta builds its `/init` message and the agent runs the
   `initializing-memory` skill. The command answers only after the turn ends;
   the stream is read in the background meanwhile. Limit:
   `settings.initTimeoutMinutes` (60).
6. **Background work.** If the agent started background work (a Workflow
   without `wait: true`, an Agent subagent) and ended its turn without a
   terminal `INIT:` line, the session stays open: Letta's App Server runs the
   task notification as a new turn only while a session is attached to the
   conversation. The worker follows those turns until a terminal line, or
   until nothing runs (Workflow journals under
   `$LETTA_CONFIG_DIR/workflows/executions/` quiet, 60 s idle). If the agent
   still says it waits on background work, the worker waits for the Workflow
   executions to finish and sends up to two `<memmem-init-continue>` turns
   naming their `journal.jsonl` and result log.
7. **Outcome** (last assistant message): an `INIT:` line wins. Without one, a
   message that ends with `?` / `？` (or has an AskUserQuestion-style block)
   is a question, unless the init already committed (then it is the skill's
   closing offer of refinement: `done`, logged as `followUp`). Otherwise
   `done` (with `init_no_commit` if MemFS `main` did not move).
   - `waiting_for_answer`: the question goes to `status.json`; commits made so
     far are pushed. A new `answer-<n>.md` is sent as the next turn of the
     same conversation (`<memmem-init-answer>`), and the outcome is judged
     again. A new request while waiting supersedes the waiting run.
   - `done` / `failed`: the commits are `git log baselineHead..main` of MemFS;
     MemFS `main` is pushed as usual; `memoryHeadSeen` moves past them (no
     later reflection claims them); every handled request is marked in
     `state.initRequests`; `ingest/log.jsonl` gets an `init` entry;
     `bootstrap/status.json` is written; the trajectories dir is removed.
8. **Interruptions.** A run left `running` by an earlier process (restart,
   crash) is recorded as `failed` ("interrupted ...") on the next pass. A
   worker stop aborts the turn and records `failed` ("interrupted: worker
   stopping"). `memmem-server init run --project p` runs the newest requests
   again; `init cancel` aborts a running job or drops a pending question
   (`failed`, "cancelled by the operator", requests marked `cancelled`).

`bootstrap/status.json` (the client's `memmem status` reads it):

```json
{"state":"done","project":"demo-shop","initId":"init-20261106T091552Z","requestedBy":["minji"],
 "requests":["bootstrap/minji/request.json"],"startedAt":"...","updatedAt":"...","finishedAt":"...","durationMs":173981,
 "conversationId":"local-conv-4","commits":[{"sha":"1a2b3c4...","subject":"memory(self): ..."}],
 "sessions":14,"estimatedTokens":5540,"usage":{"input":75169,"output":5028,"cacheRead":569600,"cacheWrite":0,"reasoning":0,"total":649797,"costUsd":null},
 "answers":0,"serverVersion":"0.1.0",
 "depth":"standard","initializedAt":"...","initializedBy":["alice"],"repos":["org/web"],
 "members":{
   "alice":{"kind":"project_init","sessions":6,"finishedAt":"...","initId":"init-20261106T081552Z","state":"done"},
   "minji":{"kind":"contribute","sessions":14,"finishedAt":"...","initId":"init-20261106T091552Z","state":"done"}},
 "lastRun":{"initId":"init-20261106T091552Z","kind":"contribute","requestedBy":["minji"],"state":"done",
   "commits":[...],"usage":{...},"startedAt":"...","finishedAt":"...","sessions":14,"alreadyReflected":3}}
```

The top-level fields up to `serverVersion` describe the latest run as before
(older clients keep working). `state` is `running`, `waiting_for_answer`
(with `question`), `done` or `failed` (with `error`). `usage` is the init
conversation's own turns; Workflow subagents' tokens are in their journals,
not here. The rest comes from the project's init record
(`state.initProject`), which persists across runs and is re-written on every
publish:

- `depth`, `initializedAt`, `initializedBy`: set when a `project_init` or
  `deepen` finishes `done` (null / empty before that); `repos` accumulates
  the related repositories of `done` runs.
- `members[handle]`: `kind`, `sessions` (this member's sessions laid out),
  `finishedAt`, `initId`, `state` (`running`, `waiting_for_answer`, `done`,
  `failed`). A run writes the entries of its requesting members (and of
  members whose sessions a `project_init` / `deepen` lays out and who have no
  entry yet). If a run fails for a member whose entry was `done`, the earlier
  entry is kept with `lastFailure: {initId, kind, finishedAt, error}`.
  Entries recorded under an alias move to the handle.
- `lastRun`: `initId, kind, requestedBy, state, commits, usage, startedAt,
  finishedAt, sessions, alreadyReflected`, and `error` when failed.

**Members and aliases.** `memmem setup` on the client writes
`members/<handle>.json` to the transcripts repo (`{handle, displayName,
gitAuthors: [{name, email}], joinedAt, githubId?, aliases: []}`; the handle is the
GitHub login, `aliases` are older handles, `githubId` the numeric GitHub
account id when the client had gh). The worker reads them from its
clone (`src/members.ts`) and:

- treats two files with one `githubId` under different handles as a renamed
  login: the file with the later `joinedAt` (tie: the lexicographically first
  handle) is the member, the other handles become its aliases (even when its
  `aliases` does not list them, and their git authors and aliases are merged
  in), and they are not listed as members of their own. Each pass that sees
  this logs `members_rename_detected` once (`renames: [{handle, previous,
  githubId}]`); no file is changed;

- maps an alias to its handle for `requestedBy`, the `members` map and the
  laid-out sessions' `member` (paths such as `bootstrap/<alias>/` stay);
- puts a table into the init pre-answer turn and into every reflection
  instruction: `- <handle> (<displayName>): git author <name> (<email>) =
  member <handle>; old handle <alias> = <handle>`, with the instruction to
  attribute git authors by it and to merge `people/<alias>.md` into
  `people/<handle>.md` (the alias file stays as a pointer). Emails appear
  only in that agent text, never in logs, `status.json` or CLI output.

`memmem-server members [--project p]` lists the registered members (display
name, `githubId` when present, aliases, git author names, joined date) with their init contribution
from the project record; members that contributed but have no
`members/*.json` show as `(not registered)`. `memmem-server init status`
adds "project initialized <at> by <who> depth <d>" and one row per member
(`kind state sessions finishedAt initId`). `init run` only triggers the
worker (it re-runs the newest requests, classified as above); a
re-initialization is requested from the client (`reinit: true` in
`request.json`).

## Configuration

`$MEMMEM_CONFIG` (see `config/projects.example.json`) is re-read every
pass, so projects added by `memmem-server project add` are picked up without a
restart.

| `settings` key | Default | Meaning |
|---|---|---|
| `stepCount` | 3 | Distinct ingested sessions (files) per reflection; re-ingests of an unreflected session do not add to the count (the worker triggers it) |
| `dailyReflectHour` | 23 | Local hour for the daily forced reflection; `null` disables it |
| `ingestMaxChars` | 40000 | Max chars per ingest turn; longer sessions are split |
| `messageMaxChars` | 1500 | Cap per user/assistant message |
| `reflectionWaitSeconds` | 240 | How long a pass waits for a triggered reflection |
| `maxAttemptsPerFile` | 5 | Non-retryable turn failures before a file is dropped |
| `initTimeoutMinutes` | 60 | Limit for the init turn (and each answer or continue turn), including followed background turns |
| `initMaxSessions` | 200 | Past sessions laid out for an init; the newest are kept |
| `initHistoryModel` | `null` | Model handle the pre-answer turn names for history-analysis subagents; `null` = the agent's current model |

Each project entry needs `project`, `agentId`, `memoryRepo` and
`transcriptsRepo`. Set `"enabled": false` to pause a project. `language`
(`en` | `ko`, default `en` for entries without one) is the language the
project's memory is written in: `memmem-server project add --language`
sets it and `project set-language <name> <lang>` changes it (existing memory
is not translated). It is the single source: `project add` also writes it to
`project.json` at the root of the transcripts repo
(`{project, language, layoutVersion, createdAt}`), and `set-language`
commits and pushes the change there, so clients' `memmem setup` reads it and
`memmem doctor` flags a different `.memmem/config.json` `language`. The MemFS
template is `templates/memory-repo/<language>` (folder names and
frontmatter keys are English in both). CLI and log output are English;
conversation with the coding agent follows the user's language.

| Env var | Default | |
|---|---|---|
| `MEMMEM_CONFIG` | `$MEMMEM_SERVER_HOME/projects.json` | Config file |
| `MEMMEM_SERVER_HOME` | `$XDG_DATA_HOME/memmem-server`, else `~/.local/share/memmem-server` (`/var/lib/mem-mem` in the image) | Server data root and base for the defaults below |
| `MEMMEM_APP_SERVER_URL` | `ws://127.0.0.1:$LETTA_APP_SERVER_PORT` (4500) | App Server WebSocket |
| `MEMMEM_STATE_DIR` | `$MEMMEM_SERVER_HOME/state` | Per-project state files |
| `MEMMEM_REPOS_DIR` | `$MEMMEM_SERVER_HOME/repos` | Transcripts repo clones |
| `MEMMEM_CWD` | `$MEMMEM_SERVER_HOME/agentcwd` | Base dir; sessions run in `<base>/<project>` |
| `MEMMEM_POLL_SECONDS` | 60 | Pass interval |
| `MEMMEM_ONCE` | unset | `1`: run one pass and exit (0 = all projects ok) |
| `MEMMEM_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `LETTA_CONFIG_DIR` | `$MEMMEM_SERVER_HOME/letta` (`/root/.letta` in the image) | Letta state (MemFS, transcripts) |
| `MEMMEM_REQUESTS_DIR` | `$MEMMEM_SERVER_HOME/requests` | One-shot requests from `memmem-server reflect now/retry` |
| `MEMMEM_LOG_FILE` | unset (`start` uses `$MEMMEM_SERVER_HOME/logs/worker.log`) | Also append the JSON log here |
| `LETTA_TRANSCRIPT_ROOT` | `$LETTA_CONFIG_DIR/transcripts` | Letta's transcript root, if overridden |
| `MEMMEM_INIT_TRAJECTORIES_DIR` | `/tmp/letta-trajectories` | Where init lays out past sessions for Letta's `/init` (must be readable by the App Server) |
| `TZ` | container default (UTC) | Time zone for `dailyReflectHour` and the daily conversation |

## State and logs

`$MEMMEM_STATE_DIR/<project>.json` (written atomically) holds:

- `lastSeenCommit`: the transcripts repo cursor.
- `queue`: files still to ingest, with attempt counts.
- `files`: per-file blob and number of records sent.
- `conversation`: the daily conversation id and date.
- `reflectionSeen`: the last success timestamp seen per conversation.
- `lastPushedMemoryHead` and `memoryHeadSeen`.
- `unreflected`: files ingested but not yet covered by a reflection, one
  entry per file and conversation (with `sentAt` of the latest ingested part,
  and session, member and tool when known).
- `pendingReflection`: sessions whose reflection and retry failed (or had an
  unknown outcome), named in the next reflection's instruction (`file`, `conversationId`,
  `session`, `member`, `tool`, `misses`). At most 20.
- `pendingLog`: log entries not yet pushed.
- `lastReflection`: `at`, `outcome`, `commit`, `trigger`, `conversationId`,
  and `usage` / `model` when the subagent's records had them.
- `usage`: the daily token ledger (see "Token usage"), 90 days.
- `backoff` (cleared when a new worker process starts).
- `init`: the current or last init run (`id`, `state`, `requests` with path
  and blob, `requestedBy`, `conversationId`, `startedAt`, `updatedAt`,
  `finishedAt`, `baselineHead`, `answersSeen`, `answers`, `question`,
  `error`, `commits`, `usage`, `sessions`, `estimatedTokens`,
  `durationMs`, and since classification `kind`, `depthBefore`,
  `depthAfter`, `reinit`, `alreadyReflected`, `repos`, `historyScope`,
  `prevMembers`).
- `initProject`: the project's init record (`depth`, `initializedAt`,
  `initializedBy`, `repos`, `members`), published in `status.json`.
- `initRequests`: handled request files, path -> `{blob, processedAt,
  outcome: done|failed|cancelled, initId}`. A request file with a new blob
  is a new request.

Deleting this file makes the worker re-ingest everything in the transcripts
repo.

**stdout.** One JSON object per line:
`{"ts","level","event",...}`. Main events:

- `worker_start`, `config_loaded`
- `files_queued`, `conversation_opened`, `turn_done` (`part`, `fromRecord`
  for trajectories: `0` for a first ingest, `> 0` for an incremental one,
  duration, usage, reply)
- `reflection_started` (the `reflect` command's outcome and `trigger`:
  `step-count`, `daily`, or `<trigger>-retry`; `collected` marks a
  reflection recorded without a wait, such as a rollover), `reflection_wait`,
  `reflection_done` (`commit`, `outcome`, `outcomeSource`: `head`,
  `result_line`, `tool_errors`, `report_prose` or `no_report`, `reason`,
  `toolErrors`: `{count, first}` when present, `reflectionAgentId`, `usage`,
  `model`, `report`) / `reflection_wait_timeout`, `reflection_recorded`
  (`outcome`, `toolErrors`, `usage`, `model`)
- `reflection_empty` (info: nothing worth saving, accepted; `sessions`,
  `outcomeSource`, `report`), `reflection_result_mismatch` (warn: the report
  claims a commit that is not on `main`)
- `reflection_retry` (the first try `failed` or was `unknown`; `outcome`,
  `reason`), `reflection_retry_failed`, `reflection_no_commit` (warn: the
  retry failed too; `outcome` `failed` / `unknown` / `nothing_to_reflect` /
  `not_finished`, `reason`, `toolErrors`, `sessions`, `report`),
  `reflection_pending_recorded` (carried sessions committed or judged empty;
  `outcome`), `reflection_pending_dropped` (warn)
- `backoff_reset`
- `memory_pushed` / `memory_push_failed`
- `ingest_log_pushed`, `project_pass`
- `project_error`, `turn_failed`
- init: `init_requests_found`, `init_started`, `init_classified` (`kind`,
  `reason`, `requestedBy`, `depthBefore`, `depthAfter`),
  `init_depth_downgrade_ignored`, `init_status_pushed` /
  `init_status_push_failed`, `init_code_ready`, `init_estimate` (with
  `byMember`, `alreadyReflected`), `init_nothing_to_contribute`,
  `init_conversation_opened`, `init_preanswer_done`, `init_command_started`,
  `init_command_done` (`durationMs`, `followedMs`, `backgroundLaunches`,
  `toolCalls` by name, `notableCommands`: shell commands that mention
  trajectories / prepare-history / workflows, `usage`, `reply` excerpt),
  `turn_follow_started`, `init_continue_turn_done`, `init_outcome`,
  `init_waiting_for_answer`, `init_answer_received`, `init_answer_turn_done`,
  `init_done`, `init_failed` / `init_failed_recorded`, `init_no_commit`,
  `init_job_crashed`

URLs with embedded credentials are redacted in all output.

**`ingest/log.jsonl`** in the transcripts repo:

```json
{"ts":"...","event":"ingest","project":"demo-shop","file":"trajectories/2026-11/minji/claude-code/...json","blob":"<git blob>","conversationId":"local-conv-15","parts":1,"member":"minji","tool":"claude-code","session":"...","records":"0-9","durationMs":3400,"usage":{"input":6528,"output":57,"cacheRead":13824,"cacheWrite":0,"reasoning":0,"total":20409,"costUsd":null},"reflectionCommit":"<sha>","reflectionOutcome":"committed"}
{"ts":"...","event":"reflection","project":"demo-shop","conversationId":"local-conv-15","reflectionCommit":"<sha or null>","outcome":"committed","startedAt":"...","succeededAt":"...","files":["trajectories/..."],"trigger":"step-count","usage":{"input":12971,"output":460,"cacheRead":38992,"cacheWrite":64,"reasoning":40,"total":52487,"costUsd":0.08},"model":"openai-codex/gpt-5.6-sol"}
{"ts":"...","event":"reflection","project":"demo-shop","conversationId":"local-conv-15","reflectionCommit":null,"outcome":"nothing_to_save","startedAt":"...","succeededAt":"...","files":["trajectories/..."],"trigger":"step-count"}
{"ts":"...","event":"reflection","project":"demo-shop","conversationId":"local-conv-15","reflectionCommit":null,"outcome":"failed","startedAt":"...","succeededAt":"...","files":["trajectories/..."],"trigger":"step-count-retry","retry":true}
{"ts":"...","event":"reflection","project":"demo-shop","conversationId":"local-conv-16","reflectionCommit":"<sha>","outcome":"committed","startedAt":"...","succeededAt":"...","files":["trajectories/..."],"trigger":"step-count","carriedForward":true}
{"ts":"...","event":"skip","project":"demo-shop","file":"...","error":"..."}
{"ts":"...","event":"init","project":"demo-shop","initId":"init-20261106T081552Z","state":"done","requestedBy":["alice"],"files":["bootstrap/alice/request.json"],"conversationId":"local-conv-4","startedAt":"...","commits":["<sha>","<sha>"],"sessions":2,"usage":{...},"finishedAt":"...","durationMs":173981}
```

An `init` entry is written when a run waits for an answer (`state:
"waiting_for_answer"`, `question`) and when it ends (`done`, or `failed` with
`error`; `followUp` when the agent closed with a question after committing).

- `reflectionCommit` on an `ingest` entry is filled in when the reflection
  that covered the turn finished in the same pass. Otherwise a later
  `reflection` entry lists the file.
- `trigger`, `retry`, `carriedForward`, `outcome`, `usage`, `model` (on
  `reflection`) and `reflectionOutcome` (on `ingest`) are optional fields;
  older readers can ignore them, and older entries do not have them. Older
  `ingest` / `init` entries carry `usage` as the SDK's raw counters
  (`promptTokens`, `completionTokens`, `cachedInputTokens`, `totalTokens`);
  readers map them onto the shape in "Token usage".
- `outcome` is `committed`, `nothing_to_save`, `failed` or `unknown` (see
  "Reflection outcomes"). A `null` commit with `nothing_to_save` is final:
  the reflection judged the sessions not worth keeping. A `null` commit with
  `failed` / `unknown` is followed by a `retry: true` entry; if that fails
  too, the files are carried forward, and a later `carriedForward: true`
  entry maps them to the reflection that finally handled them (its
  `reflectionCommit` and `outcome`).
- An `ingest` entry's `reflectionCommit` and `reflectionOutcome` are set in
  the same pass only. A retry with a better outcome (a commit, or nothing to
  save) replaces the first try's.
- A `carriedForward` entry means "a later reflection reviewed this session",
  not "this commit contains it".
- The `report` on `reflection_done` / `reflection_no_commit` and the
  `reason` usually say why nothing was saved (for example `Permission
  denied by cross-agent memory guard`).

## Operator checklist

1. **Model provider.** `memmem-server setup` (or `memmem-server provider
   connect chatgpt`) logs in once. The agent model and the reflection model
   (`$LETTA_CONFIG_DIR/agents/reflection.md`) are set by `memmem-server
   project add` / `memmem-server model ...`. Letta Code's local backend reads
   agent records only at startup, so these commands reload the App Server
   that `memmem-server start` runs (otherwise the worker gets `Agent ... not
   found`).
2. **Git credentials.** The worker uses the server gitconfig
   (`GIT_CONFIG_GLOBAL=$MEMMEM_SERVER_HOME/gitconfig`) for three things:
   cloning, fetching and pushing the transcripts repos, and pushing the
   memory repos.
   - The simplest setup is `memmem-server setup`, which runs `gh auth login`
     and `gh auth setup-git` into that gitconfig.
   - A credential helper, or SSH URLs with a deploy key, also work.
   - Avoid tokens embedded in URLs. If you use them anyway, they are redacted
     from logs, but they remain in `projects.json` and `.git/config` of the
     clones.
   - Interactive prompts are disabled (`GIT_TERMINAL_PROMPT=0`), so missing
     credentials fail fast with a logged error.
3. **Time zone.** Set `TZ` to your team's IANA time zone (for example
   `TZ=UTC`, the container default) so `dailyReflectHour` and the daily
   conversation follow your working day.
4. **Diverged memory repo.** If someone merges a PR into the memory repo, the
   worker's push is rejected (`memory_push_failed`, `nonFastForward: true`).
   Reconcile MemFS by hand: fetch the memory repo into MemFS and merge, while
   no reflection is running. The worker will not force-push.
5. **One worker per Letta state.** Do not run two workers against the same
   state dir or the same agents.

## Development

```bash
npm ci                                    # at the repo root (npm workspaces)
npm test                                  # build + unit/git/worker-flow tests (no network, no Letta)
MEMMEM_IT=1 npm run test:integration      # real App Server + model quota; see the test header
```

The integration test starts `letta server --backend local` on port 4500
itself, unless one is already listening. It runs one worker pass against a
temporary bare transcripts repo, and checks four things:

- the turn completed;
- a reflection commit appeared;
- that commit was pushed (GitHub HEAD equals MemFS HEAD);
- `ingest/log.jsonl` was committed.

It uses one ingest turn and one reflection of real quota.
