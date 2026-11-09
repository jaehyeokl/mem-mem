import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { slugify } from "../lib/remember.mjs";
import { isolatedEnv, lsTree, makeBareRepo, makeProject, REPO_DIR, run, showFile, tmpDir } from "./helpers.mjs";

test("slugify", () => {
  assert.equal(slugify("Use Postgres 16, not MySQL!"), "use-postgres-16-not-mysql");
  assert.match(slugify("배포는 금요일 금지"), /^note-[0-9a-f]{8}$/);
  assert.equal(slugify("Redis 캐시 TTL 결정"), "redis-ttl");
  assert.match(slugify("!!!"), /^note-/);
});

test("remember writes inbox/<member>/<date>-<slug>.md and pushes", () => {
  const root = tmpDir();
  const env = isolatedEnv(path.join(root, "home"));
  fs.mkdirSync(env.HOME);
  const transcriptsBare = makeBareRepo(path.join(root, "t.git"), path.join(REPO_DIR, "templates", "transcripts-repo"), env);
  const proj = makeProject(root, { memoryBare: path.join(root, "m.git"), transcriptsBare, member: "alice" });
  const r = run(["remember", "We deploy only on Tuesdays", "password=hunter22"], { env, cwd: proj });
  assert.equal(r.code, 0, r.stderr);
  const files = lsTree(transcriptsBare, env).filter((f) => f.startsWith("inbox/alice/"));
  assert.equal(files.length, 1);
  const today = new Date().toISOString().slice(0, 10);
  assert.match(files[0], new RegExp(`^inbox/alice/${today}-we-deploy-only-on-tuesdays-password\\.md$`));
  const body = showFile(transcriptsBare, files[0], env);
  assert.match(body, /^---\nmember: alice\nproject: acme\ncreated: \d{4}-.*Z\nsource: manual\n---\n/);
  assert.match(body, /We deploy only on Tuesdays/);
  assert.ok(!body.includes("hunter22"));

  // stdin form, same day: does not overwrite
  const r2 = run(["remember", "-"], { env, cwd: proj, input: "배포는 금요일 금지\n" });
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(lsTree(transcriptsBare, env).filter((f) => f.startsWith("inbox/alice/")).length, 2);
});
