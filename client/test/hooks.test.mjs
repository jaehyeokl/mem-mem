import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { detectTool } from "../lib/util.mjs";
import { CLAUDE_FIXTURE, dataDir, isolatedEnv, makeProject, run, tmpDir, waitFor } from "./helpers.mjs";

test("detectTool: flag > env > payload", () => {
  assert.equal(detectTool("codex", {}), "codex");
  assert.equal(detectTool("claude", {}), "claude-code");
  assert.equal(detectTool(undefined, { transcript_path: "/h/.codex/sessions/2026/11/06/rollout-x.jsonl" }), "codex");
  assert.equal(detectTool(undefined, { transcript_path: "/h/.claude/projects/p/x.jsonl", permission_mode: "default" }), "claude-code");
});

test("session-end returns immediately and detaches the sync", async () => {
  const root = tmpDir();
  const env = isolatedEnv(path.join(root, "home"), { MEMMEM_SYNC_DELAY_MS: "4000" });
  fs.mkdirSync(env.HOME);
  // Repos that do not exist: the detached sync will fail later, which is fine here.
  const proj = makeProject(root, { memoryBare: path.join(root, "nope-m.git"), transcriptsBare: path.join(root, "nope-t.git") });
  const t0 = Date.now();
  const r = run(["session-end", "--tool", "claude-code"], {
    env, input: JSON.stringify({ session_id: "s-1", transcript_path: CLAUDE_FIXTURE, cwd: proj, hook_event_name: "SessionEnd", reason: "other" }),
  });
  const elapsed = Date.now() - t0;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "");
  assert.ok(elapsed < 1500, `session-end took ${elapsed} ms`);
  const logFile = path.join(dataDir(env), "logs", "sync.log");
  const line = fs.readFileSync(logFile, "utf8").match(/detached sync pid=(\d+)/);
  assert.ok(line, "logged the detached pid");
  const pid = Number(line[1]);
  assert.doesNotThrow(() => process.kill(pid, 0), "child still running after the hook exited");
  // Let it finish (it fails to clone the missing repo and logs an error).
  await waitFor(() => /\[sync\] error/.test(fs.readFileSync(logFile, "utf8")), { timeoutMs: 20_000 });
});

test("session-end outside a team project is a silent no-op", () => {
  const root = tmpDir();
  const env = isolatedEnv(root);
  const r = run(["session-end"], { env, input: JSON.stringify({ session_id: "s", transcript_path: CLAUDE_FIXTURE, cwd: root }) });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.ok(!fs.existsSync(path.join(root, ".local")));
  assert.ok(!fs.existsSync(path.join(root, ".memmem")));
});
