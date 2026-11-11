---
name: memmem-init
description: Initialize this project's shared team memory (mem-mem) from the codebase and, with consent, past Claude Code / Codex sessions, or add your own past sessions to a memory a teammate already initialized. Use only when the user invokes $memmem-init or explicitly asks to initialize, bootstrap, or seed the team memory ("메모리 초기화", "팀 메모리 초기화", "init team memory"); not for ordinary questions about the memory.
---

# Initialize team memory (mem-mem)

The memory server builds the team memory; this skill only collects answers
and runs `memmem init`, which pushes a request (and, only with consent,
redacted copies of this project's past sessions) to the team's transcripts
repo. Run every command from the project directory.

This skill is installed once per computer (user level), so it is listed in
every project; step 0 makes it do nothing in a project without mem-mem.

0. First check that this project uses mem-mem: look for `.memmem/config.json`
   in the current directory and its parents, up to the repository root (the
   folder that contains `.git`). In a linked git worktree (its `.git` is a
   file) also look in the main checkout: the parent of the folder that
   `git rev-parse --path-format=absolute --git-common-dir` prints, which
   memmem uses for every worktree. If there is none, tell the user in one or two
   lines that this project is not set up for mem-mem (someone runs
   `memmem setup` in it first) and stop: run no other command, and create or
   change no file.

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
   `memmem init --answer "<text>"` instead. The command fetches the
   transcripts repo; the default Codex sandbox may ask for network approval.

2. Ask the questions below. If a choice / user-input tool is available, use
   it with one call; otherwise ask them in ONE plain-text message (in the
   user's language) with the defaults shown, and wait for the reply. Don't ask
   anything you can learn from files or git.

   **Not initialized yet** (`initialized` is false), four questions:
   - **Research depth**: `standard` (default; reads the docs, manifests, entry
     points and recent history) or `deep` (more areas, git-history
     conventions, end-to-end tracing; slower and costs more).
   - **Other repositories** the memory should know about (comma separated
     `org/repo`; default none).
   - **Communication style** you want from coding agents (free text; default
     no preference).
   - **Past sessions**: only if `localSessions.total` > 0. Name the tools and
     counts. Say plainly that approving uploads redacted copies of those
     sessions to the team's private transcripts repo, where everyone with
     access can read them, and that the memory server's read-only subagents
     will read them. Redaction is best-effort. Default: no.

   Then run, quoting the free-text answers (use `none` / empty when not given):

   ```bash
   memmem init --yes --depth <standard|deep> --repos "<a,b>" --style "<text>" --history <yes|no>
   ```

   **Already initialized** (`initialized` is true): first tell the user in one
   line who initialized it, when, and at which depth (`initializedBy`,
   `initializedAt`, `depth`), and whether their sessions are already in it
   (`myContribution.state`). Then ask:
   - **Add your past sessions?** Only if `localSessions.total` > 0: "Add your
     N past sessions to the team memory?" with the same plain warning as
     above. Default: yes, but only the user's explicit reply counts.
   - **Communication style** you want from coding agents (one line, or none).
   - **Re-run the code research as deep?** Only if `depth` is `standard`.
     Default no. Say that it redoes the whole code research for the team and
     costs noticeably more tokens and time.
   - **Other repositories** to add (optional).

   Then run one of (quote free text; omit `--repos` when none):

   ```bash
   # sessions yes, no deepening: a session contribution
   memmem init --yes --history-only --history yes --style "<text>" --repos "<a,b>"
   # sessions no, no deepening: only style / repos
   memmem init --yes --history no --style "<text>" --repos "<a,b>"
   # deepen: the server redoes the research as deep with everyone's sessions
   memmem init --yes --depth deep --history <yes|no> --style "<text>" --repos "<a,b>"
   ```

   `memmem init --yes --reinit ...` forces a full re-initialization; suggest
   it only when the user asks for a rebuild.

3. Every `memmem init` above commits and pushes to the transcripts repo. The
   default Codex sandbox blocks network access, so expect an approval prompt
   for this step; approve it to send the request. Only an explicit "yes" to
   the sessions question uploads them.

4. Tell the user in two or three lines: the request was sent, the memory
   server commits to the memory repo URL the command printed, and they can
   follow progress with `memmem status` (the next session start also says when
   it finished). If the server later asks a question, `memmem status` shows
   it; answer with `memmem init --answer "<text>"`. If the push failed, show
   the error line.

---
The questions are adapted from the `initializing-memory` skill of Letta
Code (https://github.com/letta-ai/letta-code), licensed under the Apache
License 2.0.
