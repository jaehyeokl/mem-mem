# AGENTS.md

Guidance for coding agents (Claude Code, Codex CLI and others) working on this
repository. Humans: see [CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

mem-mem is shared team memory for coding agents, built on Letta Code. Two
packages in one repo: `client/` (`memmem`, the teammate CLI, Node ESM compiled
with bun) and `packages/server/` (`memmem-server`, TypeScript worker + operator
CLI). They talk through two GitHub repos per project; the file formats they
exchange are the contract.

## Before you change anything

- Read [packages/server/WORKER.md](packages/server/WORKER.md) for the worker's
  flow (ingest turn, reflection, outcome classification, init classification,
  status files) and [docs/e2e-docker.md](docs/e2e-docker.md) "Known
  limitations" for what is known to be unfinished.
- Letta Code is used as-is. Do not copy or patch its skills, reflection or
  MemFS logic; stage inputs for it instead. Measured Letta behaviour lives in
  `docs/research/`; check there before assuming.
- The design decisions are in `docs/design/`. When a change contradicts
  one, update the design note in the same change.

## Commands

```bash
npm ci
npm test --workspace mem-mem-client              # client, fast
npm test --workspace memmem-server               # server, a few minutes
npx tsc -p packages/server/tsconfig.json --noEmit
node client/scripts/embed-assets.mjs --check     # run without --check after editing client/claude, client/agents, client/codex
node client/scripts/build-bin.mjs                # binaries into client/dist/
```

## Rules

- Keep both test suites and the type check green. Add tests on both sides when
  a file exchanged through the transcripts repo changes, and keep old fields.
- Skills and snippets under `client/claude/`, `client/agents/`, `client/codex/`
  are embedded into `client/lib/assets.generated.mjs`; regenerate it or the
  check fails.
- Never write tokens, emails, or private URLs into logs, status files, docs,
  fixtures or commit messages. Never print credentials in a report.
- English for code, CLI output, logs, READMEs and all docs. `en` and `ko` for
  strings the client shows to a person.
- Do not point tests or commands at a real server, container or GitHub repo;
  use fixtures and `MEMMEM_HOME`.
- Commit prefixes: `feat(client):`, `fix(server):`, `docs(e2e):`, `build(release):`.
  Do not bump versions or tag releases unless asked; the two packages share one
  version.
