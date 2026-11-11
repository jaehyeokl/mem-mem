// Hook entry points: session-start (inject memory), session-end (detach sync),
// and checkpoint (Stop / PreCompact: detach a sync while a long session is open).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildContext, maxCharsFromEnv } from "./context.mjs";
import { resolveTranscript, sessionIdFromPath } from "./normalize.mjs";
import { MEMMEM_BIN, selfInvocation } from "./runtime.mjs";
import { detectTool, ensureClone, findConfig, git, GUIDE_FILE, languageOf, log, modeOf, projectPaths, readLocal, readLocalStrict, readStdinJson, repoUrl, resolveOnPath, safeName, writeLocal } from "./util.mjs";

export { MEMMEM_BIN };

/**
 * PATH safety net: the absolute-path copies of the hooks in
 * `.claude/settings.local.json` carry `--fallback`. Claude Code runs hooks from
 * every settings file, so when `memmem` resolves on PATH the shared hook does
 * the work and the fallback copy exits silently; when it does not, the shared
 * hook fails ("command not found", non-blocking) and the fallback does the work.
 */
export function fallbackShouldSkip(args, { env = process.env, platform = process.platform } = {}) {
  return Boolean(args.fallback) && resolveOnPath("memmem", { env, platform }) !== null;
}

/**
 * The activation rule, shared by every hook entry point. A hook does work only
 * when (1) `.memmem/config.json` is found walking up from the hook's cwd to the
 * first `.git` boundary; a linked git worktree uses its main checkout's
 * `.memmem/` (see findConfig), (2) a member is
 * recorded (local.json or MEMMEM_MEMBER), and (3) the mode matches: user-level
 * hook commands carry `--user` and act only in a `mode: "user"` checkout;
 * project-level commands act only in the others. Invalid or unreadable
 * config/local files, MEMMEM_DISABLE=1, and a --fallback copy with memmem on
 * PATH also give null: the caller exits 0 having printed and created nothing.
 */
export function activeProject(payload, args = {}, { env = process.env } = {}) {
  if (env.MEMMEM_DISABLE === "1") return null;
  if (fallbackShouldSkip(args, { env })) return null;
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  let found, local;
  try {
    found = findConfig(cwd);
    if (!found || !found.config || typeof found.config !== "object" || Array.isArray(found.config)) return null;
    local = readLocalStrict(found.dir);
  } catch { return null; }
  if (!(env.MEMMEM_MEMBER || local.member)) return null;
  const mode = modeOf(local);
  if ((mode === "user") !== Boolean(args.user)) return null;
  return { cwd, found, mode, paths: projectPaths(found.config, found.dir) };
}

/** Format the SessionStart output for each CLI. */
export function formatSessionStart(tool, context) {
  if (tool === "codex") return context; // Codex: plain stdout is added as developer context
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } });
}

// ---- init-state notice (first line of the SessionStart context) ----

const oneLine = (v, max = 400) => { const t = String(v ?? "").replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const names = (v) => (Array.isArray(v) ? v.filter(Boolean).join(", ") : typeof v === "string" ? v : "");

const NOTICE = {
  en: {
    done: ({ n, by }) => `Team memory initialization finished${n || by ? ` (${[n, by && `by ${by}`].filter(Boolean).join(", ")})` : ""}.`,
    contributed: ({ n, by }) => `Team memory: past sessions of ${by || "a teammate"} were added${n ? ` (${n})` : ""}.`,
    mine: (skill) => ` Your past sessions are not in it yet: ${skill} adds them.`,
    failed: ({ error }) => `Team memory initialization failed${error ? `: ${error}` : ""}. Details: \`memmem status\`.`,
    waiting: ({ q }) => `The memory server needs an answer to finish the team memory initialization: "${q}" Ask the user, then run \`memmem init --answer "<text>"\`.`,
    commits: (k) => `${k} commit${k === 1 ? "" : "s"}`,
  },
  ko: {
    done: ({ n, by }) => `팀 메모리 초기화가 완료되었습니다${n || by ? ` (${[n, by && `by ${by}`].filter(Boolean).join(", ")})` : ""}.`,
    contributed: ({ n, by }) => `팀 메모리에 ${by || "팀원"}의 과거 세션이 반영되었습니다${n ? ` (${n})` : ""}.`,
    mine: (skill) => ` 내 과거 세션은 아직 반영되지 않았습니다: ${skill}로 추가할 수 있습니다.`,
    failed: ({ error }) => `팀 메모리 초기화가 실패했습니다${error ? `: ${error}` : ""}. 자세한 내용: \`memmem status\`.`,
    waiting: ({ q }) => `메모리 서버가 팀 메모리 초기화를 마치려면 답이 필요합니다: "${q}" 사용자에게 묻고 \`memmem init --answer "<답>"\`을 실행하세요.`,
    commits: (k) => `${k} commits`,
  },
};

/** Identity of the run a status.json describes (lastRun.initId, else the top-level initId; null when neither). */
export function initRunId(status) {
  return status?.lastRun?.initId ?? status?.initId ?? null;
}

/**
 * Pure: the one-line notice for bootstrap/status.json, given what this
 * checkout last saw (.memmem/local.json lastSeenInit). `waiting_for_answer`
 * and `failed` show at every session start until they change; `done` shows
 * once per run. Returns { text (or ""), seen: {initId, state} to record (or null) }.
 */
export function initNotice(status, lastSeen, { member, language = "en", tool = "claude-code" } = {}) {
  if (!status || typeof status !== "object" || typeof status.state !== "string") return { text: "", seen: null };
  const N = NOTICE[language === "ko" ? "ko" : "en"];
  const initId = initRunId(status);
  const seen = { initId, state: status.state };
  const last = status.lastRun && typeof status.lastRun === "object" ? status.lastRun : {};
  if (status.state === "waiting_for_answer") {
    const q = oneLine(status.question ?? last.question);
    return { text: q ? N.waiting({ q }) : "", seen };
  }
  if (status.state === "failed") return { text: N.failed({ error: oneLine(status.error ?? last.error) }), seen };
  if (status.state !== "done") return { text: "", seen };
  if (lastSeen && lastSeen.state === "done" && lastSeen.initId === initId) return { text: "", seen: null };
  const commits = Array.isArray(last.commits) ? last.commits : Array.isArray(status.commits) ? status.commits : null;
  const n = commits ? N.commits(commits.length) : "";
  const by = names(last.requestedBy) || names(status.initializedBy);
  let text = last.kind === "contribute" ? N.contributed({ n, by }) : N.done({ n, by });
  const members = status.members && typeof status.members === "object" ? status.members : null;
  if (members && member && !members[member]) text += N.mine(tool === "codex" ? "$memmem-init" : "/memmem-init");
  return { text, seen };
}

/**
 * bootstrap/status.json as the server last pushed it: fetch the transcripts
 * clone (no working-tree change, so a concurrent sync is unaffected) and read
 * the upstream copy; fall back to the local file. null without a clone.
 */
export function readRemoteInitStatus(paths, { timeout = 10_000 } = {}) {
  if (!fs.existsSync(path.join(paths.transcripts, ".git"))) return null;
  const f = git(["fetch", "--quiet", "origin"], { cwd: paths.transcripts, timeout });
  if (!f.ok) log(paths, "session-start", `fetch transcripts failed (using local copy): ${f.stderr}`);
  const r = git(["show", "@{upstream}:bootstrap/status.json"], { cwd: paths.transcripts, timeout });
  let raw = r.ok ? r.stdout : null;
  if (raw === null) { try { raw = fs.readFileSync(path.join(paths.transcripts, "bootstrap", "status.json"), "utf8"); } catch { return null; } }
  try { return JSON.parse(raw); } catch { return null; }
}

/** The notice for this session start, recording what was seen in .memmem/local.json. Never throws. */
function sessionNotice(found, paths, { language, tool, timeout }) {
  try {
    const status = readRemoteInitStatus(paths, { timeout });
    const n = initNotice(status, readLocal(found.dir).lastSeenInit, { member: paths.member, language, tool });
    if (n.seen) writeLocal(found.dir, { lastSeenInit: n.seen });
    return n.text;
  } catch (e) {
    log(paths, "session-start", `init notice: ${e?.message || e}`);
    return "";
  }
}

export function runSessionStart(args, payload = readStdinJson()) {
  const tool = detectTool(args.tool, payload);
  const p = activeProject(payload, args);
  if (!p) return 0; // not a team project (or a fallback copy with memmem on PATH): no output
  const { found, paths, mode } = p;
  const timeout = Number(process.env.MEMMEM_PULL_TIMEOUT_MS || 10_000);
  if (!fs.existsSync(path.join(paths.memory, ".git"))) {
    const r = ensureClone(repoUrl(found.config.memoryRepo), paths.memory, { timeout });
    if (!r.ok) { log(paths, "session-start", `clone memory failed: ${r.error}`); return 0; }
  } else {
    const r = git(["pull", "--quiet", "--ff-only"], { cwd: paths.memory, timeout });
    if (!r.ok) log(paths, "session-start", `pull memory failed (using local copy): ${r.stderr}`);
  }
  const maxChars = maxCharsFromEnv();
  const language = languageOf(found.config);
  const notice = sessionNotice(found, paths, { language, tool, timeout });
  // User mode has no project skill or AGENTS.md block: the intro itself points at the guide.
  const guide = mode === "user" ? path.join(found.dir, GUIDE_FILE) : "";
  const context = buildContext({ project: paths.project, memDir: paths.memory, maxChars, language, notice, guide, tool });
  process.stdout.write(formatSessionStart(tool, context) + "\n");
  return 0;
}

/** argv for the detached child (unit-tested for both the source and compiled layouts). */
export function syncSpawnArgs({ tool, cwd, transcript, session, delayMs = process.env.MEMMEM_SYNC_DELAY_MS || "1500" }, invocation = selfInvocation()) {
  const args = [...invocation.args, "sync", "--tool", tool, "--cwd", cwd, "--delay-ms", String(delayMs)];
  if (transcript) args.push("--transcript", transcript);
  if (session) args.push("--session", String(session));
  return { cmd: invocation.cmd, args };
}

/**
 * Start `memmem sync` for this session as a detached process (new process
 * group, output appended to sync.log) and return at once. Shared by
 * session-end and checkpoint. Returns the child pid.
 */
export function detachSync(paths, { tool, cwd, transcript, session, scope }) {
  const { cmd, args: childArgs } = syncSpawnArgs({ tool, cwd, transcript, session });
  fs.mkdirSync(paths.logs, { recursive: true });
  const fd = fs.openSync(path.join(paths.logs, "sync.log"), "a");
  const child = spawn(cmd, childArgs, { cwd, detached: true, stdio: ["ignore", fd, fd], env: process.env });
  child.unref();
  fs.closeSync(fd);
  log(paths, scope, `detached sync pid=${child.pid} tool=${tool} session=${session || "-"}`);
  return child.pid;
}

// ---- checkpoint state: <data root>/<project>/checkpoints/<sessionId>.json ----

export const DEFAULT_CHECKPOINT_MINUTES = 30;
export const DEFAULT_CHECKPOINT_MIN_BYTES = 2048;

function envNumber(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function checkpointSettingsFromEnv() {
  return {
    minutes: envNumber("MEMMEM_CHECKPOINT_MINUTES", DEFAULT_CHECKPOINT_MINUTES),
    minBytes: envNumber("MEMMEM_CHECKPOINT_MIN_BYTES", DEFAULT_CHECKPOINT_MIN_BYTES),
  };
}

export function checkpointFile(paths, sessionId) {
  return path.join(paths.checkpoints, `${safeName(sessionId)}.json`);
}

export function readCheckpoint(paths, sessionId) {
  try {
    const v = JSON.parse(fs.readFileSync(checkpointFile(paths, sessionId), "utf8"));
    return v && typeof v === "object" ? v : null;
  } catch { return null; }
}

function writeCheckpointState(paths, sessionId, v) {
  try {
    fs.mkdirSync(paths.checkpoints, { recursive: true });
    const f = checkpointFile(paths, sessionId);
    fs.writeFileSync(`${f}.${process.pid}.tmp`, JSON.stringify(v) + "\n");
    fs.renameSync(`${f}.${process.pid}.tmp`, f);
  } catch { /* state is an optimization; never break a hook */ }
}

/** Record that a sync was launched for the transcript as it was at `stat`. */
export function writeCheckpoint(paths, sessionId, stat, now = Date.now()) {
  writeCheckpointState(paths, sessionId, { lastSyncAt: new Date(now).toISOString(), lastSize: stat.size, lastMtime: new Date(stat.mtimeMs).toISOString() });
}

/**
 * Throttle decision for a `Stop` checkpoint (pure: clock and stat are
 * injected). Sync when the transcript exists, changed (size or mtime) since
 * the last launched sync, grew by at least `minBytes` (a shrunk/rewritten file
 * counts its whole size), and `minutes` have passed since the last sync
 * (`0` = every Stop). The first Stop of a session with no state only records
 * a baseline (`lastSyncAt` = now, `lastSize` = 0) when `minutes` > 0, so the
 * first checkpoint comes `minutes` into the session and short sessions are
 * synced by SessionEnd alone. Returns { sync, reason, baseline? }.
 */
export function checkpointDecision({ stat, state, now, minutes = DEFAULT_CHECKPOINT_MINUTES, minBytes = DEFAULT_CHECKPOINT_MIN_BYTES }) {
  if (!stat) return { sync: false, reason: "no-transcript" };
  if (!state && minutes > 0) return { sync: false, reason: "baseline", baseline: { lastSyncAt: new Date(now).toISOString(), lastSize: 0, lastMtime: null } };
  const lastSize = Number(state?.lastSize) || 0;
  const lastMtime = state?.lastMtime ? Date.parse(state.lastMtime) : NaN;
  const lastSyncAt = state?.lastSyncAt ? Date.parse(state.lastSyncAt) : NaN;
  if (state && stat.size === lastSize && Math.floor(stat.mtimeMs) === Math.floor(lastMtime)) return { sync: false, reason: "unchanged" };
  if (!Number.isNaN(lastSyncAt) && now - lastSyncAt < minutes * 60_000) return { sync: false, reason: "throttled" };
  const growth = stat.size >= lastSize ? stat.size - lastSize : stat.size;
  if (growth < minBytes) return { sync: false, reason: "small" };
  return { sync: true, reason: state ? "changed" : "first" };
}

function statOrNull(file) {
  try { return fs.statSync(file); } catch { return null; }
}

/** Codex `Stop` expects a JSON object on stdout when the hook exits 0. */
function checkpointOutput(tool) {
  if (tool === "codex") process.stdout.write("{}\n");
}

/**
 * `Stop` / `PreCompact` hook. PreCompact always launches a sync (the
 * conversation is about to be compacted); Stop launches one only when the
 * throttle allows. Only stats files and spawns, so it returns at once.
 */
export function runCheckpoint(args, payload = readStdinJson(), { now = Date.now() } = {}) {
  const tool = detectTool(args.tool, payload);
  try {
    const p = activeProject(payload, args);
    if (!p) return 0;
    const { cwd, paths } = p;
    const event = String(payload.hook_event_name || "Stop");
    const session = payload.session_id ? String(payload.session_id) : "";
    const transcript = resolveTranscript(payload.transcript_path || "", { tool, sessionId: session });
    const sessionId = session || (transcript ? sessionIdFromPath(transcript) : "");
    if (!sessionId) { log(paths, "checkpoint", `${event}: no transcript_path/session_id in payload`); return 0; }
    const stat = transcript ? statOrNull(transcript) : null;
    if (event !== "PreCompact") {
      const d = checkpointDecision({ stat, state: readCheckpoint(paths, sessionId), now, ...checkpointSettingsFromEnv() });
      if (d.baseline) writeCheckpointState(paths, sessionId, d.baseline);
      if (!d.sync) return 0; // the common case: nothing logged, so sync.log stays readable
    }
    detachSync(paths, { tool, cwd, transcript: transcript || payload.transcript_path || "", session: sessionId, scope: `checkpoint:${event}` });
    if (stat) writeCheckpoint(paths, sessionId, stat, now);
    return 0;
  } catch (e) {
    process.stderr.write(`memmem checkpoint: ${e?.message || e}\n`);
    return 0;
  } finally {
    checkpointOutput(tool);
  }
}

export function runSessionEnd(args, payload = readStdinJson()) {
  const tool = detectTool(args.tool, payload);
  const p = activeProject(payload, args);
  if (!p) return 0;
  const { cwd, paths } = p;
  const transcript = payload.transcript_path || "";
  const session = payload.session_id || "";
  if (!transcript && !session) { log(paths, "session-end", "no transcript_path/session_id in payload"); return 0; }
  detachSync(paths, { tool, cwd, transcript, session, scope: "session-end" });
  // Same state as checkpoint, so a Stop that fires right after does not sync again.
  const sessionId = session ? String(session) : sessionIdFromPath(transcript);
  const stat = transcript ? statOrNull(transcript) : null;
  if (stat) writeCheckpoint(paths, sessionId, stat);
  return 0;
}
