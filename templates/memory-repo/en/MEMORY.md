# {{PROJECT_NAME}} team memory

This repository is the shared team memory of the {{PROJECT_NAME}} project. The root `.md` files are core memory; read the directories below directly when you need them.

- [project.md](project.md): what the project is, current goals, key rules (keep it short)
- [decisions/](decisions/MEMORY.md): decision records. Decision, reason, alternatives, source sessions, status
- [changes/](changes/MEMORY.md): summaries of major changes (what changed, when, and why)
- [context/](context/MEMORY.md): domain knowledge, external systems, integration context
- [people/](people/MEMORY.md): areas of ownership and each member's working conventions

## Rules for reflection

- Write one decision per file in `decisions/YYYY-MM-DD-<slug>.md`. Body sections are `## Decision`, `## Reason`, `## Alternatives`, `## Source sessions`, `## Status`. Under source sessions, record the member/tool/session values from the ingest header.
- When a decision changes, do not delete the old file. Change the old file's status to `Status: superseded by <new file>` and create a new file.
- Keep the root light. Only `project.md`, `persona.md` and `human.md` live at the root. Put new content in the closest of the directories above.
- Every file except `MEMORY.md` must have `name` and `description` frontmatter (use no other keys).
- When you create a file, link it with a one-line description in the closest `MEMORY.md` list.
- Never store secrets (tokens, passwords, API keys, personal access details). If needed, record only "where it is".
