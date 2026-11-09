# memmem-server

> memmem-server is not on the npm registry. Install it from the Docker image
> on GitHub Container Registry, or from the tarball attached to each
> [GitHub Release](https://github.com/jaehyeokl/mem-mem/releases) (see
> [Install](#install)).

The mem-mem server. It runs a [Letta Code](https://github.com/letta-ai/letta-code)
App Server and the ingest worker. The worker turns your team's Claude Code /
Codex session transcripts into shared, git-backed project memory: it feeds
each session to the project's Letta agent, runs Letta's reflection, and
pushes the memory to the project's GitHub repo.

`memmem-server` is a Node CLI first. The Docker image is a thin wrapper that
installs Letta Code and this package, then runs `memmem-server start`, so a
local install and the container run the same code.

Every operation is a command. Commands are idempotent (running one again
skips what is already done) and show up in `status` and `doctor`. Each
command prompts on a terminal, and takes flags (`--yes`, explicit values)
when no terminal is attached.

How the worker works inside (passes, reflection outcomes, retry and
carry-forward, project init, state and log formats): [WORKER.md](WORKER.md).

**Project init.** When a team member runs `memmem init`, the worker clones
the project's code, lays out the uploaded past sessions where Letta Code's
`/init` expects them, answers `/init`'s questions in a first turn, and runs
Letta's own `/init` on the project agent in a new conversation. The first
request initializes the project; later members' requests only add their own
past sessions (`contribute`), and a request for a deeper research depth
re-initializes (`deepen`). Progress and
any question go to `bootstrap/status.json` in the transcripts repo (`memmem
status` on the client) and to `memmem-server init status`. The init session
runs with permission mode `unrestricted` in the code clone, because no one is
there to approve tools: only connect repositories whose content you trust.

## Install

memmem-server is not on the npm registry; the tarball comes from GitHub
Releases. Pick one of three ways, in this order of preference.

### Docker (recommended)

The image `ghcr.io/jaehyeokl/mem-mem-server:<version>` (also `:latest`;
`linux/amd64` and `linux/arm64`) contains Node 24.22, Letta Code 0.34.41,
`git`, `gh`, `zstd`, `python`, `tini` and this package, and runs
`tini -- memmem-server start`. With no projects yet, the server idles until
`project add`.

```yaml
# compose.yaml
services:
  memmem-server:
    image: ghcr.io/jaehyeokl/mem-mem-server:0.1.0   # or :latest
    container_name: mem-mem
    restart: unless-stopped
    environment:
      TZ: UTC                             # dailyReflectHour and the daily conversation use local time (set your team's zone)
    volumes:
      - mem-mem-letta:/root/.letta        # Letta state and the model provider login (secret)
      - mem-mem-state:/var/lib/mem-mem    # projects.json, worker state, clones, logs, gitconfig
      - mem-mem-gh:/root/.config/gh       # gh login: a plain-text GitHub token (secret)
volumes:
  mem-mem-letta:
  mem-mem-state:
  mem-mem-gh:
```

```bash
docker compose up -d
docker exec -it mem-mem memmem-server setup            # device codes for GitHub and the model provider are shown here
docker exec mem-mem memmem-server project add acme --owner acme-org --dry-run
docker exec mem-mem memmem-server project add acme --owner acme-org
docker exec mem-mem memmem-server status
docker logs -f mem-mem
```

- `MEMMEM_SERVER_HOME=/var/lib/mem-mem`. The server gitconfig
  (`/var/lib/mem-mem/gitconfig`) lives on the state volume, so the git
  identity and the credential helper survive when the container is
  recreated.
- `LETTA_CONFIG_DIR=/root/.letta`, which keeps existing `/root/.letta`
  volumes working.
- `project add` reloads the App Server inside the container. A
  `docker restart` is not needed.
- The gh volume holds a plain-text GitHub token, and the Letta volume holds
  the provider login. Treat both as secrets.
- The App Server listens on `127.0.0.1` inside the container only. Nothing is
  published, so the compose file has no `ports`.
- To build the image yourself from a checkout:
  `docker build -t mem-mem:dev -f packages/server/Dockerfile .`

### install-server.sh (a machine with Node.js)

Requirements: Node.js >= 24.22 (Letta Code's minimum), npm, git. Optional:
`gh` (creates repos and handles git auth for GitHub), `zstd` (compressed Codex
sessions). Linux and macOS.

```bash
curl -fsSL https://raw.githubusercontent.com/jaehyeokl/mem-mem/main/scripts/install-server.sh | sh
curl -fsSL https://raw.githubusercontent.com/jaehyeokl/mem-mem/main/scripts/install-server.sh | sh -s -- --ref v0.1.0
memmem-server setup
```

What the script does:

1. Checks Node.js >= 24.22, npm and git. It never installs Node; if Node is missing or too old, it prints how to install it and stops.
2. Installs Letta Code from npm (`@letta-ai/letta-code@0.34.41`, with `--allow-scripts=@letta-ai/letta-code,node-pty`) if `letta` is missing or older than `^0.34.41`.
3. Downloads `memmem-server-<version>.tgz` and `SHA256SUMS` from the GitHub Release (latest, or `--ref vX.Y.Z`) and verifies the checksum.
4. Runs `npm i -g ./memmem-server-<version>.tgz`, checks `memmem-server version`, and prints the next step (`memmem-server setup`). It never uses sudo and never edits shell startup files.

`MEMMEM_SERVER_INSTALL_PREFIX` (or `--prefix <dir>`) installs both packages
with `npm --prefix <dir>` instead of npm's global prefix; add `<dir>/bin` to
`PATH`. `GITHUB_TOKEN`, if set, is sent only to `api.github.com` (to resolve
`latest` past the anonymous rate limit). To update, run the script again.

The same steps by hand, with a tarball downloaded from the Release:

```bash
npm i -g --allow-scripts=@letta-ai/letta-code,node-pty @letta-ai/letta-code@0.34.41
npm i -g ./memmem-server-0.1.0.tgz
```

The tarball bundles its runtime dependencies (the Letta Agent SDK and `ws`).
Because of this, installing it does not pull in a second, nested copy of
Letta Code, which the SDK lists as a peer dependency (about 1 GB).

### From source (contributors)

```bash
git clone https://github.com/jaehyeokl/mem-mem && cd mem-mem
npm ci                                                  # the root .npmrc sets legacy-peer-deps
npm run pack:release --workspace memmem-server -- /tmp/out
npm i -g /tmp/out/memmem-server-*.tgz
```

Or run the CLI straight from the checkout:
`node packages/server/bin/memmem-server.js -h` (after `npm run build`).
Letta Code still has to be installed globally, as above. See
[Development](#development).

## First run

```bash
memmem-server setup                         # checks, git identity, GitHub, model provider, models
memmem-server project add acme --owner acme-org --dry-run
memmem-server project add acme --owner acme-org
memmem-server start                         # foreground; or --detach, or --install-service
memmem-server status
```

`setup` is a wizard that you can run again at any time. Each step prints a
one-line result and is skipped when it is already done:

1. **Checks.** These are the tool checks from `doctor`. If something is
   missing, setup prints the exact install command and stops.
2. **Data directory and git identity.** The identity (`user.name` /
   `user.email`) goes into a server-scoped gitconfig in the data directory
   (`GIT_CONFIG_GLOBAL`). Your own `~/.gitconfig` is never read or written.
3. **GitHub.**
   - With `gh`: setup runs `gh auth login` (device code) and shows you the
     one-time code and URL. Then it runs `gh auth setup-git` into the server
     gitconfig.
   - Without `gh`: either paste a token (stored with mode 0600 in
     `<data>/git-credentials` and used through git's `store` helper), or skip
     and create the repos yourself (for example with SSH URLs).
4. **Model provider.** Either Letta's `chatgpt` provider with a device-code login
   (`letta connect chatgpt --method device-code`, with the code shown to you),
   or an API-key provider (Anthropic, OpenAI, Gemini, OpenRouter, ...).
5. **Models.** The default agent model for new projects, and the reflection
   model (`<LETTA_CONFIG_DIR>/agents/reflection.md`). The reflection model
   defaults to the agent model.

Non-interactive example (CI or a provisioning script):

```bash
memmem-server setup --yes --git-name mem-mem --git-email mem-mem@example.com \
  --github gh --provider chatgpt --model openai-codex/gpt-5.6-sol
printf %s "$GITHUB_TOKEN" | memmem-server setup --yes --github token --token-stdin --provider skip
```

## Commands

Every command accepts `-h`. Commands with structured output accept `--json`:
stdout then carries one JSON document, and progress goes to stderr. `--home
<dir>` overrides the data directory, and `-y/--yes` never prompts.

| Command | What it does |
|---|---|
| `setup` | First-time setup wizard (above). Flags: `--git-name`, `--git-email`, `--github gh\|token\|skip`, `--token-stdin`, `--provider chatgpt\|<name>\|skip`, `--api-key-stdin`, `--model`, `--reflection-model` |
| `doctor` | Checks: Node, Letta Code, git, gh, zstd, data dir, git identity, GitHub login and credential helper, provider logins and token expiry, reflection model, server and App Server (`/readyz`), worker, and per project whether the agent exists, whether it is loaded by the running App Server, MemFS, and backoff. Exits 1 if anything critical fails |
| `start` | Starts `letta server --backend local --listen ws://127.0.0.1:<port> --openai-api`, waits for `/readyz` (60 s), then runs the worker in the same process. If either one dies, the other is stopped and `start` exits non-zero. `--detach` runs it in the background, `--port` sets the port (default `$LETTA_APP_SERVER_PORT` or 4500), `--install-service` writes a systemd user unit or a launchd agent |
| `stop [--wait-reflection]` | Graceful stop: the worker finishes its current turn (up to 30 s). `--wait-reflection` first waits, up to 10 min, until no project has a reflection in flight |
| `restart [--hard]` | Restarts the App Server and the worker inside the running process, so Letta reads agents, models and providers again (it reads them only at startup). `--hard` restarts the whole process, through the service manager when one is installed |
| `status [--project p]` | Running or not, pid, uptime, App Server readiness. Per project: queue length, unreflected and carried-forward sessions, last pass, last reflection (outcome, commit), backoff, last pushed memory head, the current or last init (state, commits, question or error), and a `usage 7d` line (ingest turns, reflection and init runs with their tokens, and Letta's cost estimate when known) |
| `project add <name>` | Creates `<owner>/mem-<name>` and `<owner>/mem-<name>-transcripts` (unless you pass `--memory-repo` / `--transcripts-repo`), seeds the transcripts layout, creates the Letta agent and sets its model, seeds MemFS from `templates/memory-repo/<language>`, sets `letta.memoryRepository.url` and pushes, writes `reflection.md`, merges the `projects.json` entry, then **reloads the running App Server** so the new agent is loaded. Flags: `--owner`, `--model`, `--reflection-model`, `--force-reflection-model`, `--summary`, `--language en\|ko` (memory language, default `en`: recorded in `projects.json` and in the transcripts repo's `project.json`, which teammates' `memmem setup` reads), `--dry-run`, `--no-reload`, `--skip-provider-check` |
| `project list` / `show <name>` | The registered projects (with their memory language), or one project's entry and worker state |
| `project set-language <name> <en\|ko>` | Changes the memory language in `projects.json` (the worker applies it at its next pass) and commits and pushes the transcripts repo's `project.json`. Existing memory text is not translated; teammates update `.memmem/config.json` with `memmem setup --language <lang>` (`memmem doctor` warns until then) |
| `project pause <name>` / `resume <name>` | Sets `enabled: false` / removes it. The worker applies it at its next pass |
| `project remove <name>` | Removes the `projects.json` entry and the local worker state (`state/<name>.json`, `agentcwd/<name>`, the clone under `repos/<name>` unless `--keep-repos`). The GitHub repos are kept unless you pass `--delete-repos`, which also requires typing the project name (or `--confirm <name>`). The Letta agent and its MemFS are kept |
| `model list` | Handles from `letta model list`, marked with where each one is used |
| `model set <handle> [--project p]` | `letta model set <handle> --agent <id>` for one project, or for all projects plus the default for new ones. Updates `projects.json` and reloads the App Server |
| `model set-reflection <handle>` | Writes `reflection.md` and reloads the App Server. This setting is **server-wide**: Letta Code 0.34.41 resolves the reflection subagent's model only from that file. Its per-agent `reflectionSettingsByAgent` holds trigger, step count and merge settings, not a model |
| `provider list` | Connected providers from `auth.json` (name, type, token expiry; no secrets) |
| `provider connect <name>` | `chatgpt`: the device code flow, with the code shown to you. API-key providers: Letta prompts for the key on a terminal, or you pipe it in with `--api-key-stdin` (`--base-url` for OpenAI-compatible providers). Reloads the App Server |
| `provider disconnect <name>` | Removes the provider from `auth.json` (Letta's CLI has no disconnect) and reloads the App Server |
| `reflect now --project p` | One reflection on the project's current ingest conversation, through the worker's normal path: instruction, outcome classification, one retry, carry-forward, memory push, `ingest/log.jsonl`. With a running server the request goes to its worker and runs between passes, so it never races a pass. Without a running server it runs in the CLI process, as long as an App Server answers |
| `reflect retry --project p` | The retry path once (a marker turn, then the retry instruction) for the carried-forward and unreflected sessions |
| `init status --project p` | Project memory initialization: the current or last run (state, kind, requested by, sessions and token estimate, conversation, commits, question or error), who initialized the project at what depth, one row per member (kind, state, sessions, finished, init id), and the request files already handled |
| `init run --project p` | Start the init now. Re-runs the newest `bootstrap/*/request.json` even if it was already handled (after a failure, or to re-initialize). With a running server the worker starts it in the background and the command returns; without one it runs in this process against the App Server until it settles |
| `init cancel --project p` | Abort a running init (the turn is aborted) or drop a pending question. The run is recorded as `failed` ("cancelled by the operator") |
| `members [--project p]` | Team members registered in the transcripts repo (`members/<handle>.json`): display name, aliases, git author names (no emails), joined date, and each member's init contribution |
| `logs [-p project] [-f] [-n 200] [--raw]` | Tails `logs/worker.log` (pretty-printed; `--raw` prints the JSON lines) |
| `usage [-p project] [--since 7d\|30d\|YYYY-MM-DD]` | Token usage from each project's daily ledger (kept 90 days): one row per day with columns per kind (ingest turns, reflection runs, init runs: count, total tokens, cached input, and cost when known), a total row and a one-line summary. Default `--since 7d` (today and the 6 days before). Cost is known for reflections only. Cost is Letta's own estimate from its price table and is only notional when the provider reports no per-token price. See WORKER.md "Token usage" |

All Letta calls use the server's `LETTA_CONFIG_DIR` and `--backend local`, and
run with the data directory as their working directory.

## Data directory

`$MEMMEM_SERVER_HOME`, else `$XDG_DATA_HOME/memmem-server`, else
`~/.local/share/memmem-server`:

| Path | What |
|---|---|
| `letta/` | `LETTA_CONFIG_DIR` for the server's own Letta state (agents, MemFS, provider logins, transcripts), used only when `LETTA_CONFIG_DIR` is unset. An operator's personal `~/.letta` is never shared |
| `projects.json` | Projects (`project`, `agentId`, `memoryRepo`, `transcriptsRepo`, `model`, `enabled`), worker `settings`, and the `defaults` chosen in setup. `$MEMMEM_CONFIG` overrides the path. See `config/projects.example.json` |
| `state/<project>.json` | Worker state per project (cursor, queue, unreflected and carried-forward sessions, last pass and reflection, backoff, the 90-day token usage ledger) |
| `repos/<project>/transcripts` | Transcripts repo clones |
| `agentcwd/<project>` | Working directory of the App Server sessions. `repo/` (and `repo-<name>/` for related repos) is the code clone used by project init, kept for re-init |
| `logs/worker.log` | The worker's JSON log. The same lines also go to stdout. Rotated to `.1` at 50 MB when `start` runs |
| `logs/app-server.log` | Letta App Server output |
| `gitconfig` | `GIT_CONFIG_GLOBAL` for everything the server runs: git identity and credential helper |
| `git-credentials` | Optional token store (mode 0600) when `gh` is not used |
| `requests/` | One-shot requests from `reflect now/retry` to the running worker |
| `server.pid`, `server.json` | The running `start` process: pid, port, App Server pid and start time, last reload |

Signals to the `start` process: `SIGTERM`/`SIGINT` stop it gracefully
(sending a second one forces the exit), `SIGHUP` reloads (what `restart` and
`project add` send), and `SIGUSR2` wakes the worker for a queued request.

Other environment variables: `LETTA_APP_SERVER_PORT` (4500),
`MEMMEM_POLL_SECONDS` (60), `MEMMEM_READY_TIMEOUT` (60 s), `MEMMEM_LOG_LEVEL`,
`MEMMEM_TEMPLATES`, `TZ` (for `dailyReflectHour`). The full list is in
[WORKER.md](WORKER.md#configuration).

## Run as a service

```bash
memmem-server start --install-service
```

- **Linux:** writes `~/.config/systemd/user/memmem-server.service`, which
  runs `memmem-server start --foreground` with `Restart=on-failure` and the
  current `PATH`, `MEMMEM_SERVER_HOME` and `LETTA_CONFIG_DIR`. The command
  prints `systemctl --user daemon-reload && systemctl --user enable --now
  memmem-server.service`, and `sudo loginctl enable-linger $USER` to keep the
  service running after you log out.
- **macOS:** writes `~/Library/LaunchAgents/dev.memmem.server.plist`
  (`KeepAlive` on failure) and prints the `launchctl bootstrap` command.

`--install-service` never enables the service itself. Once a service is
installed and active, `stop` and `restart --hard` go through the service
manager.

## Development

From the repo root (npm workspaces: `client` and `packages/server`):

```bash
npm ci
npm test --workspace memmem-server          # build + unit tests (no network, no Letta)
node packages/server/bin/memmem-server.js -h
npm run pack:release --workspace memmem-server -- /tmp/out   # the release tarball
```

- **Templates.** In a checkout, the CLI reads the repo's `templates/`
  directly. `npm run pack:release` (and `npm pack`, through `prepack`) copies
  them into the package so that the release tarball is self-contained.
  `$MEMMEM_TEMPLATES` overrides both.
- **Integration test.** `MEMMEM_IT=1 npm run test:integration` runs the
  worker against a real App Server and uses model quota. See the test's
  header for details.
- **Releases.** A tag `vX.Y.Z` (equal to both packages' versions) runs
  `.github/workflows/release.yml`: it attaches `memmem-server-X.Y.Z.tgz` to
  the GitHub Release next to the client binaries, lists it in the shared
  `SHA256SUMS`, and pushes `ghcr.io/jaehyeokl/mem-mem-server:X.Y.Z` and
  `:latest` built from that same tarball. `publishConfig.access` is
  `restricted` as a guard against an accidental public `npm publish`.
