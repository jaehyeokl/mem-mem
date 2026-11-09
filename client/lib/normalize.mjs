// Transcript reading (incl. .zst), normalization via @letta-ai/trajectory, and
// the transcripts-repo layout shared with the server worker.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeTranscript, NORMALIZER_VERSION } from "@letta-ai/trajectory";
import { safeName } from "./util.mjs";

export { NORMALIZER_VERSION };

/** Read a transcript file; `.zst` files are decompressed with the `zstd` CLI. */
export function readTranscript(file) {
  if (file.endsWith(".zst")) {
    const r = spawnSync("zstd", ["-dc", "--", file], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
    if (r.error) throw new Error(`zstd not available (needed for ${path.basename(file)}): ${r.error.message}`);
    if (r.status !== 0) throw new Error(`zstd failed: ${r.stderr}`);
    return r.stdout;
  }
  return fs.readFileSync(file, "utf8");
}

/**
 * Locate the transcript. Hooks may report a path that is missing (Codex may
 * have compressed it to .jsonl.zst) or no path at all (Codex: "if any"); fall
 * back to searching the Codex sessions tree by session id.
 */
export function resolveTranscript(file, { tool, sessionId } = {}) {
  if (file) {
    if (fs.existsSync(file)) return file;
    if (fs.existsSync(`${file}.zst`)) return `${file}.zst`;
  }
  if (tool === "codex" && sessionId) {
    const base = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
    const hit = findBySuffix(base, sessionId, 4);
    if (hit) return hit;
  }
  return null;
}

function findBySuffix(dir, id, depth) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  entries.sort((a, b) => b.name.localeCompare(a.name)); // newest date dirs first
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.includes(id) && /\.jsonl(\.zst)?$/.test(e.name)) return p;
    if (e.isDirectory() && depth > 0) {
      const r = findBySuffix(p, id, depth - 1);
      if (r) return r;
    }
  }
  return null;
}

export function normalize(tool, raw) {
  return normalizeTranscript({ source: tool, transcript: raw });
}

/**
 * Session start (ISO): earliest top-level `timestamp` among raw JSONL lines
 * (Claude Code rows, Codex `session_meta`/rollout lines), falling back to the
 * earliest normalized record timestamp. Stable across re-syncs of a growing file.
 */
export function startedAtOf(records, raw = "") {
  let min = null;
  const consider = (v) => {
    if (typeof v !== "string") return;
    const t = Date.parse(v);
    if (!Number.isNaN(t) && (min === null || t < min)) min = t;
  };
  for (const line of raw.split("\n")) {
    if (!line.includes('"timestamp"')) continue;
    try { consider(JSON.parse(line).timestamp); } catch { /* ignore bad lines */ }
  }
  if (min === null) for (const r of records) consider(r.timestamp);
  return min === null ? null : new Date(min).toISOString();
}

/** 2026-11-06T01:23:45.678Z -> 2026-11-06T01-23-45Z (filename-safe). */
export function fileStamp(iso) {
  return iso.replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

/**
 * Layout (keep in sync with server/worker):
 *   trajectories/<YYYY-MM>/<member>/<tool>/<startedAt>_<sessionId>.json
 */
export function trajectoryRelPath({ member, tool, sessionId, startedAt }) {
  return path.posix.join(
    "trajectories",
    startedAt.slice(0, 7),
    safeName(member),
    safeName(tool),
    `${fileStamp(startedAt)}_${safeName(sessionId)}.json`,
  );
}

/** Session id from a transcript file name (Claude: <id>.jsonl, Codex: rollout-<ts>-<uuid>.jsonl). */
export function sessionIdFromPath(file) {
  const b = path.basename(file).replace(/\.jsonl(\.zst)?$/, "");
  const m = b.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return m ? m[0] : b;
}
