import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileStamp, readTranscript, resolveTranscript, sessionIdFromPath, trajectoryRelPath } from "../lib/normalize.mjs";
import { buildTrajectoryDoc } from "../lib/sync.mjs";
import { CLAUDE_FIXTURE, CODEX_FIXTURE, tmpDir } from "./helpers.mjs";

test("claude-code fixture -> layout path and meta", () => {
  const raw = fs.readFileSync(CLAUDE_FIXTURE, "utf8");
  const r = buildTrajectoryDoc({ raw, tool: "claude-code", sessionId: "11111111-2222-4333-8444-555555555555", member: "alice", project: "acme" });
  assert.equal(r.skip, undefined);
  assert.equal(r.relPath, "trajectories/2026-11/alice/claude-code/2026-11-06T01-23-45Z_11111111-2222-4333-8444-555555555555.json");
  assert.deepEqual(r.doc.records.map((x) => x.role), ["meta", "user", "assistant", "assistant", "tool", "assistant"]);
  assert.equal(r.doc.meta.member, "alice");
  assert.equal(r.doc.meta.tool, "claude-code");
  assert.equal(r.doc.meta.startedAt, "2026-11-06T01:23:45.120Z");
  assert.equal(r.doc.meta.cwd, "/home/dev/acme-app");
  assert.equal(r.doc.meta.redactions, 0);
  assert.deepEqual(JSON.parse(r.json).meta.sessionId, "11111111-2222-4333-8444-555555555555");
});

test("codex fixture -> layout path, injected context dropped", () => {
  const raw = fs.readFileSync(CODEX_FIXTURE, "utf8");
  const r = buildTrajectoryDoc({ raw, tool: "codex", sessionId: "019a0000-aaaa-7bbb-8ccc-dddddddddddd", member: "bob", project: "acme" });
  assert.equal(r.relPath, "trajectories/2026-11/bob/codex/2026-11-06T02-00-00Z_019a0000-aaaa-7bbb-8ccc-dddddddddddd.json");
  const users = r.doc.records.filter((x) => x.role === "user");
  assert.equal(users.length, 1);
  assert.match(users[0].content, /migration/);
  assert.ok(r.doc.records.some((x) => x.role === "tool" && x.tool_call_id === "call_1"));
});

test("empty transcript is skipped; size cap is enforced", () => {
  assert.match(buildTrajectoryDoc({ raw: "", tool: "claude-code", sessionId: "s", member: "m", project: "p" }).skip, /no (user|user\/assistant) records/);
  const raw = fs.readFileSync(CLAUDE_FIXTURE, "utf8");
  const r = buildTrajectoryDoc({ raw, tool: "claude-code", sessionId: "s", member: "m", project: "p", maxBytes: 100 });
  assert.match(r.skip, /exceeds limit/);
});

test("helpers: fileStamp, relPath sanitizing, session id from file name", () => {
  assert.equal(fileStamp("2026-01-02T03:04:05.678Z"), "2026-01-02T03-04-05Z");
  assert.equal(trajectoryRelPath({ member: "a/b", tool: "codex", sessionId: "x y", startedAt: "2026-01-02T03:04:05.000Z" }),
    "trajectories/2026-01/a-b/codex/2026-01-02T03-04-05Z_x-y.json");
  assert.equal(sessionIdFromPath("/x/rollout-2026-11-01T10-00-00-019a0000-aaaa-7bbb-8ccc-dddddddddddd.jsonl.zst"), "019a0000-aaaa-7bbb-8ccc-dddddddddddd");
  assert.equal(sessionIdFromPath("/x/11111111-2222-4333-8444-555555555555.jsonl"), "11111111-2222-4333-8444-555555555555");
});

const hasZstd = spawnSync("zstd", ["--version"]).status === 0;
test(".jsonl.zst is decompressed and found via fallback", { skip: !hasZstd && "zstd not installed" }, () => {
  const dir = tmpDir();
  const plain = path.join(dir, "rollout-2026-11-06T02-00-00-019a0000-aaaa-7bbb-8ccc-dddddddddddd.jsonl");
  fs.copyFileSync(CODEX_FIXTURE, plain);
  spawnSync("zstd", ["-q", "--rm", plain]);
  assert.ok(!fs.existsSync(plain));
  const resolved = resolveTranscript(plain, { tool: "codex" });
  assert.equal(resolved, `${plain}.zst`);
  assert.equal(readTranscript(resolved), fs.readFileSync(CODEX_FIXTURE, "utf8"));
});

test("codex transcript is located by session id when no path is given", () => {
  const home = tmpDir();
  const day = path.join(home, "sessions", "2026", "11", "06");
  fs.mkdirSync(day, { recursive: true });
  const f = path.join(day, "rollout-2026-11-06T02-00-00-019a0000-aaaa-7bbb-8ccc-dddddddddddd.jsonl");
  fs.copyFileSync(CODEX_FIXTURE, f);
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    assert.equal(resolveTranscript(null, { tool: "codex", sessionId: "019a0000-aaaa-7bbb-8ccc-dddddddddddd" }), f);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
});
