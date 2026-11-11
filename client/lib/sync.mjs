// `memmem sync`: transcript -> normalized + redacted JSON -> transcripts repo.
import fs from "node:fs";
import path from "node:path";
import { NORMALIZER_VERSION, normalize, readTranscript, resolveTranscript, sessionIdFromPath, startedAtOf, trajectoryRelPath } from "./normalize.mjs";
import { flushOutbox } from "./remember.mjs";
import { redactDeep } from "./secrets.mjs";
import { commitAndPush, ensureClone, findConfig, git, LAYOUT_VERSION, log, preparePull, projectPaths, repoUrl, safeName, sleepSync, withLock } from "./util.mjs";

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Pure part of sync: build the document that is written to the repo.
 * Returns { skip?: reason, relPath, doc, json, redactions }.
 */
export function buildTrajectoryDoc({ raw, tool, sessionId, member, project, cwd, maxBytes = DEFAULT_MAX_BYTES }) {
  let records, diagnostics;
  try {
    ({ records, diagnostics } = normalize(tool, raw));
  } catch (e) {
    if (e?.code === "missing_user_records") return { skip: "no user records" };
    throw e;
  }
  const conversational = records.filter((r) => r.role === "user" || r.role === "assistant");
  if (conversational.length === 0) return { skip: "no user/assistant records" };
  const startedAt = startedAtOf(records, raw) || new Date().toISOString();
  const metaRec = records.find((r) => r.role === "meta") || {};
  const red = redactDeep(records);
  const doc = {
    records: red.value,
    meta: {
      member,
      tool,
      sessionId,
      startedAt,
      cwd: cwd || metaRec.cwd || null,
      project,
      normalizer: `@letta-ai/trajectory@${NORMALIZER_VERSION}`,
      diagnostics: diagnostics.length,
      redactions: red.total,
      redactionsByType: red.counts,
      layoutVersion: LAYOUT_VERSION,
    },
  };
  const json = JSON.stringify(doc, null, 1) + "\n";
  const relPath = trajectoryRelPath({ member, tool, sessionId, startedAt });
  const bytes = Buffer.byteLength(json);
  if (bytes > maxBytes) return { skip: `normalized size ${bytes} B exceeds limit ${maxBytes} B`, relPath };
  return { relPath, doc, json, redactions: red.total };
}

/**
 * Earlier files for the same session at a different path (idempotent
 * overwrite); removed unless `dryRun`.
 */
function removeStale(repoDir, member, tool, sessionId, keepRel, { dryRun = false } = {}) {
  const removed = [];
  const root = path.join(repoDir, "trajectories");
  let months = [];
  try { months = fs.readdirSync(root); } catch { return removed; }
  for (const m of months) {
    const dir = path.join(root, m, member, tool);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const rel = path.posix.join("trajectories", m, member, tool, f);
      if (f.endsWith(`_${sessionId}.json`) && rel !== keepRel) {
        if (!dryRun) fs.rmSync(path.join(dir, f));
        removed.push(rel);
      }
    }
  }
  return removed;
}

/** True when `abs` already has `json` and HEAD has no commits that origin lacks. */
function isUnchanged(repoDir, abs, json) {
  let cur;
  try { cur = fs.readFileSync(abs, "utf8"); } catch { return false; }
  if (cur !== json) return false;
  const branch = git(["symbolic-ref", "--short", "HEAD"], { cwd: repoDir }).stdout || "main";
  const ahead = git(["rev-list", "--count", `origin/${branch}..HEAD`], { cwd: repoDir });
  if (!ahead.ok || ahead.stdout !== "0") return false;
  return git(["status", "--porcelain", "--", path.relative(repoDir, abs)], { cwd: repoDir }).stdout === "";
}

export function runSync(args) {
  const tool = args.tool === "claude" ? "claude-code" : args.tool || "claude-code";
  const found = findConfig(args.cwd || process.cwd());
  if (!found) {
    process.stderr.write("memmem sync: no .memmem/config.json found (run `memmem setup`)\n");
    return 1;
  }
  const paths = projectPaths(found.config, found.dir);
  const L = (m) => log(paths, "sync", m);
  const delay = Number(args.delayMs || 0);
  if (delay > 0) sleepSync(delay);
  // Notes `memmem remember` queued in .memmem/outbox/ while the data folder was read-only.
  try { flushOutbox(found.dir, paths, found.config); } catch (e) { L(`error: outbox: ${e.message}`); }

  const file = resolveTranscript(args.transcript, { tool, sessionId: args.session });
  if (!file) { L(`skip: transcript not found (path=${args.transcript || "-"} session=${args.session || "-"})`); return 1; }
  const sessionId = safeName(args.session || sessionIdFromPath(file));
  const maxBytes = Number(args.maxBytes || process.env.MEMMEM_MAX_BYTES || DEFAULT_MAX_BYTES);

  let built;
  try {
    const raw = readTranscript(file);
    built = buildTrajectoryDoc({ raw, tool, sessionId, member: paths.member, project: paths.project, cwd: args.cwd, maxBytes });
  } catch (e) {
    L(`error: normalize ${tool} ${sessionId}: ${e.message}`);
    return 1;
  }
  if (built.skip) { L(`skip ${tool} ${sessionId}: ${built.skip}`); return 0; }

  const cl = ensureClone(repoUrl(found.config.transcriptsRepo), paths.transcripts);
  if (!cl.ok) { L(`error: clone transcripts repo: ${cl.error}`); return 1; }

  try {
    return withLock(paths.lock, () => {
      const abs = path.join(paths.transcripts, built.relPath);
      // Checkpoints re-sync a growing session often: when the clone already
      // holds this exact JSON, nothing is stale, and nothing is waiting to be
      // pushed, stop here without touching the network.
      if (isUnchanged(paths.transcripts, abs, built.json) && removeStale(paths.transcripts, paths.member, tool, sessionId, built.relPath, { dryRun: true }).length === 0) {
        L(`unchanged ${built.relPath}`);
        return 0;
      }
      preparePull(paths.transcripts, paths.member);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, built.json);
      const removed = removeStale(paths.transcripts, paths.member, tool, sessionId, built.relPath);
      const res = commitAndPush(paths.transcripts, [built.relPath, ...removed],
        `trajectory: ${paths.member}/${tool}/${sessionId}`, { member: paths.member });
      if (!res.ok) { L(`error: ${built.relPath}: ${res.error}`); return 1; }
      L(`ok ${built.relPath} committed=${res.committed} records=${built.doc.records.length} redactions=${built.redactions}${removed.length ? ` removed=${removed.length}` : ""}`);
      return 0;
    });
  } catch (e) {
    L(`error: ${e.message}`);
    return 1;
  }
}
