# End-to-end test in Docker

This is the runbook for a full end-to-end run of mem-mem on one machine: the
server image runs in a local container, and Claude Code or Codex CLI on the
same host is the client. It doubles as a starting point for a real
deployment. Steps marked **local test only** must change for a real
deployment.

Placeholders used below:

| Placeholder | Meaning |
|---|---|
| `<org>` | The GitHub account or organization that owns the project repos |
| `<project>` | The project name, for example `demo-shop` |
| `<org>/mem-<project>` | The memory repo |
| `<org>/mem-<project>-transcripts` | The transcripts repo |
| `<login>` | Your GitHub login (the member handle) |
| `memmem-server` | The container name used in this runbook |

## 0. Before you start

- Host: Docker, and `gh` logged in as a GitHub account that can create repos
  under `<org>`.
- Optional: on the host, the worker's integration test passes against a host
  App Server (`MEMMEM_IT=1 npm run test:integration` in `packages/server`).
  That test uses the host `~/.letta`. The container below never touches it.

## 1. Build the image

From the repo root:

```bash
docker build -t mem-mem:e2e -f packages/server/Dockerfile .
```

The image is a thin wrapper around the `memmem-server` package
([packages/server/README.md](../packages/server/README.md)). It contains:

- Letta Code (the version pinned in the Dockerfile);
- `memmem-server`, packed from the repo with `npm run pack:release` and
  installed with `npm i -g`;
- `gh`, `git`, `zstd`, `jq`, `tini`, and `python` (`python3` with
  `python-is-python3`).

The entry point is `tini -- memmem-server start`, which starts the App
Server, waits for `/readyz`, and runs the worker in the same process. The
image sets `MEMMEM_SERVER_HOME=/var/lib/mem-mem` and
`LETTA_CONFIG_DIR=/root/.letta`. To pick up a new build later, see step 6.

## 2. Volumes and container

```bash
docker volume create memmem-server-letta   # /root/.letta: agents, MemFS, provider auth
docker volume create memmem-server-state   # /var/lib/mem-mem: projects.json, worker state, clones, logs, gitconfig
docker volume create memmem-server-gh      # /root/.config/gh: the container's own gh login

docker run -d --name memmem-server \
  -e MEMMEM_POLL_SECONDS=20 \
  -v memmem-server-letta:/root/.letta \
  -v memmem-server-state:/var/lib/mem-mem \
  -v memmem-server-gh:/root/.config/gh \
  mem-mem:e2e
```

- Never mount the host `~/.letta`. The container must have its own Letta
  state, agents and provider login.
- `MEMMEM_POLL_SECONDS=20` is a short poll for testing. The default is 60.
- Nothing is published. The App Server listens on `127.0.0.1:4500` inside the
  container only.
- Do not mount the host's `~/.config/gh` instead of using a gh volume. When
  the host's `gh` keeps its token in the OS keyring, the mounted `hosts.yml`
  has no token, and `gh auth status` inside the container says the token "is
  no longer valid". The container gets its own gh login in step 3.

`docker logs memmem-server` on a fresh volume:

```
{"event":"server_start","pid":7,"version":"...","port":4500,"home":"/var/lib/mem-mem","lettaConfigDir":"/root/.letta",...}
{"level":"warn","event":"no_provider","hint":"turns and reflections fail until a model provider is connected: memmem-server provider connect chatgpt"}
{"level":"warn","event":"git_setup_incomplete","gitConfig":"/var/lib/mem-mem/gitconfig",...,"hint":"... run: memmem-server setup"}
{"event":"no_projects","hint":"memmem-server project add <name>"}
{"event":"app_server_starting","port":4500,...}
Listening on ws://127.0.0.1:4500
{"event":"app_server_ready","port":4500,...}
{"event":"config_loaded","configPath":"/var/lib/mem-mem/projects.json","projects":[],...}
```

`start` writes an empty `projects.json` when there is none, so the worker
idles quietly until a project is added.

## 3. Setup inside the container

```bash
docker exec -it memmem-server memmem-server setup
docker exec memmem-server memmem-server doctor
```

`setup` checks the tools, then goes through these steps:

- It writes the git identity into the server gitconfig
  (`/var/lib/mem-mem/gitconfig`, used as `GIT_CONFIG_GLOBAL`). This file is
  on the state volume, so it survives when the container is recreated.
- It runs `gh auth login -h github.com -p https -w` and shows you the
  one-time code and URL. Enter the code at https://github.com/login/device
  in a browser on the host.
- It runs `gh auth setup-git` into the server gitconfig.
- It connects a model provider for Letta. For a device-code provider it shows
  that code too; for an API-key provider Letta asks for the key.
- It records the default model and writes the reflection model
  (`/root/.letta/agents/reflection.md`).

Each step that is already done is skipped, so it is safe to run `setup`
again. Without a TTY, use `docker exec memmem-server memmem-server setup --yes`.
The device-code flows still work: the codes are printed and setup waits for
them.

Two notes:

- **Login answers.** `gh auth login -w` asks two questions on a TTY. `setup`
  feeds it `Y\n\n` on stdin, which is the known-working non-interactive form,
  so no TTY is needed.
- **Plain-text token.** The container has no keyring, so `gh` stores the
  token in plain text in `hosts.yml` in the `memmem-server-gh` volume. Treat
  that volume as a secret. Passing `-e GH_TOKEN=...` also works, but it puts
  the token in `docker inspect` output, so don't use it.

## 4. Provider login without a TTY

`memmem-server setup` and `memmem-server provider connect <name>` always
pass `--backend local`. Inside the container, a Letta device-code login
without it starts a browser OAuth flow (a `localhost` callback that can't be
reached from outside the container) instead of printing a device code. Every
Letta call that `memmem-server` makes uses `--backend local` and the server's
`LETTA_CONFIG_DIR`.

## 5. Next steps (operator)

1. **Add the project.** Preview it first, then run it:

   ```bash
   docker exec memmem-server memmem-server project add <project> --owner <org> --dry-run
   docker exec memmem-server memmem-server project add <project> --owner <org>
   ```

   `project add` does the following:

   - creates the private repos `<org>/mem-<project>` and
     `<org>/mem-<project>-transcripts` on GitHub;
   - creates a Letta agent `<project>` in the container;
   - seeds its MemFS and pushes it;
   - writes `/root/.letta/agents/reflection.md` and
     `/var/lib/mem-mem/projects.json`.

   Then it **reloads the App Server** inside the running `memmem-server
   start` process. Letta Code's local backend reads agent records only at
   startup, so `project add` triggers the reload itself and prints an
   `App Server` line that says `reloaded`. No `docker restart` is needed.
   `docker logs memmem-server` then shows `server_reloading`,
   `app_server_ready`, `server_reloaded`, and `config_loaded` with
   `"projects":["<project>"]`. The worker also logs `config_loaded` again
   whenever `settings` change.

   With the default `stepCount: 3`, a reflection runs after every 3 ingested
   sessions. For a faster test, set `"stepCount": 1` in `settings`.

2. **Client.** On the host, install the client binary
   ([client/README.md](../client/README.md#install), `install.sh`), or run
   `node <repo>/client/bin/memmem.mjs` from a checkout (see below):

   ```bash
   mkdir -p ~/work/<project> && cd ~/work/<project> && git init -q
   memmem setup --project <project> \
     --memory-repo <org>/mem-<project> \
     --transcripts-repo <org>/mem-<project>-transcripts \
     --member <login>
   ```

   This registers four hooks for Claude Code in `.claude/settings.json` (plus
   the PATH safety net copy in `.claude/settings.local.json`), and the same
   four for Codex in `.codex/hooks.json`:

   - `SessionStart` runs `session-start`;
   - `SessionEnd` runs `session-end`;
   - `Stop` and `PreCompact` run `checkpoint`, which syncs a session that
     is still open (see `client/README.md`, "Checkpoints").

   In Codex, trust the four entries in `/hooks` once.

   Run a short Claude Code session in `~/work/<project>` that makes a
   decision, then end it. To see a checkpoint without ending the session,
   start Claude Code with `MEMMEM_CHECKPOINT_MINUTES=0` in its environment:
   every response that grows the transcript by 2 KB or more then syncs it.

   **Local test only:** to keep a test run away from your real `~/.claude`
   and memmem data:

   - Run every `memmem` command with a throwaway `HOME` (or set
     `MEMMEM_HOME` to a temporary directory) and
     `node <repo>/client/bin/memmem.mjs` instead of a global install.
   - If the host `gh` keeps its token in the keyring, give the temporary HOME
     a minimal `.gitconfig` (the two `credential "https://github.com"` helper
     lines that `gh auth setup-git` writes, plus `user.name`/`user.email`),
     and point `GH_CONFIG_DIR` at the real `~/.config/gh`.
   - Instead of a real Claude Code session, you can pipe hook payloads
     (`{"session_id","transcript_path","cwd","hook_event_name",...}`) into
     `memmem session-start`, `memmem session-end` and `memmem checkpoint`.
     Synthetic transcripts can follow the format of
     `client/test/fixtures/claude-code-session.jsonl`.

3. **Verify.**
   - `docker exec memmem-server memmem-server status --project <project>`
     shows the queue, unreflected sessions, last pass, last reflection
     (outcome and commit), backoff and the last pushed memory head.
     `docker exec memmem-server memmem-server logs -f -p <project>` follows
     the worker log of one project.
   - The session file appears in `<org>/mem-<project>-transcripts` under
     `trajectories/...`. The client log is
     `<data root>/<project>/logs/sync.log` (data root: `$MEMMEM_HOME`, else
     `~/.local/share/memmem`).
   - In the worker log, the events come in this order:
     - `files_queued`, then `turn_done`;
     - when `stepCount` is reached: `reflection_started`
       (`"trigger":"step-count"`), `reflection_wait`, then `reflection_done`
       with a `commit` and a `report` excerpt of the reflection subagent's
       final message;
     - `reflection_recorded`, `memory_pushed` and `ingest_log_pushed`.
   - A reflection that finds nothing worth keeping and says so is accepted
     (`reflection_empty`). A reflection that failed, or whose outcome is
     unknown, continues with `reflection_retry` and a second
     `reflection_started` / `reflection_done`
     (`"trigger":"step-count-retry"`). If the retry saves nothing either, the
     worker logs `reflection_no_commit`: the sessions go into
     `pendingReflection`, and the next reflection is asked to record them.
     `memmem-server reflect retry --project <project>` runs that retry path
     once on demand.
   - `<org>/mem-<project>` has the reflection commit, and the transcripts
     repo has `ingest/log.jsonl`.
   - A new Claude Code session in `~/work/<project>` starts with the updated
     memory injected: root `MEMORY.md`, `project.md`, `human.md`, and one
     `## <folder>/ (index)` section per folder (`decisions/`, `changes/`,
     `context/`, `people/`). A new decision shows up in
     `## decisions/ (index)`.

## 6. Rebuild and recreate (upgrades)

To run a new build, rebuild the image and recreate the container with the
same name, environment and volumes. The volumes keep everything: the Letta
state (agents, conversations, provider login), the worker state and clones,
the server gitconfig (git identity and credential helper), and the gh login.
Nothing has to be set up again.

```bash
docker build -t mem-mem:e2e -f packages/server/Dockerfile .
docker stop -t 60 memmem-server && docker rm memmem-server     # graceful: the worker finishes its turn
docker run -d --name memmem-server \
  -e MEMMEM_POLL_SECONDS=20 \
  -v memmem-server-letta:/root/.letta \
  -v memmem-server-state:/var/lib/mem-mem \
  -v memmem-server-gh:/root/.config/gh \
  mem-mem:e2e
docker exec memmem-server memmem-server doctor
docker exec memmem-server memmem-server status
docker logs memmem-server 2>&1 | grep -E 'config_loaded|backoff_reset'
```

- **Passes before setup finishes.** The worker starts polling at once, so a
  pass that runs before setup finishes can fail (for example with
  `project_error` "could not read Username"). That pass backs off for one
  poll interval and the next pass succeeds.
- **`backoff_reset`.** It appears only if the state file had a backoff
  stored. A new worker process clears it.
- **`memmem-server restart`.** Inside the container it reloads the App Server
  and the worker in place. `restart --hard` (or `stop`) ends the container's
  main process, and therefore the container.

## Cleanup

```bash
docker stop memmem-server && docker rm memmem-server
docker volume rm memmem-server-letta memmem-server-state memmem-server-gh
gh repo delete <org>/mem-<project> --yes             # only if you want the test repos gone
gh repo delete <org>/mem-<project>-transcripts --yes
```

## Known limitations

- **Hidden reflection subagents accumulate.** Each reflection creates a new
  hidden local agent with its own conversation directory under
  `lc-local-backend/` in the Letta config directory. Nothing removes them
  yet, so they need pruning eventually.
- **Reflection outcome classification trusts the subagent.** When MemFS main
  did not move, the worker follows the subagent's final `RESULT:` line, even
  over failed tool calls (a subagent that recovered from a denied edit may
  legitimately find nothing to save). A subagent that hits a denial and then
  claims `nothing-to-save` is accepted; the `toolErrors` field on
  `reflection_done` shows it. Reports without a `RESULT:` line fall back to
  prose rules tuned on English reports; other languages or formats may be
  classified `unknown`, which costs a retry.
- **Carried-forward sessions re-read the whole conversation.** Sessions that
  a failed reflection could not save are named in the next reflection's
  instruction together with the conversation's `transcript.jsonl`. Each
  retry and each later reflection that names them reads that whole file,
  which grows all day. Pointing the instruction at the session's own payload
  would be cheaper.
- **`carriedForward` means "reviewed by", not "saved in".** In
  `ingest/log.jsonl`, a `carriedForward` entry maps a session to the commit of
  the later reflection that reviewed it. That commit may not contain anything
  from the session, and the entry can also carry `outcome: nothing_to_save`.
  Read it as "a later reflection saw this session", not as "this commit
  contains it".
- **The retry marker turn is not logged.** Before a retry the worker sends a
  short marker turn. Its token usage is added to the daily ingest totals, but
  no worker log event carries it, so the worker log alone undercounts tokens.
