# Contributing

Thanks for looking at mem-mem. This file covers the layout, how to run things
locally, the conventions, and how a release is cut.

## Layout

| Path | What |
|---|---|
| `client/` | `memmem`, the teammate CLI (Node.js ESM, compiled to single binaries with bun). Hooks, sync, `setup`, `init`, `status`, `doctor`, `remember`, skills for Claude Code and Codex. |
| `packages/server/` | `memmem-server`, the operator CLI and the ingest/reflection worker (TypeScript). `WORKER.md` explains the worker. |
| `packages/server/Dockerfile` | The server image: Node 24 + Letta Code + the packed server tarball. |
| `templates/` | Initial layout of a project's memory repo (per language) and transcripts repo. |
| `scripts/` | `install.sh`, `install.ps1` (client), `install-server.sh` (server). |
| `docs/` | Design notes and measurements, the e2e runbook, diagrams. |
| `.github/workflows/` | `ci.yml` (tests on push/PR), `release.yml` (binaries, tarball, image on `v*` tags). |

Both packages share one version number and a `layoutVersion` for the files
they exchange through the transcripts repo. Bump them together.

## Running locally

```bash
npm ci                                   # workspaces: client, packages/server
npm test --workspace mem-mem-client              # client tests (node:test)
npm test --workspace memmem-server       # server tests
npx tsc -p packages/server/tsconfig.json --noEmit
node client/scripts/embed-assets.mjs --check   # skills and snippets are embedded into lib/assets.generated.mjs
node client/scripts/build-bin.mjs        # bun-compiled binaries into client/dist/
MEMMEM_TEST_BIN=client/dist/memmem-<target> npm test --workspace mem-mem-client   # the suite against a binary
docker build -t mem-mem:dev -f packages/server/Dockerfile .
```

The server tests take a few minutes. A full end-to-end run (server image, a
test project with two private repos, real Claude Code and Codex sessions) is
described step by step in [docs/e2e-docker.md](docs/e2e-docker.md). If you run
the end-to-end runbook and find something, open an issue or update Known
limitations.

## Conventions

- **Letta as-is.** mem-mem uses Letta Code's App Server, MemFS, reflection,
  `/init` and trajectory format without forking them. Prefer feeding Letta the
  right inputs over re-implementing its behaviour. When something depends on
  Letta's internals, write down the measured behaviour in `docs/research/`.
- **Two packages, one contract.** Anything written to the transcripts repo
  (`bootstrap/`, `members/`, `ingest/log.jsonl`, `project.json`) is read by the
  other package. Keep old fields when adding new ones, and add a test on both
  sides.
- **Language.** Code, CLI output, logs, READMEs, this file and all docs are
  English. Link new docs from `docs/README.md`. User-facing strings that the
  client injects or prints to a human come in `en` and `ko`.
- **No secrets, anywhere.** Tokens, emails and private URLs never go into
  logs, status files, docs or test fixtures. The client redacts secret-like
  strings before a transcript leaves the machine; keep that list current.
- **Commits.** Conventional prefixes (`feat(server):`, `fix(client):`,
  `docs(e2e):`, `build(release):`). One logical change per commit; mention the
  test count when it changes.
- **Tests before rollout.** Both suites and the type check pass before a
  commit lands on the main line. The e2e runbook is the acceptance test.

## Release

1. Bump `version` in `client/package.json` and `packages/server/package.json`
   together (and `layoutVersion` if the exchanged files changed).
2. Commit, tag `vX.Y.Z`, push the tag. `release.yml` builds the client
   binaries for the five targets, runs the client tests against them, packs the
   server tarball, publishes everything to the GitHub Release with one
   `SHA256SUMS`, and pushes the multi-arch image to GHCR.
3. Check the Release page and `docker pull ghcr.io/<owner>/mem-mem-server:X.Y.Z`,
   then run the installers once from a clean shell.

Neither package is published to the npm registry; the installers and the image
are the distribution.

## Reporting problems

Open an issue with the output of `memmem doctor` (client) or `memmem-server
doctor` (server) and the relevant `docker logs` / `memmem-server logs` lines.
Strip tokens and repo URLs you do not want public.
