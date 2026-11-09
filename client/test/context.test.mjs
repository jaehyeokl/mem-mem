import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildContext, coreFiles, DEFAULT_MAX_CHARS, indexFolders, maxCharsFromEnv } from "../lib/context.mjs";
import { dataDir, isolatedEnv, makeBareRepo, makeProject, REPO_DIR, run, sh, tmpDir } from "./helpers.mjs";

const TEMPLATE = path.join(REPO_DIR, "templates", "memory-repo", "ko");

function memFixture() {
  const mem = tmpDir();
  fs.cpSync(TEMPLATE, mem, { recursive: true });
  fs.writeFileSync(path.join(mem, "glossary.md"), "---\nname: glossary\ndescription: terms\n---\nACME = the app\n");
  fs.writeFileSync(path.join(mem, "NOTES.md"), "no frontmatter, not core memory\n");
  fs.writeFileSync(path.join(mem, "decisions", "2026-11-06-stripe.md"), "---\nname: stripe\ndescription: d\n---\nDECISION-BODY-NOT-INJECTED\n");
  fs.appendFileSync(path.join(mem, "decisions", "MEMORY.md"), "\n- [Stripe Checkout](2026-11-06-stripe.md): orders are paid only via the verified webhook.\n");
  fs.mkdirSync(path.join(mem, "scratch"));
  fs.writeFileSync(path.join(mem, "scratch", "x.md"), "folder without MEMORY.md\n");
  return mem;
}

const pos = (ctx, s) => { const i = ctx.indexOf(s); assert.ok(i >= 0, `missing ${JSON.stringify(s)}`); return i; };

test("context: file selection and folder order", () => {
  const mem = memFixture();
  assert.deepEqual(coreFiles(mem), ["project.md", "human.md", "glossary.md"]);
  // root MEMORY.md mentions decisions/, changes/, context/, people/ in that order
  assert.deepEqual(indexFolders(mem), ["decisions", "changes", "context", "people"]);
  fs.mkdirSync(path.join(mem, "archive"));
  fs.writeFileSync(path.join(mem, "archive", "MEMORY.md"), "old stuff\n");
  assert.deepEqual(indexFolders(mem), ["decisions", "changes", "context", "people", "archive"], "unlisted folders go last");
});

test("context: intro, root index, core files, then folder indexes, in order", () => {
  const mem = memFixture();
  const ctx = buildContext({ project: "acme", memDir: mem, language: "ko" });
  assert.match(ctx, /^이 프로젝트\(acme\)에는 팀 메모리가 있다/);
  assert.ok(ctx.indexOf(mem) < ctx.indexOf("\n## "), "intro names the local clone path");
  const intro = ctx.slice(0, ctx.indexOf("\n## "));
  assert.match(intro, /직접 수정하지 마라/);
  assert.match(intro, /숨김이고 git에서 무시되므로 rg나 glob/, "intro warns that file search skips the clone");
  assert.match(intro, /색인의 경로로 해당 파일을 직접 읽어라/);
  assert.match(intro, /이 메모리는 한국어로 기록된다\. 사용자와는 사용자의 언어로 대화하라\./);
  const order = ["\n## MEMORY.md\n", "\n## project.md\n", "\n## human.md\n", "\n## glossary.md\n",
    "\n## decisions/ (index)\n", "\n## changes/ (index)\n", "\n## context/ (index)\n", "\n## people/ (index)\n"];
  const at = order.map((h) => pos(ctx, h));
  assert.deepEqual(at, [...at].sort((a, b) => a - b), "sections appear in the documented order");
  assert.match(ctx, /orders are paid only via the verified webhook/, "folder index content injected");
  assert.match(ctx, /\n## project\.md\n\n---\nname: project\n/, "core files keep their frontmatter");
  assert.ok(!ctx.includes("DECISION-BODY-NOT-INJECTED"), "files inside folders are not injected");
  assert.ok(!ctx.includes("## persona.md") && !ctx.includes("## NOTES.md") && !ctx.includes("## scratch/"));
  assert.ok(ctx.length <= DEFAULT_MAX_CHARS);
});

test("context: over budget truncates folder indexes first, last folder first", () => {
  const mem = memFixture();
  const full = buildContext({ project: "acme", memDir: mem, language: "ko" });
  fs.appendFileSync(path.join(mem, "people", "MEMORY.md"), "\n" + "- [p](p.md): someone\n".repeat(400));
  const big = buildContext({ project: "acme", memDir: mem, language: "ko", maxChars: 1e9 });
  const ctx = buildContext({ project: "acme", memDir: mem, language: "ko", maxChars: full.length + 500 });
  assert.ok(ctx.length <= full.length + 500, `${ctx.length} > budget`);
  assert.ok(big.length > ctx.length);
  const people = ctx.slice(pos(ctx, "\n## people/ (index)\n"));
  assert.ok(people.includes("나머지 목록은 `people/MEMORY.md`를 직접 읽어라"), "truncation note names the folder index");
  assert.ok(people.endsWith("를 직접 읽어라)\n"));
  // Everything before people/ is untouched.
  assert.equal(ctx.slice(0, pos(ctx, "\n## people/ (index)\n")), full.slice(0, full.indexOf("\n## people/ (index)\n")));
});

test("context: then core files; root MEMORY.md is never truncated", () => {
  const mem = memFixture();
  fs.writeFileSync(path.join(mem, "project.md"), "---\nname: project\ndescription: p\n---\n" + "project line\n".repeat(5000));
  fs.appendFileSync(path.join(mem, "decisions", "MEMORY.md"), "- [d](d.md): another decision\n".repeat(300));
  const rootIndex = fs.readFileSync(path.join(mem, "MEMORY.md"), "utf8").trim();
  const ctx = buildContext({ project: "acme", memDir: mem, language: "ko", maxChars: 8_000 });
  assert.ok(ctx.length <= 8_000, `${ctx.length}`);
  assert.ok(ctx.includes(`\n## MEMORY.md\n\n${rootIndex}\n`), "root index intact");
  assert.ok(ctx.includes("(잘림. 전체는 `project.md`를 직접 읽어라)"));
  const decisions = ctx.slice(pos(ctx, "\n## decisions/ (index)\n")).split("\n## ")[1];
  assert.ok(!decisions.includes("- ["), "folder index entries dropped before the core file is cut");
  assert.match(decisions, /잘림/);

  // Tiny budget: intro + root MEMORY.md stay whole even if that exceeds the budget.
  const tiny = buildContext({ project: "acme", memDir: mem, language: "ko", maxChars: 100 });
  assert.ok(tiny.includes(`\n## MEMORY.md\n\n${rootIndex}\n`));
  assert.ok(!tiny.includes("project line"));
});

test("context: English is the default intro and truncation language", () => {
  const mem = memFixture();
  const ctx = buildContext({ project: "acme", memDir: mem });
  assert.equal(ctx, buildContext({ project: "acme", memDir: mem, language: "en" }));
  assert.equal(ctx, buildContext({ project: "acme", memDir: mem, language: "fr" }), "unknown language falls back to English");
  const intro = ctx.slice(0, ctx.indexOf("\n## "));
  assert.match(intro, /^This project \(acme\) has a shared team memory\. Local copy: `/);
  assert.ok(intro.includes(`\`${mem}\``));
  assert.match(intro, /Never edit files under this path/);
  assert.match(intro, /hidden and git-ignored, so file search such as rg or glob/);
  assert.match(intro, /memmem remember/);
  assert.match(intro, /Local copy: `[^`]+`\. This memory is written in English\. Talk to the user in their own language\./, "the language line follows the first sentence");
  assert.ok(!/[가-힣]/.test(intro.replace("기억해", "")), "no Korean besides the trigger word");
  fs.writeFileSync(path.join(mem, "project.md"), "---\nname: project\ndescription: p\n---\n" + "project line\n".repeat(5000));
  const cut = buildContext({ project: "acme", memDir: mem, maxChars: 8_000 });
  assert.ok(cut.includes("(truncated; read `project.md` for the full file)"));
  assert.ok(cut.includes("(truncated; read `decisions/MEMORY.md` for the rest of the list)") || cut.includes("(truncated; read `people/MEMORY.md` for the rest of the list)"));
  assert.ok(!cut.includes("잘림"));
});

test("context: MEMMEM_CONTEXT_MAX_CHARS", () => {
  assert.equal(maxCharsFromEnv({}), 24_000);
  assert.equal(maxCharsFromEnv({ MEMMEM_CONTEXT_MAX_CHARS: "5000" }), 5000);
  assert.equal(maxCharsFromEnv({ MEMMEM_CONTEXT_MAX_CHARS: "nope" }), 24_000);
  assert.equal(maxCharsFromEnv({ MEMMEM_CONTEXT_MAX_CHARS: "0" }), 24_000);
});

test("session-start hook: claude JSON, codex same text on stdout, silent outside team projects", () => {
  const root = tmpDir();
  const env = isolatedEnv(path.join(root, "home"));
  fs.mkdirSync(env.HOME);
  const memoryBare = makeBareRepo(path.join(root, "memory.git"), TEMPLATE, env);
  const transcriptsBare = makeBareRepo(path.join(root, "transcripts.git"), null, env);
  const proj = makeProject(root, { memoryBare, transcriptsBare, extra: { language: "ko" } });
  const sub = path.join(proj, "src", "deep");
  fs.mkdirSync(sub, { recursive: true });

  const payload = { session_id: "abc", transcript_path: "/x/.claude/projects/p/abc.jsonl", cwd: sub, hook_event_name: "SessionStart", source: "startup" };
  const c = run(["session-start", "--tool", "claude-code"], { env, input: JSON.stringify(payload) });
  assert.equal(c.code, 0, c.stderr);
  const out = JSON.parse(c.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /## MEMORY\.md/);
  const ctx = out.hookSpecificOutput.additionalContext;
  const localClone = path.join(proj, ".memmem", "memory");
  assert.ok(ctx.slice(0, ctx.indexOf("\n## ")).includes(`\`${localClone}\``), "intro names the project-local clone");
  assert.ok(!ctx.includes(dataDir(env)), "data root never appears in the context");
  assert.ok(fs.existsSync(path.join(localClone, "project.md")), "memory repo cloned on demand into the project");
  assert.ok(!fs.existsSync(path.join(dataDir(env), "memory")), "no memory clone under the data root");

  const x = run(["session-start"], { env: { ...env, MEMMEM_TOOL: "codex" }, input: JSON.stringify({ ...payload, transcript_path: null }) });
  assert.equal(x.code, 0, x.stderr);
  assert.match(x.stdout, /^이 프로젝트\(acme\)/);
  assert.match(x.stdout, /## project\.md/);
  assert.match(x.stdout, /\n## decisions\/ \(index\)\n/);
  assert.equal(x.stdout, out.hookSpecificOutput.additionalContext + "\n", "codex gets the same context as plain text");

  const capped = run(["session-start", "--tool", "codex"], { env: { ...env, MEMMEM_CONTEXT_MAX_CHARS: "1500" }, input: JSON.stringify(payload) });
  assert.equal(capped.code, 0, capped.stderr);
  assert.ok(capped.stdout.length < x.stdout.length, "MEMMEM_CONTEXT_MAX_CHARS honored");
  assert.match(capped.stdout, /잘림/);

  const none = run(["session-start"], { env, input: JSON.stringify({ ...payload, cwd: root }) });
  assert.equal(none.code, 0);
  assert.equal(none.stdout, "");
});

test("session-start notice: done once, waiting_for_answer and failed every session; language from config", async () => {
  const { initNotice } = await import("../lib/hooks.mjs");
  const done = { state: "done", initializedBy: ["alice"], members: { alice: {} }, lastRun: { initId: "i1", kind: "project_init", requestedBy: ["alice"], commits: ["a", "b"] } };
  const a = initNotice(done, undefined, { member: "alice", language: "ko" });
  assert.equal(a.text, "팀 메모리 초기화가 완료되었습니다 (2 commits, by alice).");
  assert.deepEqual(a.seen, { initId: "i1", state: "done" });
  assert.deepEqual(initNotice(done, a.seen, { member: "alice" }), { text: "", seen: null }, "done shows once");
  assert.match(initNotice(done, undefined, { member: "dave", tool: "codex" }).text, /^Team memory initialization finished \(2 commits, by alice\)\. Your past sessions are not in it yet: \$memmem-init adds them\.$/);
  assert.equal(initNotice({ ...done, lastRun: { initId: "i2", kind: "contribute", requestedBy: ["minji"], commits: ["c"] } }, a.seen, { member: "alice" }).text, "Team memory: past sessions of minji were added (1 commit).");
  const w = { state: "waiting_for_answer", lastRun: { initId: "i3", question: "Which DB\nis canonical?" } };
  const w1 = initNotice(w, undefined, {});
  assert.match(w1.text, /"Which DB is canonical\?" Ask the user, then run `memmem init --answer "<text>"`/);
  assert.equal(initNotice(w, w1.seen, {}).text, w1.text, "sticky");
  assert.equal(initNotice({ state: "failed", error: "clone failed" }, { state: "failed" }, { language: "ko" }).text, "팀 메모리 초기화가 실패했습니다: clone failed. 자세한 내용: `memmem status`.");
  assert.deepEqual(initNotice({ state: "running" }, undefined, {}).text, "");
  assert.deepEqual(initNotice(null, undefined, {}), { text: "", seen: null });

  // Through the hook: status.json pushed by the server, read from the transcripts clone after a fetch.
  const root = tmpDir();
  const env = isolatedEnv(path.join(root, "home"));
  fs.mkdirSync(env.HOME);
  const memoryBare = makeBareRepo(path.join(root, "memory.git"), TEMPLATE, env);
  const transcriptsBare = makeBareRepo(path.join(root, "transcripts.git"), path.join(REPO_DIR, "templates", "transcripts-repo"), env);
  const proj = path.join(root, "app");
  fs.mkdirSync(proj);
  const s = run(["setup", "--project", "acme", "--memory-repo", memoryBare, "--transcripts-repo", transcriptsBare, "--member", "alice", "--language", "ko"], { env, cwd: proj });
  assert.equal(s.code, 0, s.stderr + s.stdout);
  const work = path.join(root, "server-work");
  sh("git", ["clone", "--quiet", transcriptsBare, work], { env });
  const publish = (status) => {
    fs.mkdirSync(path.join(work, "bootstrap"), { recursive: true });
    fs.writeFileSync(path.join(work, "bootstrap", "status.json"), JSON.stringify(status));
    sh("git", ["add", "-A"], { cwd: work, env });
    sh("git", ["commit", "--quiet", "-m", "status"], { cwd: work, env });
    sh("git", ["push", "--quiet", "origin", "HEAD:main"], { cwd: work, env });
  };
  const start = () => {
    const r = run(["session-start", "--tool", "codex"], { env, input: JSON.stringify({ session_id: "s", cwd: proj, hook_event_name: "SessionStart" }) });
    assert.equal(r.code, 0, r.stderr);
    return r.stdout;
  };
  assert.match(start(), /^이 프로젝트\(acme\)/, "no status.json: no notice");
  publish({ state: "waiting_for_answer", initId: "i1", updatedAt: "u1", question: "Which DB?" });
  for (let i = 0; i < 2; i++) assert.match(start(), /^메모리 서버가 팀 메모리 초기화를 마치려면 답이 필요합니다: "Which DB\?" .*\n\n이 프로젝트\(acme\)/);
  publish({ ...done, members: { alice: { kind: "project_init", sessions: 2 } }, lastRun: { ...done.lastRun, requestedBy: ["alice"] } });
  assert.match(start(), /^팀 메모리 초기화가 완료되었습니다 \(2 commits, by alice\)\.\n\n이 프로젝트/);
  assert.match(start(), /^이 프로젝트\(acme\)/, "done is shown once");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(proj, ".memmem", "local.json"), "utf8")).lastSeenInit, { initId: "i1", state: "done" });
});
