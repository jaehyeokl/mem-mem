# {{PROJECT_NAME}} transcripts

The mem-mem ingest repository. It holds **only normalized copies** of team members' sessions. The raw JSONL stays on each
member's machine (Claude Code `~/.claude/projects`, Codex `~/.codex/sessions`).

Team memory itself lives in [{{MEMORY_REPO}}](https://github.com/{{MEMORY_REPO}}). This repo is the input side.

| Path | Written by | Contents |
|---|---|---|
| `project.json` | `memmem-server project add` / `project set-language` | Project facts for clients: `project`, memory `language` (`en`/`ko`), `layoutVersion`, `createdAt`. `memmem setup` reads the language from here |
| `trajectories/<YYYY-MM>/<member>/<tool>/<startedAt>_<sessionId>.json` | client hooks (`Stop`/`SessionEnd`) | Normalized copy in the `@letta-ai/trajectory` v1 format. The same session overwrites the same file. |
| `inbox/<member>/<YYYY-MM-DD>-<slug>.md` | `/remember` | Notes a member explicitly asked to keep |
| `ingest/log.jsonl` | server worker | Processing log: file → agent conversation ID → reflection commit SHA → time |
| `members/<handle>.json` | `memmem setup` | Member registration: GitHub login handle, display name, that member's git authors (name, email), old handles (aliases). No secrets |
| `bootstrap/<member>/…`, `bootstrap/status.json` | `memmem init` / server worker | Init requests and the past sessions members approved / init progress |

Rules

- Secret-like strings (tokens, keys, credential URLs) are replaced with `[REDACTED:<type>]` on the teammate's machine before a file is pushed. Redaction is best-effort; keep this repo private.
- The client skips sessions larger than the file size limit.
- Do not edit the memory repository directly. If something needs fixing, open a PR on the memory repository.
- Retention policy: [RETENTION.md](RETENTION.md).
