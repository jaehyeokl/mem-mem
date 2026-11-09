---
name: memmem-init
description: Initialize this project's shared team memory (mem-mem) from the codebase and, with consent, past Claude Code / Codex sessions, or add your own past sessions to a memory a teammate already initialized. Use when the user runs /memmem-init or asks to initialize, bootstrap, or seed the team memory ("메모리 초기화", "팀 메모리 초기화", "init team memory").
---

# Initialize team memory (mem-mem)

The memory server builds the team memory; this skill only collects answers
and runs `memmem init`, which pushes a request (and, only with consent,
redacted copies of this project's past sessions) to the team's transcripts
repo. Run every command from the project directory.

1. Read the project's init state. Nothing is uploaded by this command:

   ```bash
   memmem init --state
   ```

   It prints JSON: `projectInit.initialized` (has a teammate already
   initialized the memory), `projectInit.state`, `depth`, `initializedBy`,
   `initializedAt`, `myContribution.state` (`reflected`, `not_reflected`,
   `requested`, ...), and `localSessions` (past sessions of this project on
   this machine per tool, size, secret-like values that would be redacted). If
   it says the folder is not a team project, tell the user to run
   `memmem setup` first and stop. If `projectInit.state` is
   `waiting_for_answer`, show `projectInit.question` and offer to answer with
   `memmem init --answer "<text>"` instead.

2. **Not initialized yet** (`initialized` is false): ask the four questions in
   ONE `AskUserQuestion` call (in the user's language). Don't ask anything you
   can learn from files or git.
   - **Research depth**: `standard` (default; reads the docs, manifests, entry
     points and recent history) or `deep` (more areas, git-history
     conventions, end-to-end tracing; slower and costs more).
   - **Other repositories** the memory should know about (free text, comma
     separated `org/repo`; "none" is fine).
   - **Communication style** you want from coding agents (free text, e.g.
     "terse, Korean, explain trade-offs"; "no preference" is fine).
   - **Past sessions**: only if `localSessions.total` > 0. Name the tools and
     counts. Say plainly that approving uploads redacted copies of those
     sessions to the team's private transcripts repo, where everyone with
     access can read them, and that the memory server's read-only subagents
     will read them. Redaction is best-effort. Options: "Yes, upload them" /
     "No" (default No).

   Then run, quoting the free-text answers (use `none` / empty when not given):

   ```bash
   memmem init --yes --depth <standard|deep> --repos "<a,b>" --style "<text>" --history <yes|no>
   ```

3. **Already initialized** (`initialized` is true): first tell the user in one
   line who initialized it, when, and at which depth (`initializedBy`,
   `initializedAt`, `depth`), and whether their sessions are already in it
   (`myContribution.state`). Then ask in ONE `AskUserQuestion` call:
   - **Add your past sessions?** Only if `localSessions.total` > 0: "Add your
     N past sessions (tools and counts) to the team memory?" with the same
     plain warning as above (redacted copies go to the private transcripts
     repo; everyone with access and the server's read-only subagents read
     them). Options: "Yes, add them" (default) / "No". The default only
     preselects the option; only the user's explicit choice counts.
   - **Communication style** you want from coding agents (one line, or none).
   - **Re-run the code research as deep?** Only if `depth` is `standard`.
     Default No. Say that it redoes the whole code research for the team and
     costs noticeably more tokens and time.
   - **Other repositories** to add (optional; comma separated `org/repo`).

   Then run one of (quote free text; omit `--repos` when none):

   ```bash
   # sessions yes, no deepening: a session contribution
   memmem init --yes --history-only --history yes --style "<text>" --repos "<a,b>"
   # sessions no, no deepening: only style / repos
   memmem init --yes --history no --style "<text>" --repos "<a,b>"
   # deepen: the server redoes the research as deep with everyone's sessions
   memmem init --yes --depth deep --history <yes|no> --style "<text>" --repos "<a,b>"
   ```

   If `myContribution.state` is already `reflected` and the user only wants a
   full rebuild, `memmem init --yes --reinit ...` asks the server to
   re-initialize anyway; suggest it only when the user asks for that.

4. Every `memmem init` above commits and pushes to the transcripts repo, so
   the Bash tool may ask for permission or network approval; that is
   expected. Wait for the answers first; a finished question call is not
   consent, and only an explicit "yes" to the sessions question uploads them.

5. Tell the user in two or three lines: the request was sent, the memory
   server commits to the memory repo URL the command printed, and they can
   follow progress with `memmem status` (the next session start also says when
   it finished). If the server later asks a question, `memmem status` shows
   it; answer with `memmem init --answer "<text>"`. If the push failed, show
   the error line.

---
The questions are adapted from the `initializing-memory` skill of Letta
Code (https://github.com/letta-ai/letta-code), licensed under the Apache
License 2.0.
