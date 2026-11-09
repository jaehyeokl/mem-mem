// Past-session discovery for `memmem init`: find this machine's Claude Code and
// Codex sessions whose recorded cwd is the project folder (or below it),
// normalize and redact them, and describe them in a manifest with the fields of
// Letta Code's `letta trajectories export` manifest (version, generatedAt,
// outDir, sources{discovered, exported}, errors[], sessions[]), so the server
// can lay them out where Letta's /init expects an export.
// The file naming and per-session stats follow Letta Code's export command
// (Apache-2.0, https://github.com/letta-ai/letta-code).
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listTrajectories } from "@letta-ai/trajectory";
import { normalize, readTranscript } from "./normalize.mjs";
import { redactDeep } from "./secrets.mjs";

export const HISTORY_SOURCES = ["claude-code", "codex"];
const FIRST_PROMPT_MAX_CHARS = 200;
const HEAD_BYTES = 256 * 1024;

/**
 * Store roots. `@letta-ai/trajectory` only knows `~/.claude/projects` and
 * `~/.codex/sessions`, so we pass roots explicitly and honour
 * CLAUDE_CONFIG_DIR and CODEX_HOME.
 */
export function storeRoots({ env = process.env, homedir = os.homedir() } = {}) {
  return {
    "claude-code": path.join(env.CLAUDE_CONFIG_DIR || path.join(homedir, ".claude"), "projects"),
    codex: path.join(env.CODEX_HOME || path.join(homedir, ".codex"), "sessions"),
  };
}

async function listAll(source, root, list) {
  const items = [];
  let cursor;
  do {
    const page = await list({ source, root, cursor, limit: 1000 });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

/** Recorded cwd from the first lines of a transcript (Claude rows carry `cwd`; Codex `session_meta`/`turn_context` payloads do). */
export function headCwd(file) {
  let head = "";
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    fs.closeSync(fd);
    head = buf.subarray(0, n).toString("utf8");
  } catch { return null; }
  for (const line of head.split("\n").slice(0, 400)) {
    if (!line.includes('"cwd"')) continue;
    try {
      const o = JSON.parse(line);
      const c = o.cwd ?? o.payload?.cwd;
      if (typeof c === "string" && c) return c;
    } catch { /* partial last line */ }
  }
  return null;
}

function real(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }

/** True when `cwd` is `projectDir` or inside it (a directory boundary, unlike Letta's prefix match). */
export function insideProject(cwd, projectDir) {
  if (!cwd) return false;
  const a = real(cwd);
  const b = real(projectDir);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

export function sessionHash(source, nativeId) {
  return createHash("sha256").update(`${source}:${nativeId}`).digest("hex").slice(0, 10);
}

export function fileTimestamp(startedAt) {
  return startedAt ? startedAt.slice(0, 19).replace(/:/g, "-") : "unknown-date";
}

export function collectStats(records) {
  const s = { userMessages: 0, assistantMessages: 0, toolCalls: 0, reasoningRecords: 0 };
  for (const r of records) {
    if (r.role === "meta") { s.project = r.cwd; s.model = r.model; continue; }
    if (!s.startedAt && r.timestamp) s.startedAt = r.timestamp;
    if (r.timestamp) s.endedAt = r.timestamp;
    if (r.role === "user") {
      s.userMessages += 1;
      if (s.firstUserPrompt === undefined) s.firstUserPrompt = String(r.content ?? "").slice(0, FIRST_PROMPT_MAX_CHARS);
    } else if (r.role === "assistant") {
      s.assistantMessages += 1;
      if (Array.isArray(r.tool_calls)) s.toolCalls += r.tool_calls.length;
    } else if (r.role === "reasoning") s.reasoningRecords += 1;
  }
  return s;
}

const tildify = (p, home) => (home && (p === home || p.startsWith(home + path.sep)) ? "~" + p.slice(home.length) : p);

/**
 * Discover, normalize, and redact this project's sessions. Nothing is written.
 * Returns { sessions: [{source, id, sessionId, file, sourcePath, ...stats,
 * records, bytes, diagnostics, redactions, json}], errors: [...], sources }.
 */
export async function discoverSessions({ projectDir, roots = storeRoots(), list = listTrajectories, maxBytes = 5 * 1024 * 1024, homedir = os.homedir() } = {}) {
  const sessions = [];
  const errors = [];
  const sources = {};
  const used = new Set();
  for (const source of HISTORY_SOURCES) {
    const counts = (sources[source] = { discovered: 0, exported: 0 });
    let items = [];
    try { items = await listAll(source, roots[source], list); } catch (e) { errors.push({ source, error: e.message }); continue; }
    for (const item of items) {
      if (!insideProject(headCwd(item.path), projectDir)) continue;
      counts.discovered += 1;
      const sourcePath = tildify(item.path, homedir);
      try {
        const { records, diagnostics } = normalize(source, readTranscript(item.path));
        const stats = collectStats(records);
        if (!stats.userMessages || !stats.assistantMessages) { errors.push({ source, sourcePath, error: "no user/assistant records" }); continue; }
        const red = redactDeep(records);
        const json = JSON.stringify(red.value);
        const bytes = Buffer.byteLength(json);
        if (bytes > maxBytes) { errors.push({ source, sourcePath, error: `normalized size ${bytes} B exceeds limit ${maxBytes} B` }); continue; }
        const sessionId = sessionHash(source, item.id);
        const base = `${fileTimestamp(stats.startedAt)}_${sessionId}`;
        let file = path.posix.join(source, `${base}.json`);
        for (let n = 2; used.has(file); n++) file = path.posix.join(source, `${base}-${n}.json`);
        used.add(file);
        const redactedStats = collectStats(red.value);
        counts.exported += 1;
        sessions.push({
          source, id: item.id, sessionId, file, sourcePath,
          ...stats, firstUserPrompt: redactedStats.firstUserPrompt,
          records: records.length, bytes, diagnostics: diagnostics.length,
          redactions: red.total, redactionsByType: red.counts, json,
        });
      } catch (e) {
        errors.push({ source, sourcePath, error: e?.code === "missing_user_records" ? "no user records" : e.message });
      }
    }
  }
  sessions.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  return { sessions, errors, sources };
}

/** Letta-compatible manifest (without the session bodies). */
export function buildManifest({ outDir, discovered, member, now = new Date() }) {
  return {
    version: 1,
    generatedAt: now.toISOString(),
    outDir,
    member,
    sources: discovered.sources,
    errors: discovered.errors,
    sessions: discovered.sessions.map(({ json, ...s }) => s),
  };
}

/** One-line-per-tool summary numbers for --dry-run and the consent question. */
export function summarize(discovered) {
  const byTool = {};
  for (const s of discovered.sessions) {
    const t = (byTool[s.source] ||= { sessions: 0, bytes: 0, redactions: 0 });
    t.sessions += 1; t.bytes += s.bytes; t.redactions += s.redactions;
  }
  const total = Object.values(byTool).reduce((a, t) => ({ sessions: a.sessions + t.sessions, bytes: a.bytes + t.bytes, redactions: a.redactions + t.redactions }), { sessions: 0, bytes: 0, redactions: 0 });
  return { byTool, total, skipped: discovered.errors.length };
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
