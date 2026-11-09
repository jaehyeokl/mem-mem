## Team memory (mem-mem)

This project uses shared team memory. Its clone is at `.memmem/memory/` inside
the project (the session-start hook names the absolute path). At session start
the hook injects an index of it: the root `MEMORY.md`, the root core files
(`project.md`, ...), and each folder's `MEMORY.md` (decisions in `decisions/`,
changes in `changes/`, domain context in `context/`, ownership and conventions
in `people/`). The individual files are not injected; when one is relevant,
read it there directly. The clone is hidden and git-ignored, so read files by
the paths in the index instead of relying on search (`rg` sees it only with
`--hidden --no-ignore`). Never edit files in `.memmem/memory/`; the memory
server maintains it.

When the user says "기억해", "remember this", or asks to record something for
the team, write a short self-contained summary (no secrets) and run, from the
project directory:

```bash
memmem remember - <<'EOF'
<summary>
EOF
```

Then tell the user in one line that the note was saved.

To initialize the team memory from this codebase, or to add your own past
sessions once a teammate has initialized it, the user runs `$memmem-init` (or
`/skills`); follow that skill (it starts with `memmem init --state`). If the
session-start context opens with a line about the memory server waiting for
an answer, ask the user and reply with `memmem init --answer "<text>"`.
