# Packaging and distribution

Written November 2026. Assuming an open-source release, this note settles
the package layout of the client and the server, the distribution channels,
first-time setup and operator commands, and the docs structure. The
initialization flow is in [project-initialization.md](project-initialization.md).

## 1. Two packages, one repository

| Package | For | Runtime | Dependencies | Distribution |
|---|---|---|---|---|
| `memmem` (client) | Every teammate | None (single executable) | `@letta-ai/trajectory` only (bundled) | GitHub Releases binaries + `install.sh` |
| `memmem-server` (server) | The operator | Node >= 24.22 (required by Letta Code) | `@letta-ai/letta-code` (peer), `@letta-ai/letta-agent-sdk`, `ws` | Docker image on GHCR (default) + GitHub Releases tarball + `install-server.sh`. **Not published to the npm registry** |

- One repository (npm workspaces: `client`, `packages/server`); the two
  packages are released together with **the same version number**. The
  Docker image tag is the same too.
- Real compatibility is kept by the repo layout version (`layoutVersion`,
  recorded in `.memmem/config.json`, the transferred files and
  `request.json`), not by the version number. The client reads one version
  before and after its own (`memmem doctor` fails outside that range); the
  server does not check the version yet. The server records its own version
  as `serverVersion` in `bootstrap/status.json`, and `memmem status` shows
  it.
- The shared code is the "repo layout contract"; it is implemented separately
  on each side and each side guards it with its own tests. If the overlap
  grows, `@memmem/core` gets pulled out then.
- Why the server is not merged into one package: the worker's SDK pulls in the
  Letta Code body as a peer (hundreds of MB, a native node-pty build, Node
  24.22). The client must not be tied to any of that, so that "one line to
  install for teammates" holds.

## 2. Client distribution: without npm

- `bun build --compile` produces five single executables per platform (linux
  x64/arm64, macOS x64/arm64, Windows x64). GitHub Actions builds them on
  every tag, uploads them to Releases, and puts a `SHA256SUMS` file next to
  them.
  bun is only a build tool (dev dependency) and is not exposed to users.
  Measured: it compiles without code changes (90 MB, startup and memory on par
  with Node), but the background `sync` child that the hooks spawn needs a
  branch that "when compiled, re-runs `process.execPath` as `memmem sync ...`".
- `install.sh` (POSIX sh): detect OS and architecture -> download from Releases
  (`--ref vX.Y.Z` or latest) -> verify the checksum -> `~/.local/bin/memmem`
  (back up an existing file, restore on failure) -> self-check with
  `memmem --version` -> PATH guidance (shell config is not touched). Windows
  uses `install.ps1`. The download source is the project's GitHub Releases
  (`MEMMEM_OWNER` overrides the repository owner).
- The first install line in the user docs is a single
  `curl -fsSL https://raw.githubusercontent.com/<org>/mem-mem/vX.Y.Z/scripts/install.sh | sh`.
  The README gives four lines on "what the script does".
- No npm release (two channels lead to version mismatch questions). Running
  from source is described only in the Contributing section.
- Benefits: no dependency on Node, nvm or mise, so there are fewer PATH
  problems when GUI apps run hooks, and every teammate can share committed hook
  configuration with the same content (`memmem session-start ...`).

## 3. Server distribution: the package is the core, Docker is the front door, no registry

- `memmem-server` is a Node CLI (in the **shape** of an npm package). The shape
  is kept because it keeps the Docker image thin, allows a local install, and
  makes testing and development easy. But it is **not published to the npm
  registry.** The server is an always-on service set up by one operator, so
  registry discoverability means nothing, and two channels lead to version
  mismatch questions. Our distribution, client and server alike, lives in one
  place: GitHub Releases.
- Channels (in order of visibility): (1) the Docker image
  `ghcr.io/<owner>/mem-mem-server:<version>` (multi-arch; one compose line is
  the first line of the operator docs); (2) the tarball
  `memmem-server-<version>.tgz` attached to the same Release (dependencies
  bundled, shared `SHA256SUMS`); (3) `install-server.sh`: check Node >= 24.22
  (only guidance if missing) -> install Letta Code (from the npm registry;
  unavoidable, since that is Letta's channel) -> download the tarball and
  verify the checksum -> `npm i -g ./tarball` -> "next: `memmem-server setup`".
- Operator options: (1) compose on a VPS (default); (2) `install-server.sh` on
  an always-on machine of your own; (3) a solo developer runs
  `memmem-server start` on a laptop (no hosting).
- The state directory lives under `MEMMEM_SERVER_HOME` (default
  `~/.local/share/memmem-server`), and a server-only `LETTA_CONFIG_DIR` and
  `GIT_CONFIG_GLOBAL` live inside it, so they do not mix with the operator's
  personal `~/.letta` and `~/.gitconfig`. Docker keeps the existing volume
  paths (`/root/.letta`, `/var/lib/mem-mem`).
- What cannot be avoided: the npm install of Node and Letta Code. On the Docker
  path users do not see it.

## 4. First server setup: `memmem-server setup`

An interactive wizard in the same spirit as Letta Code's `/connect` and the
`login` of Codex and Claude Code. It can be re-run and skips steps that are
done.

1. Checks (= `doctor`): Node, Letta Code version, git, gh (optional), zstd
   (optional). If something is missing, it shows the install command and
   stops.
2. The state directory and a git identity for the server (`GIT_CONFIG_GLOBAL`
   points inside the state directory; the operator's global gitconfig is not
   touched).
3. GitHub: with gh, show the device code and URL on our screen, wait for
   approval, then `setup-git`. Without gh, enter a token or choose "I will
   create the repos myself".
4. Model provider: pick from the list Letta supports; for a device-code flow,
   show the code and URL (`letta --backend local connect ...` runs inside).
   This works from an SSH terminal too (the browser is on the operator's PC).
5. Record the default agent model for new projects and the reflection model.
6. Print a checklist, then the next step:
   `memmem-server project add <name> --owner <github-owner> --dry-run`.

## 5. Operator command surface

Principles: the operator never has to edit files by hand, every command is
idempotent, and its result shows in `status`/`doctor`. A later admin UI is a
shell that calls the same commands.

```
memmem-server setup | doctor
memmem-server start [--detach] [--port n] [--install-service] | stop [--wait-reflection] | restart [--hard] | status [--project p] [--json]
memmem-server project add <name> [--owner o] [--model h] [--reflection-model h] [--memory-repo u] [--transcripts-repo u] [--language en|ko] [--summary t] [--dry-run]
memmem-server project list | show <name> | set-language <name> <en|ko> | pause|resume <name> | remove <name> [--keep-repos|--delete-repos]
memmem-server model list | set <handle> [--project p] | set-reflection <handle>
memmem-server provider list | connect <name> | disconnect <name>
memmem-server reflect now --project p | retry --project p
memmem-server init status|run|cancel --project p
memmem-server members [--project p]
memmem-server logs [--project p] [--follow] | usage [--project p] [--since 7d]
memmem-server members invite <gh-user> --project p          (later)
memmem-server upgrade | backup <dir> | restore <dir> | retention apply [--dry-run]   (later)
```

- `start` is a foreground process (start the App Server -> wait for `/readyz`
  -> worker; if either dies, both stop). Staying up and restarting are left to
  systemd/launchd/Docker, and `--install-service` writes the unit. `stop`
  sends SIGTERM using the PID file, and the worker waits up to 30 seconds for
  the turn in progress. `project add` reloads the App Server automatically at
  the end (the agent list is read only at startup).
- The reflection model override (`reflection.md`) is one per server in Letta.
  `reflectionSettingsByAgent` holds trigger, step count and merge settings,
  not a model, so `model set-reflection` is documented as server-wide.

## 6. Client design decisions

- Commands: `setup` (config + clone + hooks + skills; what used to be
  init + install), `install` (the user-level hooks and skill only), `init`
  (memory initialization), `status`, `doctor`, `remember`, `uninstall`
  (`--user` for the user level), and the hook-only `session-start`/
  `session-end`/`checkpoint`/`sync`.
- **User mode is the default (0.1.1).** The first team project lives in a
  client's repository shared with outsiders: nothing of mem-mem may be
  committed there and nobody else may be affected, and a project that does not
  use memmem must not be polluted. So the hooks (with a `--user` flag and a
  `[ -x <bin> ] || exit 0` guard) and the `memmem-init` skill are installed
  once per computer at the user level (`~/.claude/settings.json`,
  `~/.codex/hooks.json`, `~/.agents/skills`), and a project opts in only by
  having `.memmem/` (config, `local.json` with `mode: "user"`, a remember
  guide), hidden through `.git/info/exclude`. Every teammate runs the same
  full `setup`. A hook acts only when the config is found below the first
  `.git` boundary, a member is recorded, and its `--user` flag matches the
  checkout's mode, so user-level and project-level hooks never both run.
  Since `.memmem/` is untracked, a linked git worktree has none of its own: at
  the worktree's `.git` file the walk follows `gitdir` / `commondir` (no git
  process) to the main checkout and uses its `.memmem/`, so one opt-in covers
  every worktree; only the outbox stays per checkout, because that is the
  folder a sandbox lets the session write.
  Measured costs (Claude Code 2.1.319, Codex 0.164/0.167): the init skill is
  listed in every project's skill menu; Codex shows a one-time hook review
  screen (and again whenever a definition changes, so the user-level
  definitions are kept byte-stable); plain `codex exec` prints `hook:` lines.
  Claude Code gets no user-level `PreCompact`, because it reports a completed
  PreCompact hook to the model in every project. In the `codex exec` sandbox
  the data folder is read-only, so `remember` queues notes in
  `.memmem/outbox/` and the hooks' `sync` uploads them.
- **Shared mode (`setup --shared`, the 0.1.0 default).** The first teammate's
  `setup` writes `.memmem/config.json`, the hooks in `.claude/settings.json`,
  `.claude/skills/{remember,memmem-init}`, `.agents/skills/memmem-init`, the
  `AGENTS.md` snippet and two `.gitignore` lines, and prints what to commit
  (it does not commit for you). Later teammates only type `memmem setup`
  (clone, register and check; the handle comes from `gh`). Projects set up
  with 0.1.0 keep this mode. `setup --hooks-only` reinstalls the project-level
  hooks, skills and `AGENTS.md` block. The old `setup --local` (hooks in
  `.claude/settings.local.json`) is now a deprecated alias of user mode.
- **PATH safety net** (shared mode). The shared hooks call `memmem ...` (PATH), and `setup`
  also writes the same hooks with this machine's absolute path into
  `.claude/settings.local.json`. `doctor` checks for "the hook cannot find
  memmem". Binary distribution makes this problem mostly go away, but the
  safety net stays.
- **Language.** Split into three layers. (1) The conversation with the coding
  agent (the `/memmem-init` questions, the `remember` confirmation) follows the
  user's conversation language and has no setting. (2) The memory stored in git
  is **one language per project**, and the single source is the server's
  `memmem-server project add <name> --language en|ko` (default `en`). This
  value is recorded in `projects.json` and also written to the transcripts
  repo's `project.json`, so the teammate's `memmem setup` reads it without
  asking (if `--language` overrides it, `doctor` warns about the mismatch).
  There are two templates, `templates/memory-repo/{en,ko}`; folder names and
  frontmatter keys are English in both. In the normal reflection instruction
  and in the init pre-turn the server says "Write the memory in <language>.
  Sessions and `remember` notes in other languages are also written down in
  <language>. Keep proper terms (names, titles, identifiers, code) verbatim."
  If the `language` of an init request differs from the server value, the
  server value wins and the difference is logged. For an existing project,
  `project set-language <name> <lang>`. (3) Tool output (CLI, logs) is English.
  A person's own language context is kept not as the memory language but as
  "preferred conversation language" in `people/<handle>.md`, and the
  session-start injection says in one line "This memory is recorded in
  <language>. Talk to the user in the user's language." Mixing languages in one
  memory, or keeping one memory per language, was rejected for searchability
  and consistency.
- **What is not sent.** No telemetry. The README's first screen states that the
  only network counterparts are the team's two GitHub repos.
- Updates: re-run `install.sh` (a `memmem self-update` is not implemented).
  The skill files
  committed to the repo are copies, so re-running `setup` refreshes them and
  `doctor` warns about stale skills.

## 7. Docs structure

- `README.md`: what mem-mem is -> how it works (session loop, project
  initialization) -> design -> install -> quick start -> documentation links
  -> development -> license. The credit to Letta Code's `initializing-memory`
  skill, which the init questions are adapted from, is in the "How it works"
  paragraph on initializing a project. No badges or demo yet.
- Distribution as the README's install section describes it: the client is a
  binary on GitHub Releases, installed by `scripts/install.sh` (macOS, Linux)
  or `scripts/install.ps1` (Windows); the server is a checksum-verified
  tarball on the same Release, installed by `scripts/install-server.sh`, or the
  Docker image `ghcr.io/jaehyeokl/mem-mem-server`. Neither package is published
  to npm (sections 2 and 3).
- `CONTRIBUTING.md`: repository layout, branches and PRs, tests, the e2e
  environment, the release procedure (same version, Docker tag, Releases
  binaries).
- `AGENTS.md`: rules for AI agents working in this repository.
- `docs/`: three groups: user guides, operator runbooks, design and research
  notes, indexed by [docs/README.md](../README.md).

## 8. Deferred

Admin UI, an automatic setup guide (git and AI integration),
`members invite`/`backup`/`retention`/`upgrade`, a Homebrew tap, and a server binary
(not possible as long as Letta Code requires Node).
