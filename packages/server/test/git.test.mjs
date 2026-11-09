import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  blobId,
  changedIngestFiles,
  commitAndPushLog,
  commitExists,
  isIngestPath,
  isNonFastForward,
  listIngestFiles,
  pushMemory,
  syncRepo,
} from "../dist/git.js";
import { fakeMemfs, seededTranscriptsRepo, sh, tempDir, writeAndPush } from "./helpers.mjs";

test("isIngestPath filters to trajectories/*.json and inbox/*.md", () => {
  assert.ok(isIngestPath("trajectories/2026-11/a/codex/x_y.json"));
  assert.ok(isIngestPath("inbox/a/2026-11-01-x.md"));
  assert.ok(!isIngestPath("trajectories/.gitkeep"));
  assert.ok(!isIngestPath("ingest/log.jsonl"));
  assert.ok(!isIngestPath("README.md"));
});

test("sync, diff, list, and log commit against a bare repo", async () => {
  const root = tempDir("memmem-git-");
  const { bare, work } = seededTranscriptsRepo(root);
  const clone = join(root, "repos", "demo", "transcripts");

  const first = await syncRepo(bare, clone);
  assert.equal(first.branch, "main");
  assert.deepEqual(await listIngestFiles(clone), []);

  const traj = "trajectories/2026-11/minji/claude-code/2026-11-02T09-00-00_s1.json";
  const note = "inbox/minji/2026-11-02-ttl.md";
  writeAndPush(work, { [traj]: [{ role: "user", content: "hi" }], [note]: "note", "README.md": "changed\n" });

  const second = await syncRepo(bare, clone);
  assert.notEqual(second.head, first.head);
  assert.deepEqual(await changedIngestFiles(clone, first.head, second.head), [note, traj].sort());
  assert.deepEqual(await listIngestFiles(clone), [note, traj].sort());
  assert.ok(await blobId(clone, traj));
  assert.equal(await blobId(clone, "trajectories/nope.json"), null);
  assert.ok(await commitExists(clone, first.head));
  assert.ok(!(await commitExists(clone, "0".repeat(40))));

  // Modified files count, deleted ones do not.
  sh(work, "rm", "--quiet", note);
  writeAndPush(work, { [traj]: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }] }, "update + delete");
  const third = await syncRepo(bare, clone);
  assert.deepEqual(await changedIngestFiles(clone, second.head, third.head), [traj]);

  // Log commit is pushed to the bare repo.
  const sha = await commitAndPushLog(clone, third.branch, ['{"a":1}', '{"b":2}'], "ingest: test");
  assert.equal(execFileSync("git", ["--git-dir", bare, "rev-parse", "main"], { encoding: "utf8" }).trim(), sha);
  const logText = execFileSync("git", ["--git-dir", bare, "show", "main:ingest/log.jsonl"], { encoding: "utf8" });
  assert.equal(logText, '{"a":1}\n{"b":2}\n');

  // A dirty clone is reset to the remote on the next sync.
  writeFileSync(join(clone, "ingest", "log.jsonl"), "garbage\n");
  await syncRepo(bare, clone);
  assert.equal(readFileSync(join(clone, "ingest", "log.jsonl"), "utf8"), '{"a":1}\n{"b":2}\n');
});

test("syncRepo fails cleanly for a missing remote", async () => {
  const root = tempDir("memmem-git-");
  await assert.rejects(syncRepo(join(root, "does-not-exist.git"), join(root, "clone")), (err) => {
    assert.equal(err.name, "GitError");
    return true;
  });
});

test("pushMemory pushes main and refuses to force over a diverged remote", async () => {
  const root = tempDir("memmem-mem-");
  const memfs = join(root, "memfs");
  const remote = join(root, "memory.git");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  const head = fakeMemfs(memfs);
  assert.equal(await pushMemory(memfs, remote), head);
  assert.equal(execFileSync("git", ["--git-dir", remote, "rev-parse", "main"], { encoding: "utf8" }).trim(), head);

  // Someone else pushes to the memory repo; MemFS commits independently.
  const other = join(root, "other");
  execFileSync("git", ["clone", "--quiet", remote, other]);
  writeFileSync(join(other, "x.md"), "x");
  sh(other, "add", "-A");
  sh(other, "commit", "--quiet", "-m", "pr merge");
  sh(other, "push", "--quiet", "origin", "main");
  writeFileSync(join(memfs, "y.md"), "y");
  sh(memfs, "add", "-A");
  sh(memfs, "commit", "--quiet", "-m", "reflection");
  await assert.rejects(pushMemory(memfs, remote), (err) => isNonFastForward(err));
});
