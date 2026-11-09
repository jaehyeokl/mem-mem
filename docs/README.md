# docs

Design notes, research, guides and the end-to-end runbook for mem-mem.

## Design

- [design/architecture.md](design/architecture.md): the architecture.
  Principles, components A to D (memory repo, transcripts repo, engine server,
  client adapter), data flow, what is implemented here versus taken from Letta
  Code, decisions, what is still to verify, phases.
- [design/project-initialization.md](design/project-initialization.md): how an
  existing project gets its initial memory. Letta's own `/init` runs on the
  server agent with code, past sessions and pre-answered questions staged by
  the client (`memmem setup` / `init` / `status`); several members per project
  (project_init / contribute / deepen); member identity (GitHub login,
  `members/<handle>.json`, aliases).
- [design/packaging.md](design/packaging.md): two packages (client:
  bun-compiled binaries + GitHub Releases + install.sh; server: Docker/GHCR
  image + Releases tarball + install-server.sh; neither on the npm registry),
  the server setup wizard, the operator command surface, client decisions,
  language in three layers, docs structure.

## Research

- [research/letta-measurements.md](research/letta-measurements.md): the
  verified Letta Code behaviours mem-mem relies on, with versions: reflection
  through the App Server, transcript normalization, the reflection model
  override, MemFS push behaviour, Codex hooks, transcript sizes, the App Server
  + SDK ingest path, token usage records.
- [research/letta-memory-initialization.md](research/letta-memory-initialization.md):
  how Letta's own `/init` works (the `initializing-memory` skill, history
  cohorts, Workflow subagents, commits), which mem-mem runs headless on the
  server.
- [research/letta-memory-organization.md](research/letta-memory-organization.md):
  how Letta itself scopes memory (agent = MemFS), handles several codebases,
  shares memory between agents and teams (cloud only), and what that implies
  for one agent per project.

## Operations

- [e2e-docker.md](e2e-docker.md): runbook for running the server image in
  Docker with a host client, upgrades, cleanup, and known limitations.

## Images

- [images/architecture-boundary.svg](images/architecture-boundary.svg):
  components and the Letta / mem-mem boundary.
- [images/init-message-path.svg](images/init-message-path.svg): how
  `memmem init` requests, status and answers travel through the transcripts
  repo.
- [images/session-loop.svg](images/session-loop.svg): one session from memory
  injection to the next reflection.
