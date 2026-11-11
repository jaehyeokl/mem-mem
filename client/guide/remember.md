# Save a note to the team memory (mem-mem)

Follow this when the user says "기억해", "기억해 둬", "팀 메모리에 남겨",
"remember this", or otherwise asks to record a decision, fact, or convention
for the team. Notes go to the team's transcripts repo (`inbox/<member>/`); the
memory server reads them and updates the team memory.

The team memory clone at `.memmem/memory/` in this project is read-only for
you: read it freely, but never create, edit, or delete files there; the memory
server maintains it. It is hidden and git-ignored, so read files by the paths
in the injected index instead of relying on search (`rg` sees it only with
`--hidden --no-ignore`). Do not edit anything else under `.memmem/` either.

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

4. Tell the user in one line that the note was saved. If the command says the
   note was queued in `.memmem/outbox/` (a sandbox kept it from the data
   folder), say it uploads at the next sync and do not retry. If it says the
   folder is not a team project, tell the user to run `memmem setup` in the
   project; if the push failed, say the note was saved locally and will be
   pushed on the next sync.
5. If the command fails in any other way (for example `NOT saved`, or a
   read-only file system), tell the user plainly that the note was NOT saved,
   quote the reason from the output, and give them the summary so they can save
   it later. Never say it was saved unless the command printed a saved or
   queued path.
