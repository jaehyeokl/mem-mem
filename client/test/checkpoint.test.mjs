import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { checkpointDecision } from "../lib/hooks.mjs";
import { CLAUDE_FIXTURE, dataDir, isolatedEnv, lsTree, makeBareRepo, makeProject, REPO_DIR, run, showFile, tmpDir, waitFor } from "./helpers.mjs";

const SID = "11111111-2222-4333-8444-555555555555";
const T0 = Date.parse("2026-11-06T10:00:00Z");
const MIN = 60_000;
const st = (size, mtime = T0) => ({ size, mtimeMs: mtime });
const state = (lastSize, lastSyncAt = T0, lastMtime = T0) => ({ lastSyncAt: new Date(lastSyncAt).toISOString(), lastSize, lastMtime: new Date(lastMtime).toISOString() });

test("checkpointDecision: throttle by time, change, and growth", () => {
  const d = (stat, s, now, opts = {}) => checkpointDecision({ stat, state: s, now, minutes: 30, minBytes: 2048, ...opts });
  assert.deepEqual(d(null, null, T0), { sync: false, reason: "no-transcript" });
  // First Stop of a session: baseline only, so the first checkpoint comes 30 min in.
  const b = d(st(50_000), null, T0);
  assert.equal(b.sync, false);
  assert.equal(b.reason, "baseline");
  assert.deepEqual(b.baseline, { lastSyncAt: new Date(T0).toISOString(), lastSize: 0, lastMtime: null });
  assert.equal(d(st(50_000, T0 + 31 * MIN), b.baseline, T0 + 31 * MIN).sync, true);
  // Unchanged size and mtime: never, however long ago.
  assert.equal(d(st(10_000), state(10_000), T0 + 600 * MIN).reason, "unchanged");
  // Changed but within the window.
  assert.equal(d(st(20_000, T0 + 5 * MIN), state(10_000), T0 + 29 * MIN).reason, "throttled");
  // Window passed, enough growth.
  assert.deepEqual(d(st(20_000, T0 + 5 * MIN), state(10_000), T0 + 30 * MIN), { sync: true, reason: "changed" });
  // Window passed, trivial growth (or only mtime changed).
  assert.equal(d(st(10_100, T0 + 40 * MIN), state(10_000), T0 + 40 * MIN).reason, "small");
  assert.equal(d(st(10_000, T0 + 40 * MIN), state(10_000), T0 + 40 * MIN).reason, "small");
  // A rewritten (smaller) file counts its whole size as growth.
  assert.equal(d(st(4_000, T0 + 40 * MIN), state(10_000), T0 + 40 * MIN).sync, true);
  // minutes = 0: every Stop that changed enough, including the first one.
  assert.equal(d(st(3_000), null, T0, { minutes: 0 }).sync, true);
  assert.equal(d(st(9_000, T0 + 1000), state(3_000), T0 + 1000, { minutes: 0 }).sync, true);
  assert.equal(d(st(3_000), state(3_000), T0 + 1000, { minutes: 0 }).reason, "unchanged");
  assert.equal(d(st(3_100, T0 + 1000), state(3_000), T0 + 1000, { minutes: 0, minBytes: 0 }).sync, true);
});

test("checkpoint is a silent no-op outside a team project; codex still gets {}", () => {
  const root = tmpDir();
  const env = isolatedEnv(root);
  const payload = JSON.stringify({ session_id: SID, transcript_path: CLAUDE_FIXTURE, cwd: root, hook_event_name: "Stop" });
  const c = run(["checkpoint", "--tool", "codex"], { env, input: payload });
  assert.equal(c.code, 0, c.stderr);
  assert.deepEqual(JSON.parse(c.stdout), {});
  const cl = run(["checkpoint", "--tool", "claude-code"], { env, input: payload });
  assert.equal(cl.code, 0);
  assert.equal(cl.stdout, "");
  assert.ok(!fs.existsSync(path.join(root, ".local")));
});

function hookEnv(extra = {}) {
  const root = tmpDir();
  const env = isolatedEnv(path.join(root, "home"), { MEMMEM_SYNC_DELAY_MS: "0", ...extra });
  fs.mkdirSync(env.HOME);
  const memoryBare = makeBareRepo(path.join(root, "mem-acme.git"), path.join(REPO_DIR, "templates", "memory-repo", "ko"), env);
  const transcriptsBare = makeBareRepo(path.join(root, "mem-acme-transcripts.git"), path.join(REPO_DIR, "templates", "transcripts-repo"), env);
  const proj = makeProject(root, { memoryBare, transcriptsBare });
  const transcript = path.join(root, `${SID}.jsonl`);
  fs.copyFileSync(CLAUDE_FIXTURE, transcript);
  const home = dataDir(env);
  const logFile = path.join(home, "logs", "sync.log");
  const readLog = () => { try { return fs.readFileSync(logFile, "utf8"); } catch { return ""; } };
  const stateFile = path.join(home, "checkpoints", `${SID}.json`);
  const hook = (event, tool = "claude-code", envExtra = {}) =>
    run(["checkpoint", "--tool", tool], { env: { ...env, ...envExtra }, input: JSON.stringify({ session_id: SID, transcript_path: transcript, cwd: proj, hook_event_name: event }) });
  return { root, env, proj, transcript, transcriptsBare, readLog, stateFile, hook };
}

const count = (s, re) => (s.match(new RegExp(re.source, "g")) || []).length;

function appendTurn(file, n) {
  const ts = `2026-11-06T02:0${n}:00.000Z`;
  const lines = [
    { type: "user", uuid: `u-x${n}`, sessionId: SID, timestamp: ts, message: { role: "user", content: `Follow-up ${n}: ${"please also cover the refresh-token path. ".repeat(20)}` } },
    { type: "assistant", uuid: `a-x${n}`, parentUuid: `u-x${n}`, sessionId: SID, timestamp: ts, message: { id: `msg_x${n}`, type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: `Done ${n}. ${"Added a refresh-token test in test/auth.test.ts. ".repeat(20)}` }], stop_reason: "end_turn" } },
  ];
  fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

test("Stop checkpoints a growing session to the same path; throttle and unchanged skip", async () => {
  const t = hookEnv({ MEMMEM_CHECKPOINT_MINUTES: "0", MEMMEM_CHECKPOINT_MIN_BYTES: "1024" });
  const rel = `trajectories/2026-11/alice/claude-code/2026-11-06T01-23-45Z_${SID}.json`;

  const t0 = Date.now();
  const r1 = t.hook("Stop");
  assert.ok(Date.now() - t0 < 1500, "hook returns at once");
  assert.equal(r1.code, 0, r1.stderr);
  assert.equal(r1.stdout, "");
  assert.match(t.readLog(), /\[checkpoint:Stop\] detached sync pid=\d+ tool=claude-code/);
  const s1 = JSON.parse(fs.readFileSync(t.stateFile, "utf8"));
  assert.equal(s1.lastSize, fs.statSync(t.transcript).size);
  await waitFor(() => count(t.readLog(), /\[sync\] ok /) === 1, { timeoutMs: 30_000 });
  const n1 = JSON.parse(showFile(t.transcriptsBare, rel, t.env)).records.length;

  // No change: no sync, state untouched.
  const r2 = t.hook("Stop");
  assert.equal(r2.code, 0);
  assert.equal(count(t.readLog(), /detached sync/), 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(t.stateFile, "utf8")), s1);

  // Session grows: same relPath, more records.
  appendTurn(t.transcript, 1);
  t.hook("Stop");
  await waitFor(() => count(t.readLog(), /\[sync\] ok /) === 2, { timeoutMs: 30_000 });
  const files = lsTree(t.transcriptsBare, t.env).filter((f) => f.includes(SID));
  assert.deepEqual(files, [rel]);
  assert.ok(JSON.parse(showFile(t.transcriptsBare, rel, t.env)).records.length > n1);

  // Grows again, but the 30-minute window has not passed: throttled.
  appendTurn(t.transcript, 2);
  const before = fs.readFileSync(t.stateFile, "utf8");
  t.hook("Stop", "claude-code", { MEMMEM_CHECKPOINT_MINUTES: "30" });
  assert.equal(count(t.readLog(), /detached sync/), 2);
  assert.equal(fs.readFileSync(t.stateFile, "utf8"), before);

  // PreCompact always syncs, regardless of the throttle.
  const pc = t.hook("PreCompact", "claude-code", { MEMMEM_CHECKPOINT_MINUTES: "30" });
  assert.equal(pc.code, 0);
  assert.match(t.readLog(), /\[checkpoint:PreCompact\] detached sync/);
  await waitFor(() => count(t.readLog(), /\[sync\] ok /) === 3, { timeoutMs: 30_000 });
  assert.notEqual(fs.readFileSync(t.stateFile, "utf8"), before, "PreCompact updates the state");

  // PreCompact with nothing new: sync runs, finds the clone identical, no commit or push.
  const commits = lsTree(t.transcriptsBare, t.env).length;
  t.hook("PreCompact");
  await waitFor(() => /\[sync\] unchanged /.test(t.readLog()), { timeoutMs: 30_000 });
  assert.equal(lsTree(t.transcriptsBare, t.env).length, commits);
});

test("codex Stop prints {} and session-end state suppresses an immediate Stop sync", async () => {
  const t = hookEnv({ MEMMEM_CHECKPOINT_MINUTES: "0", MEMMEM_CHECKPOINT_MIN_BYTES: "0" });
  const end = run(["session-end", "--tool", "claude-code"], { env: t.env, input: JSON.stringify({ session_id: SID, transcript_path: t.transcript, cwd: t.proj, hook_event_name: "SessionEnd" }) });
  assert.equal(end.code, 0, end.stderr);
  assert.equal(JSON.parse(fs.readFileSync(t.stateFile, "utf8")).lastSize, fs.statSync(t.transcript).size);
  const r = t.hook("Stop", "codex");
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), {});
  assert.equal(count(t.readLog(), /detached sync/), 1, "only the session-end sync");
  await waitFor(() => /\[sync\] (ok|error)/.test(t.readLog()), { timeoutMs: 30_000 });

  // MEMMEM_DISABLE: no-op, codex still gets {}.
  appendTurn(t.transcript, 1);
  const off = t.hook("PreCompact", "codex", { MEMMEM_DISABLE: "1" });
  assert.deepEqual(JSON.parse(off.stdout), {});
  assert.equal(count(t.readLog(), /detached sync/), 1);
});
