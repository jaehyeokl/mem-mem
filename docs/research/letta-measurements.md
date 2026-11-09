# Letta self-hosting measurements

Written November 2026. These are the Letta Code behaviours mem-mem relies on,
each checked against Letta Code **0.34.41** on the local backend (bundled
Agent SDK 0.8.38 and trajectory 0.2.0; the worker uses
`@letta-ai/letta-agent-sdk` 0.8.70). Check here before assuming anything about
Letta, and re-check when the pinned Letta version changes.

Verdicts: **Verified** / **Failed** / **Partly verified** / **Not run**

## Environment

- Node 24.22.2 (Letta Code needs >= 24.22).
- Letta Code **0.34.41**
  (`npm i -g --allow-scripts=... @letta-ai/letta-code@0.34.41`). The node-pty
  native Linux build (`build/Release/pty.node`) is produced.
- Bundle layout: the real code is `letta.js` at the package root (one 24 MB
  bundle). `dist/*.js` are helper modules (channels, MCP and so on). Search
  `letta.js` when looking for code.
- Bundled Agent SDK 0.8.38 and trajectory 0.2.0 (latest on npm at the time:
  SDK 0.8.70, trajectory 0.4.3).

## Item 1. Reflection through the App Server: **Verified**

From the 0.34.41 `letta.js` source:

- `/reflect` syntax:
  `/reflect [--recent N | --conversation <id> ... | --auto] [--instruction <text> | -i | -- <text>]`.
  **There is no transcript file argument.** The official docs
  (`/reflect [transcript_file]`) describe an older version.
- `handleReflectCommand` in the App Server (remote listener): passing
  `--recent/--conversation/--auto` gives the error
  `"The remote listener supports only the current conversation and --instruction. Use the TUI for --recent, --conversation, or --auto"`.
  So **reflect through the App Server covers only "the current
  conversation"**.
- The App Server protocol has an `execute_command` message:
  `{type:"execute_command", command_id:"reflect", args?:string, runtime:{agent_id, conversation_id}, request_id}`
  -> `execute_command_response`. Reflection can be triggered through the SDK
  or a direct WebSocket.
- Headless `letta -p "/reflect"` is not handled as a slash command (it is sent
  as a normal message).
- Reflection reads **client-side transcripts**:
  `~/.letta/transcripts/<agentId>/<conversationId>/transcript.jsonl` +
  `state.json` (`total_completed_steps`, `reflected_through_message_id` and so
  on). The root can be changed with the environment variable
  `LETTA_TRANSCRIPT_ROOT`.
- Transcript line format (`lineToTranscriptEntry`):
  `{kind: "user"|"assistant"|"reasoning"|"error"|"tool_call", text|name/argsText/resultText/resultOk, captured_at, source_line_id, source_message_id}`.
  The reflection range only counts lines with `kind` in `{user, assistant}`
  that have a `source_message_id` (`isEligibleCanonicalEntry`). Step count =
  number of assistant lines.
- The reflection subagent (`reflection-v2.md`): `model: inherit`, tools
  Bash/Edit, skills `maintaining-core-memory`, `maintaining-deferred-memory`,
  `creating-skills`. It works in a git worktree and commits with the message
  format
  `<type>(reflection): <summary> 🔮 / Reviewed transcripts: ... / Generated-By: Reflection / Agent-ID: ...`.
- Trigger settings: in `~/.letta/settings.json`, `reflectionTrigger`
  (`step-count`), `reflectionStepCount` (default 25), `reflectionMerge`
  (auto|explicit), `reflectionMergeInstructions`. Flags
  `--reflection-trigger`, `--reflection-step-count`.

Effect on the design:

- "Hand an external transcript straight to reflect" is not possible. There are
  two possible paths:
  - **(a) Turn injection**: send the external (normalized) transcript as a user
    message in one conversation of the project agent (an App Server turn or
    `letta -p`). Letta then creates that conversation's `transcript.jsonl`
    automatically, and `execute_command reflect` (current conversation) or the
    automatic step-count trigger handles it. Costs **one LLM turn + one
    reflection**. This is what the letta-ai/claude-subconscious plugin does.
  - **(b) Synthesized transcript**: write
    `~/.letta/transcripts/<agentId>/<convId>/transcript.jsonl` directly in the
    line format above and run TUI `/reflect --conversation <convId>`. Costs
    only one reflection. But it is TUI only (not possible through the App
    Server) and fragile, since it depends on an internal format. Whether a
    local backend conversation record is needed was not checked.
- mem-mem uses (a).

## Item 2. Claude Code transcript -> reflection: **Verified**

- `letta trajectories export --transcript claude-code:<path> --out <dir>`
  normalizes it (the subcommand exists in 0.34.41, with
  `@letta-ai/trajectory` 0.2.0 built in). Supported sources: claude-code,
  codex, hermes, letta-code, openclaw, openhands, (deepagents).

## Item 3. Reflection model override: **Verified**

- The reflection subagent defaults to `model: inherit` (the parent agent's
  model). It is overridden with `~/.letta/agents/reflection.md` or
  `<cwd>/.letta/agents/reflection.md` carrying frontmatter
  `name: reflection`, `model: <handle>` (a custom subagent overrides the
  built-in one of the same name). There is no settings key, flag or
  environment variable for it.
- The reflection subagent's records show the model set in `reflection.md`.
  (Because the parent had the same model, telling the override apart from
  inheritance fully would need a re-test with a different parent model.)
- Provider connection: `letta connect <provider>` (a device-code flow with
  `--method device-code` where the provider supports it). Tokens are stored
  in `~/.letta/lc-local-backend/providers/auth.json` (0600, local mode).
- A headless one-turn greeting costs about 19,917 prompt / 13 completion
  tokens. The system prompt is about 20k tokens.

## Item 4. MemFS -> GitHub push: **Partly verified** (hook, auth and GitHub push verified; **automatic push of reflection results failed**)

Setup: a test agent with MemFS at
`~/.letta/lc-local-backend/memfs/<agentId>/memory`, a private test repo on
GitHub, `letta.memoryRepository.url` pointing at it, and HTTPS auth through the
global `credential.https://github.com.helper = !/usr/bin/gh auth git-credential`
(no token in the URL or the config).

- The post-commit hook (`.git/hooks/post-commit`, "regenerated on startup")
  exits if the url is empty, if HEAD is not a branch, or **if the branch is not
  `main`**. Otherwise it runs `git push --quiet "$url" "$branch":"$branch"` in
  the background and writes `--- <time> <sha> on main ---` / `exit=<code>` to
  `$(git rev-parse --git-dir)/memory-repository-push.log`.

### 4-1. Manual push (the same command as the hook): **Verified**

- `git -C <memfs> config --local letta.memoryRepository.url https://github.com/<org>/<repo>.git`
- `cd <memfs> && git push --quiet "$url" main:main` -> `exit=0`; every commit
  arrived on GitHub.

### 4-2. Automatic push after reflection: **Failed** (a commit is made but not pushed)

- Sequence after an ingest turn with `stepCount: 1`: about 6 seconds in, a
  worktree `memory-worktrees/reflection-<timestamp>-<id>` and a branch
  `letta/reflection/<timestamp>-<id>` are created; about 35 seconds in, the
  worktree branch gets a commit; a few seconds later `main` moves to that
  commit and the worktree and branch are removed. The GitHub HEAD does not
  move, and **the push log file is not even created** (the hook never reaches
  the push step).
- The commit message looks like
  `feat(reflection): record demo-shop product caching decision 🔮`, followed by
  an "Updates:" list and `Generated-By: Reflection`.
- Cause (reflog + source): `git reflog` shows
  `merge letta/reflection/...: Fast-forward (no commit created; -m option ignored)`.
  The reflection commit is made on the worktree's `letta/reflection/*` branch,
  where the hook exits because `branch != main`. Bringing it into `main` is
  `git merge <branch> -m <msg>` (`finalizeReflectionMemoryWorktreeUnlocked` in
  letta.js), a **fast-forward, so no commit is made on `main` and the
  post-commit hook does not run**. No post-merge hook is installed (the string
  `post-merge` does not occur in the bundle).
- Summary: the hook does not push from the reflection worktree, and does not
  push after the merge into `main` either. So **a memory updated only by
  reflection is not uploaded to GitHub automatically.**

### 4-3. Automatic push through the hook on a direct commit to main: **Verified**

- `git -C <memfs> commit --allow-empty -m "test: post-commit hook push to GitHub (empty commit)"`
  -> GitHub HEAD updated within 2 seconds, the push log shows
  `--- <time> <sha> on main ---` / `exit=0`, and the reflection commit that was
  waiting went up with it.
- So HTTPS auth through the gh credential helper works in the hook's
  environment. The only problem is that the hook does not run on the reflection
  merge path.
- Note: per the source, `/memory-repository push` (`pushToMemoryRepository`)
  forces a manual push. The mem-mem worker calls `git push <url> main:main`
  itself after a reflection.

## Item 5. Codex CLI hooks: **Verified**

- codex-cli 0.164.0, with the `hooks` feature flag on. The 14 events include
  `SessionStart`, `Stop` and `SessionEnd`. Configured in `~/.codex/hooks.json`
  or `config.toml` `[hooks]`, and per project in `<repo>/.codex/`.
- SessionStart: stdout or `hookSpecificOutput.additionalContext` is added as
  developer context. Every hook input includes `transcript_path` (its format is
  "not a stable interface").
- Session files: `~/.codex/sessions/YYYY/MM/DD/rollout-<TS>-<UUID>.jsonl`
  (some `.zst` compressed). The trajectory package supports Codex rollout
  JSONL.
- `notify` covers only turn completion and has no transcript path. MCP is
  `[mcp_servers.<id>]`.
- Almost identical to the Claude Code hook names and fields (`SessionStart`,
  `Stop`, `SessionEnd`, `transcript_path`, `additionalContext`), so the adapter
  can be one common script plus two thin configurations.

## Item 6. Transcript size: **Verified**

- Claude Code JSONL on one developer machine: 179 files (109 of them
  subagents), 362.5 MB, median 0.9 MB, p90 4.4 MB, maximum 38.7 MB. The last 7
  days: 133 MB in 42 files.
- Estimate for three people over one week: about 250 to 420 MB of raw
  transcripts. About two thirds of the lines are non-conversation records such
  as `api-request` and `attachment`.
- Effect on the design: **putting raw JSONL into a Git repo (B) as is does not
  work.**

### Normalized size: **Verified**

- Eight Claude Code JSONL files from the last 7 days (200 KB or more each)
  normalized with `letta trajectories export --transcript claude-code:<path>`.
- 20.20 MB raw -> 2.71 MB normalized, **ratio 0.134** (0.02 to 0.16 per file).
  9 to 1186 records each.
- Estimate: about 400 MB of raw transcripts per week for three people ->
  **about 50 to 55 MB per week** normalized. Keeping it in Git is not
  impossible, but it adds up to over 2.5 GB a year, so compression (zstd), a
  retention period, or a similar compromise is needed.
- manifest.json entry fields:
  `id, sessionId, source, sourcePath, file, bytes, records, userMessages, assistantMessages, toolCalls, reasoningRecords, startedAt, endedAt, model, project, firstUserPrompt, diagnostics`.
  The ingest worker can use them directly for routing and statistics.
- Caution: the `--out` directory must be empty or hold a manifest made by this
  tool (otherwise it is refused). To process only specific files, block the
  native store scan with `--root <source>:<empty directory>`.

## Item 7. Headless `letta -p`: **not usable as reflection input**

- `letta -p "<transcript>" --agent <id> --new --reflection-trigger step-count --reflection-step-count 1`:
  the turn succeeds (about 3.4 seconds), but `~/.letta/transcripts/` is not
  created and no reflection runs. In the code, transcript recording and
  post-turn reflection exist only on the headless bidirectional (stream-json)
  path and the App Server path. One-shot `-p` is excluded.

## Item 8. App Server + Agent SDK path: **Verified**

- Server: `letta server --backend local --listen ws://127.0.0.1:4500 --openai-api`.
- Client: `@letta-ai/letta-agent-sdk` 0.8.70 (peer: letta-code >= 0.34.41
  < 0.35).
  `new LettaAgentClient({backend:"remote", url:"ws://127.0.0.1:4500", WebSocket})`,
  `client.createSession(agentId, {cwd, dreaming:{trigger:"step-count", stepCount:1}})`,
  `session.send(text)`, `for await (m of session.stream())`.
- Right after the turn completes,
  `~/.letta/transcripts/<agentId>/<convId>/transcript.jsonl` (kind
  user/assistant), `state.json` and `payload-auto-*.json` (the reflection
  input) are created, and the step-count trigger **runs reflection
  automatically**. An `execute_command reflect` sent right after returns "A
  reflection agent is already running for this conversation." (so the command
  path works too).
- `execute_command` format:
  `session.sendCommand({type:"execute_command", command_id:"reflect", request_id, runtime:{agent_id, conversation_id}}, {responseType:"execute_command_response"})`.

### Synthetic transcript result

- A turn of about 3.6 seconds + reflection of **about 29 seconds** (per
  `state.json`).
- Commit `feat(reflection): record demo-shop architecture decisions 🔮`, author
  "Reflection Subagent", trailers
  `Generated-By: Reflection / Agent-ID: <subagent>`.
- Files created: `MEMORY.md` (index link added), `projects/MEMORY.md`,
  `projects/demo-shop.md` (frontmatter name/description; sections Order
  service / Payments / Inventory). Decisions, reasons, file paths and open
  items were all recorded. Good quality.

### Real Claude Code session result

- One real session (29 records, 17 KB normalized) converted to text (5.5 KB)
  and injected as a turn. A turn of about 3.4 seconds + reflection of **about
  48 seconds**.
- One commit creating an 8-line file under `projects/` and updating two
  indexes.
- Note: with no project name in the input, reflection filed the session under
  `projects/` by topic. The project name mapping has to be steered by our
  ingest header.

### Reflection steps

- One reflection subagent conversation = 13 messages (several steps), 6 to 10
  steps by assistant message count.

## Item 9. Token usage records: **Verified**

- On the local backend,
  `lc-local-backend/conversations/<base64url id>/messages.jsonl` records for
  every assistant message a `usage` object
  (`input`/`output`/`cacheRead`/`cacheWrite`/`reasoning`/`totalTokens`,
  `cost.total`) plus `provider`/`model`. The worker reads these records from
  the reflection subagent's conversation and sums them into the reflection
  usage (a read-only dependency: if the layout changes, only the usage goes
  missing; see WORKER.md "Token usage"). Cost is Letta's own estimate from its
  price table and is only notional when the provider reports no per-token
  price.

## Findings that shape the design

1. There is no official path to hand an external transcript to reflection ->
   "App Server turn injection + automatic step-count reflection" works. Ingest
   costs one extra LLM turn. Headless one-shot `-p` does not trigger
   reflection, so the ingest worker has to use the App Server (SDK). (The
   worker turns the automatic trigger off and launches each reflection itself
   with `execute_command reflect`, so that it can pass its own instruction;
   see WORKER.md.)
2. Reflect through the App Server covers only the current conversation.
   `--recent/--conversation` are TUI only.
3. About 400 MB of raw transcripts per week, normalized to about 13% (about
   55 MB per week) -> only normalized transcripts go into repo B; raw
   transcripts are kept elsewhere.
4. The reflection model is set through the `reflection.md` file.
5. The official docs lag behind the code (`/reflect [transcript_file]`). Design
   against the code.
6. **Reflection commits are not pushed to GitHub automatically.** Reflection
   commits on a worktree branch (`letta/reflection/*`) and then fast-forward
   merges into `main`; Letta's post-commit hook pushes only commits on `main`,
   and a fast-forward merge does not fire post-commit. Manual pushes and pushes
   on direct `main` commits work (HTTPS, `gh auth git-credential`). -> **The
   ingest worker runs `git push <url> main:main` itself after a reflection** (a
   post-merge hook would be the alternative, but Letta regenerates its hooks,
   so it would need checking).
7. One reflection is 6 to 10 subagent steps (by assistant message count).
   Token usage is recorded per assistant message in the local message store
   (item 9).
8. Headless one-shot `letta -p` leaves no transcript and no reflection. The
   ingest worker uses the App Server + Agent SDK.
9. Not every model a provider lists is accepted with every model-provider
   login configured for Letta, so model handles must be changeable in
   configuration.

## Still to measure

- The exact provider-side quota consumption of one reflection (Letta's usage
  records give tokens, not the provider's quota accounting).
