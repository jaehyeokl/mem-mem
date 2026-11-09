---
name: remember
description: Save a note to this project's shared team memory (mem-mem). Use when the user says "기억해", "기억해 둬", "팀 메모리에 남겨", "remember this", or otherwise asks to record a decision, fact, or convention for the team.
---

# Remember (team memory)

The user wants something recorded in the team's shared memory. Notes go to the
team's transcripts repo (`inbox/<member>/`); the memory server reads them and
updates the team memory. The team memory clone is at `.memmem/memory/` inside
the project: read it freely, but never edit files there directly. It is hidden
and git-ignored, so read files by the paths in the injected index instead of
relying on search (`rg` sees it only with `--hidden --no-ignore`).

1. Write a short, self-contained summary (1-5 sentences) in the user's language:
   what was decided or learned, why, and any file paths, issue numbers, or
   names needed to find it again. Use the conversation for context, but write it
   so a teammate who did not see this session understands it.
2. Never include secrets (tokens, passwords, API keys, private URLs with
   credentials). Say where a secret lives instead of its value.
3. Run it from the project directory with a quoted heredoc so quoting is safe:

   ```bash
   memmem remember - <<'EOF'
   <summary>
   EOF
   ```

4. The command prints the path of the saved note. Tell the user it was saved
   (one line). If it says the folder is not a team project, tell the user to run
   `memmem setup` in the project; if the push failed, say the note was saved
   locally and will be pushed on the next sync.
