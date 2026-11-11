import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CLAUDE_FIXTURE, CODEX_FIXTURE, dataDir, isolatedEnv, lsTree, makeBareRepo, REPO_DIR, run, sh, showFile, tmpDir, waitFor } from "./helpers.mjs";

test("end to end: setup -> session-start -> session-end -> trajectory on main", async () => {
  const root = tmpDir();
  const env = isolatedEnv(path.join(root, "home"), { MEMMEM_SYNC_DELAY_MS: "100" });
  fs.mkdirSync(env.HOME);
  const memoryBare = makeBareRepo(path.join(root, "mem-acme.git"), path.join(REPO_DIR, "templates", "memory-repo", "ko"), env);
  const transcriptsBare = makeBareRepo(path.join(root, "mem-acme-transcripts.git"), path.join(REPO_DIR, "templates", "transcripts-repo"), env);
  const proj = path.join(root, "work", "acme-app");
  fs.mkdirSync(proj, { recursive: true });
  sh("git", ["init", "--quiet", "-b", "main", proj], { env });

  const init = run(["setup", "--project", "acme", "--memory-repo", memoryBare, "--transcripts-repo", transcriptsBare, "--member", "alice", "--language", "ko", "--shared"], { env, cwd: proj });
  assert.equal(init.code, 0, init.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(proj, ".memmem", "config.json"), "utf8"));
  assert.deepEqual(cfg, { project: "acme", memoryRepo: memoryBare, transcriptsRepo: transcriptsBare, language: "ko", layoutVersion: 1 });
  const home = dataDir(env);
  assert.ok(fs.existsSync(path.join(proj, ".memmem", "memory", "MEMORY.md")), "memory clone inside the project");
  assert.ok(fs.existsSync(path.join(home, "transcripts", "README.md")), "transcripts clone under the data root");
  assert.ok(!fs.existsSync(path.join(home, "memory")));
  // Only the files the team commits show up in the project repo (no clone, no local.json, no settings.local.json).
  assert.deepEqual(sh("git", ["status", "--porcelain", "-uall"], { cwd: proj, env }).split("\n").sort(), [
    "?? .agents/skills/memmem-init/SKILL.md", "?? .claude/settings.json", "?? .claude/skills/memmem-init/SKILL.md",
    "?? .claude/skills/remember/SKILL.md", "?? .codex/hooks.json", "?? .gitignore", "?? .memmem/config.json", "?? AGENTS.md",
  ]);
  assert.equal(fs.readFileSync(path.join(proj, ".gitignore"), "utf8"), ".memmem/*\n!.memmem/config.json\n.claude/settings.local.json\n");

  const start = run(["session-start", "--tool", "claude-code"], { env, input: JSON.stringify({ session_id: "11111111-2222-4333-8444-555555555555", cwd: proj, hook_event_name: "SessionStart", source: "startup" }) });
  assert.equal(start.code, 0, start.stderr);
  assert.match(JSON.parse(start.stdout).hookSpecificOutput.additionalContext, /## project\.md/);
  assert.match(JSON.parse(start.stdout).hookSpecificOutput.additionalContext, /^이 프로젝트\(acme\)/, "language from config.json");

  for (const [tool, fixture, sid] of [
    ["claude-code", CLAUDE_FIXTURE, "11111111-2222-4333-8444-555555555555"],
    ["codex", CODEX_FIXTURE, "019a0000-aaaa-7bbb-8ccc-dddddddddddd"],
  ]) {
    const end = run(["session-end", "--tool", tool], { env, input: JSON.stringify({ session_id: sid, transcript_path: fixture, cwd: proj, hook_event_name: "SessionEnd", reason: "other" }) });
    assert.equal(end.code, 0, end.stderr);
  }

  const expected = [
    "trajectories/2026-11/alice/claude-code/2026-11-06T01-23-45Z_11111111-2222-4333-8444-555555555555.json",
    "trajectories/2026-11/alice/codex/2026-11-06T02-00-00Z_019a0000-aaaa-7bbb-8ccc-dddddddddddd.json",
  ];
  await waitFor(() => { const t = lsTree(transcriptsBare, env); return expected.every((e) => t.includes(e)); }, { timeoutMs: 45_000 });
  const doc = JSON.parse(showFile(transcriptsBare, expected[0], env));
  assert.equal(doc.meta.member, "alice");
  assert.equal(doc.meta.tool, "claude-code");
  assert.equal(doc.meta.sessionId, "11111111-2222-4333-8444-555555555555");
  assert.equal(doc.meta.cwd, proj);
  assert.ok(Array.isArray(doc.records) && doc.records[0].role === "meta");

  // Idempotent: syncing the same session again changes nothing.
  const before = lsTree(transcriptsBare, env).length;
  const again = run(["sync", "--transcript", CLAUDE_FIXTURE, "--tool", "claude-code", "--session", "11111111-2222-4333-8444-555555555555", "--cwd", proj], { env, cwd: proj });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(lsTree(transcriptsBare, env).length, before);
  const log = fs.readFileSync(path.join(home, "logs", "sync.log"), "utf8");
  assert.match(log, /\[sync\] unchanged trajectories\/2026-11\/alice\/claude-code\//);
});
