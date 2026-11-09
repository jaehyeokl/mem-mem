# How Letta organizes memory: agents, projects, teams

Written November 2026. Purpose: before deciding whether to change the "one
Letta agent per team project" design, summarize Letta's own model. No
recommendation is made.

Notation

- **Verified**: checked directly in the docs or the code. **Assumed**: an
  interpretation combining several sources, or no primary source.
- `LC` = the installed `@letta-ai/letta-code` package directory
  (`<node prefix>/lib/node_modules/@letta-ai/letta-code`, letta-code 0.34.41).
  `letta.js:N` is a line number in the bundle.
- `docs:<path>` = `https://docs.letta.com/<path>/index.md` (the raw markdown,
  downloaded in November 2026). The docs pages carry no dates. Blog posts and
  issues are given with their dates.

## Summary

1. Letta's basic unit is **one agent = one identity = one MemFS**. Memory
   belongs to the agent, not to a directory, and "follows it wherever it
   runs". A conversation is a thread that shares the same memory.
2. Letta Code remembers only "the last agent/conversation used" per directory
   (`<repo>/.letta/settings.local.json`, git-ignored). In a new directory it
   **reuses an existing agent**, in this order: the pinned agent, the global
   last agent, the most recently active agent. There is no behaviour that
   creates a new agent per project.
3. Per the docs: use a separate agent when you **want to separate** identity
   or memory, and a separate conversation when you need parallel threads with
   the same memory.
4. For several codebases, the `/init` skill's example splits them inside one
   MemFS into **folders named after the real project** (`orchard/MEMORY.md`
   and so on). There is no fixed file name such as `project.md`. The blocks
   created by default are two: `persona` and `human`.
5. The current means of sharing between agents is the **shared memory
   repository** (a git repository hosted by Letta Cloud and owned by the
   organization). It is **cloud only** and switched off in the code for local
   backend agents. The old "shared memory blocks" are legacy, and the docs say
   to move to shared memory repositories.
6. Team features (a paid team plan) consist of organizations, roles
   (Admin/Editor/Analyst), and agent sharing. Each member of a shared agent has
   their own conversations, and by default a conversation is visible only to
   its owner. Shared memory repositories have no path or role based permission
   model (a request issue is open).
7. The unit of reflection is **one agent MemFS**. The input is a per
   conversation transcript (or a manifest bundling several conversations);
   there is no project or directory axis. The reflection prompt only has the
   category name "project details" and does not deal with several
   repositories.
8. The local backend has one MemFS per agent
   (`~/.letta/lc-local-backend/memfs/<agent-id>/memory`). `/memory-repository`
   is a **one-way mirror (backup)** of the MemFS to one external git URL.

## 1. Letta Code's model when one user handles several projects

### 1.1 Agents and directories

- **Verified**: memory is owned by the agent and does not follow directories.
  `docs:agent-sdk/memory`: "An agent's memory is its own: it persists across
  conversations, follows the agent between models and computers".
  `docs:concepts/memfs`: "the memory itself is part of the agent's state, held
  in a git repository that belongs to the agent".
- **Verified**: the system prompt (`letta.js:99952`, letta_root_memfs.md) says
  "All of this memory belongs to a single agent identity". The same prompt,
  `letta.js:100074`: "Skills and files belonging to the environment stay with
  the environment (e.g. `AGENTS.md` or `.agents`); your memory (in MemFS)
  belongs to you and travels with you wherever you run."
- **Verified**: `docs:concepts/stateful-agents` §Switching agents: "Use
  separate agents when you want independent identities or memory. Use separate
  conversations when you want parallel threads with the same identity and
  memory."
- **Verified**: `docs:concepts/conversations`: "When you run `letta` without
  arguments, the CLI resumes the last conversation for the current project with
  your last-used agent." The CLI help (`letta.js:538331`) also says "letta —
  Resume last conversation for this project".
- **Verified**: the description of agent-scoped skills in
  `docs:configuration/skills`: "always available regardless of where the agent
  is running or what project it is working on". This sentence assumes one agent
  moving between several projects.

### 1.2 How Letta remembers which agent to use in which directory

- **Verified**: per-project state is stored in
  `<cwd>/.letta/settings.local.json` as `lastAgent`, `lastSession`, and
  `sessionsByServer[serverKey] = {agentId, conversationId}` (path at
  `letta.js:5469`, setLocalLastSession at `letta.js:5670`). This file is added
  to `.gitignore` automatically (`letta.js:229538` ensureLocalSettingsIgnored).
  So the mapping is per developer and per device and is not shared through the
  repository.
- **Verified**: the global `~/.letta/settings.json` also has
  `sessionsByServer`. Its key is the **server (backend)**, not a directory. On
  the measured host the only key was `local:<home>/.letta/lc-local-backend`
  (checked read-only). `agents[]` holds per-agent settings (`agentId`,
  `baseUrl`, `memfs`, `systemPrompt*`, `pinned`) with no directory information
  (the pinned list at `letta.js:5725` is computed from
  `settings.agents[].pinned`). The old `pinnedAgents` key is on the deprecated
  list (`letta.js:6041`).
- **Verified**: the startup decision order (`letta.js:539291` onward,
  `resolveStartupTarget` at `letta.js:538249`) is (1) the local lastAgent of
  the current directory -> (2) the pinned agent if there is exactly one; a
  selection screen if there are two or more -> (3) the global last agent (API
  or cloud mode only) -> (4) on the local backend, the most recently active
  agent (`getLocalBackendStartupFallbackSession`, `letta.js:538561`) -> (5)
  create a default agent only when there is nothing at all.
- **Assumed**: so the default flow is "one user reuses one agent across several
  directories". A per-project agent exists only when the user picks or creates
  it with `--new-agent`, `/agents` or `--agent <id>`; once picked, it is
  remembered in that directory's local settings.
- **Verified**: the user's means of choosing are `letta --agent <id>`,
  `letta --new-agent`, `letta --resume` (selection UI), `/agents`, `/pin`,
  `/profile save` (help at `letta.js:538325~538397`,
  `docs:concepts/stateful-agents`). No feature named "project agents" was found
  anywhere in the bundle or the docs (Assumed: there is none).

### 1.3 MemFS layout for several codebases

- **Verified**: root Markdown goes into the system prompt on every turn.
  Subdirectories with a `MEMORY.md` are read when needed
  (`docs:concepts/memfs` §Memory structure,
  `LC/skills/maintaining-core-memory/SKILL.md:10-45`). Each root file becomes a
  `<file name>` block, and `<deferred-memory>` automatically gets the list of
  top-level directories.
- **Verified**: there are no fixed file names. "Nothing else is mandated — no
  filenames, no file count" (`LC/skills/initializing-memory/SKILL.md:33`). The
  blocks created by default are `MEMORY_BLOCK_LABELS = ["persona", "human"]`
  (`letta.js:101611`). A `project.mdx` template ("My understanding of this
  codebase") is in the bundle (`letta.js:100834`) but is not among the default
  labels.
- **Verified**: the only project folder convention is about naming. "Use the
  project's real name (`orchard/overview.md`, not `project/overview.md`)"
  (`initializing-memory/SKILL.md:39`). The example structure is `MEMORY.md`,
  `persona.md`, `human.md`, `orchard/{MEMORY.md, architecture.md, gotchas.md,
  history/}` (same file, `:65-78`). The root `MEMORY.md` is a "map to what is
  not already loaded" and holds links to the project folders (`:41-51`).
- **Verified**: `/init` asks about "other repositories you should know about"
  (`initializing-memory/SKILL.md:97`) and includes related repositories in the
  research (`:115`). It assumes one agent remembering several repositories.
  The local backend prompt uses `[[projects/letta-code]]` as a link example
  (`letta.js:99654`). That is the only place the `projects/<name>` form
  appears.
- **Verified**: MemFS does not distinguish "project memory" from "user
  memory". Instead it distinguishes **environment-owned** (the repository's
  `AGENTS.md`, `CLAUDE.md`, `.agents/skills`) from **agent-owned** (MemFS).
  "Don't duplicate context you can point to. `AGENTS.md`, `CLAUDE.md`,
  `README`, and repo skills belong to the environment"
  (`initializing-memory/SKILL.md:18`). There are three skill scopes: project
  (`.agents/skills`, "belong to the project not the agent"), computer
  (`~/.letta/skills`), and agent (MemFS) (`docs:configuration/skills`).
- **Verified**: size limits. The root total `maxCoreMemoryCharacters` defaults
  to 65,536 chars, 20,000 chars per file
  (`maintaining-core-memory/SKILL.md:48-54`). The root is recommended to stay
  under about 10% of the context (15 to 20k tokens)
  (`initializing-memory/SKILL.md:35`). Cloud storage is 5 MiB on Free and
  50 MiB on Pro, applied separately to each shared memory repository too
  (`docs:configuration/memory` §Cloud memory storage).

## 2. Sharing memory between agents

- **Verified**: the current means is the shared memory repository. "Each
  shared memory repository is a Git repository hosted in Letta Cloud and owned
  by your organization." Its purpose: "team conventions, product knowledge,
  research, plans, and documents that multiple agents maintain"
  (`docs:concepts/shared-memory`). A table there shows MemFS owned by "One
  agent" and a shared repository owned by "Your organization".
- **Verified**: how it works. When attached to an agent, it is cloned at
  `$MEMORY_DIR/../<repo-name>/`. The system prompt gets only the path and the
  top-level files; the content is read when needed. When the agent commits,
  the harness pushes after the turn, and on a conflict it retries a rebase
  once. A `skills/` folder in the repository is loaded as skills too
  (`docs:concepts/shared-memory`,
  `LC/skills/managing-shared-memory/SKILL.md:8-36`, prompt around
  `letta.js:99990`). The mount is a shallow checkout.
- **Verified**: cloud only. The docs: "Shared memory repositories require
  cloud-hosted agents. Local agents use their own MemFS and project files."
  (`docs:concepts/shared-memory`) The SDK needs `backend: "cloud"`
  (`docs:agent-sdk/repositories`). The code agrees: for local agents the
  `managing-shared-memory` skill is excluded (`letta.js:231546`
  LOCAL_AGENT_EXCLUDED_BUNDLED_SKILLS), and shared repository skill loading
  returns an empty result when `isLocalAgentId` or `!isLettaCloud()` (around
  `letta.js:231609`). The system prompt for the local backend
  (letta_local_memfs.md, `letta.js:99623`) has no Shared memory section at
  all.
- **Verified**: the legacy "shared memory blocks" (one block attached to
  several agents): "The legacy memory block API still supports this pattern,
  but users should migrate to shared memory repositories instead."
  (`docs:concepts/shared-memory`) The old tutorial URL
  (`/tutorials/shared-memory-blocks`) is now a 404. No block attach API call
  was found in the Letta Code bundle.
- **Verified**: the self-hosted alternative is a single sentence.
  "self-hosted deployments can share memory by pointing agents at their own git
  remote." (`docs:agent-sdk/memory`) No document with a concrete procedure was
  found (Assumed: undocumented).
- **Verified**: `letta.memoryRepository.url` (`/memory-repository set`) is an
  **optional backup remote** that mirrors MemFS `main` to one additional URL.
  "This is separate from the hosted MemFS origin." It pushes in the background
  after a commit, and a failure does not block the commit
  (`LC/skills/syncing-memory-filesystem/SKILL.md:146-165`). It is not a feature
  for several agents to share memory through this URL.
- **Verified**: the cross-agent memory guard. Access to another agent's memory
  directory is denied by default ("Permission denied by cross-agent memory
  guard", `letta.js:221403`). Only the parent process can turn it off with
  `--disable-memory-guard` (headless); a subagent cannot (`letta.js:121312`).
  Even with the same shared repository, another agent's mount is not
  accessible (`managing-shared-memory/SKILL.md:79`).
- **Verified**: there are collaboration paths that are not memory. An existing
  agent can be called as a subagent by `agent_id`, on the condition that "both
  agents must exist in the same Letta API org/project"
  (`docs:configuration/subagents`). Searching other agents' conversations
  (`letta messages search --all-agents`, README "search ... the conversations
  of other agents") is also possible.
- **Verified**: shared repositories have no permissions or partial projection.
  Issue #4267 "Scoped projections and governed write semantics for shared
  memory" (2026-09-07, open, external contributor) proposed distinguishing
  private, collaborative and governed writes. #4832 "Background conflict repair
  for attached shared-memory repositories" (2026-09-28, open) is open too.

## 3. Letta Cloud team features (docs as of November 2026)

- **Verified**: a paid team plan is required to add members to an organization
  (`docs:pricing`). "You can share agents across your team (and set
  permissions for access) ... and allow agents within your organization to
  communicate and collaborate."
- **Verified**: makeup. "Letta for teams adds shared organizations, member
  management, and centralized billing. Users in a team can shared agents and
  memory with each other. By default, agents that users create are private."
  (`docs:teams/quickstart`, typo as in the original) Optional extras are GitHub
  organization integration (agents on cloud computers access the
  organization's repositories) and per-agent Slack integration.
- **Verified**: roles. Admin manages the organization and can access every
  agent and conversation; Editor can access their own agents and those shared
  with the organization; Analyst can read and send messages. Invitees are
  Editors by default (`docs:teams/permissions`).
- **Verified**: the unit of sharing is the **agent**, set with "Share agent ->
  Anyone in your organization". "Each collaborator can then start and keep
  their own conversations with the shared agent." (`docs:teams/collaborators`)
  By default a conversation is visible only to its author. "Sharing an agent
  ... does not make your existing conversations visible to them."
  (`docs:teams/permissions`) Tool permissions are approved separately on each
  computer.
- **Assumed (strongly)**: memory is shared by all of an agent's conversations
  (`docs:concepts/stateful-agents` "Memory is shared across an agent's
  conversations"), so when several members use one shared agent, **all their
  conversations feed the same single MemFS**. The docs do not state this
  combination directly.
- **Verified**: the same usage appears in the blog. The Conversations post
  (2026-01-21) gives the example of one agent acting as an "institutional
  knowledge manager across an organization's Slack", with one conversation per
  thread. The same post says "if you want memory to be isolated, you should
  still continue to create separate agents"
  (https://www.letta.com/blog/conversations).
- **Verified**: there is no separate feature named "team memory". Team-level
  sharing is (1) shared agents and (2) organization-owned shared memory
  repositories (per the docs above; the example name of a shared repository is
  even `team-memory`). Per-repository access control is not in the docs.
- **Verified**: local (self-hosted) agents do not appear in the web app or on
  platform.letta.com (`docs:reference/terminology`). So the team features
  above do not apply to local agents. The self-hosted path for several clients
  to use the same agent is the App Server remote backend. "multiple clients can
  share the same agents" (`docs:self-hosting`).

## 4. The scope unit of reflection

- **Verified**: the target is one agent MemFS. "The primary agent's context
  ... is stored in $MEMORY_DIR" (reflection-v2.md,
  `letta.js:107101-107192`). Writes are restricted to inside `$MEMORY_DIR`.
- **Verified**: the input unit is the conversation. Transcripts and state live
  in `~/.letta/transcripts/<agent>/<conversation>/{transcript.jsonl,state.json}`
  (`getReflectionTranscriptPaths`, around `letta.js:459685`).
  `reflected_through_message_id` and `steps_since_last_successful_reflection`
  are also kept per conversation. Bundling several conversations uses the
  `multi_transcript_reflection_payload` manifest with the fields `agent_id`,
  `selection_policy` (recent / auto-selected / explicit-conversations), and
  `transcripts[]` (`letta.js:460206`). **There is no cwd or project field.**
- **Verified**: reflection settings layer per-agent values
  (`reflectionSettingsByAgent[agentId]`) over the global defaults, and the
  per-agent values of the project-local settings over those
  (`letta.js:236589`).
- **Verified**: the only place the prompt mentions projects is priority 3,
  "New facts worth retaining — project details, team info, environment
  details, architectural decisions". There is no guidance for several
  repositories or for splitting by codebase. For several transcripts it says
  "prefer patterns supported across sessions, resolve contradictions in favor
  of the latest evidence" (reflection-v2.md). Judgement about the project
  folder structure is left to the skills loaded alongside
  (maintaining-core-memory, maintaining-deferred-memory).
- **Verified**: one MemFS per agent. The local backend path is
  `~/.letta/lc-local-backend/memfs/<agent-id>/memory` (`docs:self-hosting`
  line 276); the cloud path is `~/.letta/agents/<id>/memory`. Additional
  repositories attach only as shared memory mounts (cloud only), and even those
  are outside reflection's write scope (`$MEMORY_DIR`).
- **Verified**: one agent handling several repositories is a design
  assumption (1.1, the `/init` "other repositories" in 1.3, the skills doc's
  "regardless of ... what project"). Repositories are told apart by folder
  names inside MemFS and by `AGENTS.md` on the repository side.

## 5. Options the docs and code suggest for a team with several projects

Pros and cons are limited to what can be read from the docs and code.

**(a) One agent per project (current mem-mem)**

- Basis (Verified): "Use separate agents when you want independent identities
  or memory" (stateful-agents). "if you want memory to be isolated ... create
  separate agents" (blog conversations). Letta Code's per-directory lastAgent
  memory (1.2) supports this usage.
- Consequences per the docs (Verified): memory, skills, persona and reflection
  settings are separated per agent. The guard blocks other agents' memory
  directories (section 2). The only current means of sharing common knowledge
  between projects (team conventions and so on) is the cloud shared
  repository.

**(b) One agent + per-project folders**

- Basis (Verified): Letta Code's default flow (reusing an existing agent even
  in a new directory, 1.2), `/init`'s "project's real name" folders and "other
  repositories" question (1.3), the prompt sentence that memory travels with
  the agent across environments, the organization-wide knowledge manager
  example (blog).
- Consequences per the docs (Verified): every project shares the root (core)
  budget of about 10% of the context and the 65,536-char limit. The storage
  limit (cloud 5/50 MiB) applies to one repository too. Reflection and
  conversations write to one MemFS with no project axis (section 4).
  Per-project isolation depends on folders and prompt rules, with no means of
  enforcement (Assumed).

**(c) An agent per member + shared memory**

- Basis (Verified): the purpose wording in the shared memory repository docs
  ("team conventions, product knowledge..."), the table separating personal
  MemFS from organization repositories.
- Consequences per the docs (Verified): cloud only, and disabled in the code on
  the local backend. No per-repository permissions or partial projection
  (#4267 open). Concurrent write conflicts are resolved by a person or an agent
  after a rebase retry (#4832 open). The content of a shared repository is not
  put into the system prompt ("not part of your in-context memory").

**(d) Other shapes in the docs**

- One shared agent + per-member conversations (Teams). Cloud only (section 3).
- The App Server controller pattern: "For teams or agent pools, model each
  teammate as a persistent agent plus one or more conversations." "Keep task
  state in the controller. Do not encode your full task database into agent
  memory." Product objects such as teams and projects are owned by the
  controller (`docs:self-hosting/app-server/integration-patterns`). Applies to
  both local and cloud.
- The hosted Letta MCP server (`https://api.letta.com/mcp`): MCP clients such as
  Claude Code or Cursor create Letta agents and send messages. Cloud only
  (`docs:platform/hosted-mcp`).
- Calling an existing agent as a subagent (same org/project condition).
  Searching other agents' conversations (section 2).
- Keeping repository-owned knowledge in `.agents/skills` (project-scoped) and
  `AGENTS.md` (1.3). No feature named "fleet" or "org agents" was found in the
  docs index (llms.txt) (Assumed: there is none).

## Implications for the mem-mem design (facts only)

- Letta defines "agent = unit of memory isolation". If per-project isolation is
  needed, the docs' wording is a separate agent (stateful-agents, blog
  conversations).
- Letta Code's default usage is one user's single agent moving between several
  directories. A per-project agent has to be picked or created explicitly, and
  the directory -> agent mapping lives only in a git-ignored personal file
  (`.letta/settings.local.json`).
- MemFS has no separate "project memory" layer. The `/init` example represents
  several codebases as real-project-name folders inside one MemFS, and the only
  fixed file names are `MEMORY.md` (required) and `persona.md` (recommended).
- Reflection runs on one agent MemFS with per-conversation input. The input
  manifest has no project or cwd axis.
- One MemFS per agent. On the local backend, the official means of attaching a
  second repository (shared memory mounts) is disabled. `/memory-repository` is
  a single one-way backup mirror.
- Sharing between agents (shared memory repositories), team sharing
  (organizations, shared agents, roles) and the hosted MCP are all Letta Cloud
  features. As self-hosted alternatives, the docs have one sentence about
  pointing at your "own git remote" and the path of several clients sharing an
  App Server.
- Shared repositories have no path or role based write permissions either (the
  request issue is open as of September 2026). Even after moving to the cloud,
  a permission layer would have to be built (Assumed).
- The core memory limit (65,536 chars, root about 10% of the context) and the
  storage limit apply per MemFS. How many agents the memory is split into
  changes the share each project can use.
- The cross-agent guard blocks other agents' MemFS directories by default
  (subagents cannot lift it). Letting project agents read each other's memory
  directly would have to take this guard into account.
