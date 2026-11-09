import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { discoverSessions, headCwd, insideProject, sessionHash, storeRoots, summarize } from "../lib/history.mjs";
import { buildRequest, codeSummary, mergeManifest, normalizeAnswers, QUESTIONS, runInit } from "../lib/init.mjs";
import { scriptedPrompter } from "../lib/prompt.mjs";
import { VERSION } from "../lib/runtime.mjs";
import { CLAUDE_FIXTURE, CODEX_FIXTURE, isolatedEnv, lsTree, makeBareRepo, makeProject, REPO_DIR, run, sh, showFile, tmpDir } from "./helpers.mjs";

const SECRET = "ghp_" + "A".repeat(36);
const CLAUDE_ID = "11111111-2222-4333-8444-555555555555";

/** Fixture session stores under a fake HOME: two sessions in the project, one elsewhere. */
function stores(home, proj) {
  const cdir = path.join(home, ".claude", "projects", "-work-acme");
  fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, `${CLAUDE_ID}.jsonl`), fs.readFileSync(CLAUDE_FIXTURE, "utf8").replaceAll("/home/dev/acme-app", proj));
  const other = path.join(home, ".claude", "projects", "-elsewhere");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, "99999999-2222-4333-8444-555555555555.jsonl"),
    fs.readFileSync(CLAUDE_FIXTURE, "utf8").replaceAll("/home/dev/acme-app", `${proj}-other`).replaceAll(CLAUDE_ID, "99999999-2222-4333-8444-555555555555"));
  const xdir = path.join(home, ".codex", "sessions", "2026", "11", "06");
  fs.mkdirSync(xdir, { recursive: true });
  fs.writeFileSync(path.join(xdir, "rollout-2026-11-06T02-00-00-019a0000-aaaa-7bbb-8ccc-dddddddddddd.jsonl"),
    fs.readFileSync(CODEX_FIXTURE, "utf8").replaceAll("/home/dev/acme-app", path.join(proj, "sub")).replace("List the migration files.", `List the migration files. token ${SECRET}`));
}

function world() {
  const root = tmpDir();
  const env = isolatedEnv(path.join(root, "home"));
  fs.mkdirSync(env.HOME);
  const memoryBare = makeBareRepo(path.join(root, "mem.git"), path.join(REPO_DIR, "templates", "memory-repo", "ko"), env);
  const transcriptsBare = makeBareRepo(path.join(root, "tr.git"), path.join(REPO_DIR, "templates", "transcripts-repo"), env);
  const proj = makeProject(root, { memoryBare, transcriptsBare, extra: { language: "en", layoutVersion: 1 } });
  sh("git", ["init", "--quiet", "-b", "main", proj], { env });
  sh("git", ["remote", "add", "origin", "https://bob:s3cret@github.com/acme/app.git"], { cwd: proj, env });
  fs.writeFileSync(path.join(proj, "README.md"), "app\n");
  sh("git", ["add", "README.md"], { cwd: proj, env });
  sh("git", ["commit", "--quiet", "-m", "first commit"], { cwd: proj, env });
  stores(env.HOME, fs.realpathSync(proj));
  return { root, env, proj, memoryBare, transcriptsBare };
}

test("history: store roots honour CLAUDE_CONFIG_DIR / CODEX_HOME; cwd matching uses a directory boundary", () => {
  assert.deepEqual(storeRoots({ env: {}, homedir: "/h" }), { "claude-code": "/h/.claude/projects", codex: "/h/.codex/sessions" });
  assert.deepEqual(storeRoots({ env: { CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "/x" }, homedir: "/h" }), { "claude-code": "/c/projects", codex: "/x/sessions" });
  assert.equal(insideProject("/w/acme", "/w/acme"), true);
  assert.equal(insideProject("/w/acme/src", "/w/acme"), true);
  assert.equal(insideProject("/w/acme-other", "/w/acme"), false);
  assert.equal(insideProject(null, "/w/acme"), false);
  assert.equal(headCwd(CODEX_FIXTURE), "/home/dev/acme-app");
  assert.equal(headCwd(CLAUDE_FIXTURE), "/home/dev/acme-app");
  assert.equal(sessionHash("codex", "x"), sessionHash("codex", "x"));
  assert.equal(sessionHash("codex", "x").length, 10);
});

test("history: discoverSessions finds only this project's sessions, normalized and redacted", async () => {
  const w = world();
  const d = await discoverSessions({ projectDir: w.proj, roots: storeRoots({ env: {}, homedir: w.env.HOME }), homedir: w.env.HOME });
  assert.deepEqual(d.sessions.map((s) => s.source), ["claude-code", "codex"]);
  assert.deepEqual(d.sources, { "claude-code": { discovered: 1, exported: 1 }, codex: { discovered: 1, exported: 1 } });
  const [c, x] = d.sessions;
  assert.equal(c.id, CLAUDE_ID);
  assert.equal(c.sessionId, sessionHash("claude-code", CLAUDE_ID));
  assert.equal(c.file, `claude-code/2026-11-06T01-23-45_${c.sessionId}.json`);
  assert.ok(c.sourcePath.startsWith("~/.claude/projects/"), "home is abbreviated");
  for (const k of ["project", "startedAt", "endedAt", "userMessages", "assistantMessages", "toolCalls", "reasoningRecords", "firstUserPrompt", "records", "bytes", "diagnostics"]) assert.ok(k in c, k);
  assert.equal(x.redactions, 1);
  assert.ok(!x.json.includes(SECRET) && x.json.includes("[REDACTED:github_token]"));
  assert.ok(Array.isArray(JSON.parse(x.json)), "session files are plain record arrays, like Letta's export");
  const sum = summarize(d);
  assert.equal(sum.total.sessions, 2);
  assert.equal(sum.total.redactions, 1);
  assert.equal(sum.total.bytes, c.bytes + x.bytes);
});

test("init --dry-run: plan with counts per tool, bytes, redactions, and the request; writes nothing", () => {
  const w = world();
  const r = run(["init", "--dry-run", "--depth", "deep"], { env: w.env, cwd: w.proj });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /past sessions of this project on this machine: 2 \(.* KB, 1 redaction\(s\)\)/);
  assert.match(r.stdout, /claude-code: 1 session\(s\)/);
  assert.match(r.stdout, /codex: 1 session\(s\), .*, 1 redaction\(s\)/);
  assert.match(r.stdout, /sessions would NOT be uploaded/);
  const req = JSON.parse(r.stdout.slice(r.stdout.indexOf("{\n")));
  assert.equal(req.answers.depth, "deep");
  assert.equal(req.answers.history, false);
  assert.equal(req.codeRepo, "https://github.com/acme/app.git", "credentials stripped");
  assert.ok(!fs.existsSync(path.join(w.env.HOME, ".local", "share", "memmem", "acme", "transcripts")), "no clone, nothing written");
  assert.ok(!r.stdout.includes(SECRET));
});

test("init: request + sessions pushed under bootstrap/<member>/ only with --history yes; --answer appends", () => {
  const w = world();
  const r = run(["init", "--yes", "--depth", "deep", "--repos", "acme/api, acme/web", "--style", "terse", "--history", "yes"], { env: w.env, cwd: w.proj });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /sent bootstrap\/alice\/request\.json and 2 new session\(s\), 0 already uploaded \(2 listed under bootstrap\/alice\)/);
  assert.match(r.stdout, /progress: memmem status/);
  assert.ok(r.stdout.includes(w.memoryBare), "memory repo URL printed");
  const tree = lsTree(w.transcriptsBare, w.env).filter((f) => f.startsWith("bootstrap/"));
  assert.equal(tree.length, 4, tree.join("\n"));
  const req = JSON.parse(showFile(w.transcriptsBare, "bootstrap/alice/request.json", w.env));
  assert.deepEqual(Object.keys(req).sort(), ["answers", "codeRepo", "codeSummary", "historyOnly", "language", "layoutVersion", "member", "memmemVersion", "project", "requestedAt", "sessions"]);
  assert.deepEqual(req.answers, { depth: "deep", repos: ["acme/api", "acme/web"], style: "terse", history: true });
  assert.equal(req.layoutVersion, 1);
  assert.equal(req.memmemVersion, VERSION);
  assert.equal(req.sessions, 2);
  assert.equal(req.codeSummary.branch, "main");
  assert.match(req.codeSummary.log, /first commit/);
  const man = JSON.parse(showFile(w.transcriptsBare, "bootstrap/alice/manifest.json", w.env));
  assert.deepEqual(Object.keys(man).sort(), ["errors", "generatedAt", "member", "outDir", "sessions", "sources", "version"]);
  assert.equal(man.outDir, "bootstrap/alice");
  assert.equal(man.sessions.length, 2);
  for (const s of man.sessions) {
    assert.ok(!("json" in s));
    assert.ok(Array.isArray(JSON.parse(showFile(w.transcriptsBare, `bootstrap/alice/${s.file}`, w.env))));
  }
  assert.ok(!showFile(w.transcriptsBare, `bootstrap/alice/${man.sessions[1].file}`, w.env).includes(SECRET));

  // A new request without consent replaces the request, uploads nothing, and leaves the uploaded sessions (other devices' too) in place.
  const again = run(["init", "--yes"], { env: w.env, cwd: w.proj });
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /sent bootstrap\/alice\/request\.json to /);
  assert.deepEqual(lsTree(w.transcriptsBare, w.env).filter((f) => f.startsWith("bootstrap/")), tree);
  const req2 = JSON.parse(showFile(w.transcriptsBare, "bootstrap/alice/request.json", w.env));
  assert.deepEqual(req2.answers, { depth: "standard", repos: [], style: "", history: false });
  assert.equal(req2.sessions, 0);

  const a = run(["init", "--answer", "Use the staging DB, not prod."], { env: w.env, cwd: w.proj });
  assert.equal(a.code, 0, a.stderr);
  const b = run(["init", "--answer", "second"], { env: w.env, cwd: w.proj });
  assert.equal(b.code, 0, b.stderr);
  assert.match(showFile(w.transcriptsBare, "bootstrap/alice/answer-1.md", w.env), /Use the staging DB/);
  assert.match(showFile(w.transcriptsBare, "bootstrap/alice/answer-2.md", w.env), /second/);

  const ho = run(["init", "--history-only", "--yes"], { env: w.env, cwd: w.proj });
  assert.equal(ho.code, 2);
  assert.match(ho.stderr, /--history-only needs --history yes/);
  const ho2 = run(["init", "--history-only", "--history", "yes", "--yes"], { env: w.env, cwd: w.proj });
  assert.equal(ho2.code, 0, ho2.stderr);
  const req3 = JSON.parse(showFile(w.transcriptsBare, "bootstrap/alice/request.json", w.env));
  assert.equal(req3.historyOnly, true);
  assert.equal(req3.codeSummary, null);
  assert.deepEqual(req3.answers, { history: true });
});

test("init: interactive questions in the project language; consent prompt shows the dry-run summary", async () => {
  const w = world();
  const cfgFile = path.join(w.proj, ".memmem", "config.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, "utf8")), language: "ko" }));
  const p = scriptedPrompter(["deep", "none", "short", "no"]);
  const out = { s: "", write(x) { this.s += x; } };
  const prev = { HOME: process.env.HOME, cwd: process.cwd() };
  process.env.HOME = w.env.HOME;
  try {
    const rc = await runInit({ cwd: w.proj, dryRun: true }, { out, err: out, prompter: p,
      discover: () => discoverSessions({ projectDir: w.proj, roots: storeRoots({ env: {}, homedir: w.env.HOME }), homedir: w.env.HOME }) });
    assert.equal(rc, 0, out.s);
  } finally { process.env.HOME = prev.HOME; }
  assert.equal(p.asked[0], QUESTIONS.ko.depth);
  assert.match(p.asked[3], /^이 프로젝트의 과거 세션 1 claude-code \+ 1 codex session\(s\), .*1 redaction\(s\)을 분석용으로 올릴까요/);
  const req = JSON.parse(out.s.slice(out.s.indexOf("{\n")));
  assert.deepEqual(req.answers, { depth: "deep", repos: [], style: "short", history: false });
});

test("init: answers normalization, request shape, code summary", () => {
  assert.deepEqual(normalizeAnswers({}).answers, { depth: "standard", repos: [], style: "", history: false }, "--yes defaults never consent");
  assert.equal(normalizeAnswers({ depth: "huge" }).error, "--depth must be standard or deep");
  assert.equal(normalizeAnswers({ history: "maybe" }).error, "--history must be yes or no");
  assert.deepEqual(normalizeAnswers({ repos: "none", style: "none", history: "y" }).answers, { depth: "standard", repos: [], style: "", history: true });
  const fake = (args) => ({ ok: true, stdout: { "rev-parse": "dev", status: " M a.ts", log: "abc fix", shortlog: Array.from({ length: 8 }, (_, i) => `${i}\tp${i}`).join("\n"), remote: "https://x:y@github.com/o/r.git" }[args[0]] ?? "" });
  const s = codeSummary("/tmp", fake);
  assert.deepEqual(s, { branch: "dev", status: " M a.ts", log: "abc fix", shortlog: "0\tp0\n1\tp1\n2\tp2\n3\tp3\n4\tp4", remote: "https://github.com/o/r.git" });
  const req = buildRequest({ answers: { depth: "standard", repos: [], style: "", history: false }, summary: s, member: "alice", project: "acme", language: "en", historyOnly: false, sessions: 0, now: new Date("2026-11-06T00:00:00Z") });
  assert.deepEqual(req, { layoutVersion: 1, memmemVersion: VERSION, requestedAt: "2026-11-06T00:00:00.000Z", project: "acme", member: "alice", language: "en", historyOnly: false,
    answers: { depth: "standard", repos: [], style: "", history: false }, codeRepo: "https://github.com/o/r.git", codeSummary: s, sessions: 0 });
});

test("init: outside a team project", () => {
  const dir = tmpDir();
  const r = run(["init", "--dry-run"], { env: isolatedEnv(dir), cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not a team project/);
});

test("init --state: JSON with projectInit (old and multi-member status.json) and local session counts; --reinit", () => {
  const w = world();
  const st = run(["init", "--state"], { env: w.env, cwd: w.proj });
  assert.equal(st.code, 0, st.stderr);
  const s0 = JSON.parse(st.stdout);
  assert.deepEqual(Object.keys(s0), ["project", "member", "projectInit", "localSessions", "pulled"]);
  assert.equal(s0.member, "alice");
  assert.deepEqual(s0.projectInit, { state: "not_requested", initialized: false, depth: null, initializedBy: [], initializedAt: null, myContribution: { state: "not_reflected" } });
  assert.deepEqual(s0.localSessions.byTool, { "claude-code": 1, codex: 1 });
  assert.equal(s0.localSessions.total, 2);
  assert.ok(!st.stdout.includes(SECRET));

  // The server finished a project init by bob; alice has not contributed yet.
  const work = path.join(w.root, "server-work");
  sh("git", ["clone", "--quiet", w.transcriptsBare, work], { env: w.env });
  fs.mkdirSync(path.join(work, "bootstrap"), { recursive: true });
  fs.writeFileSync(path.join(work, "bootstrap", "status.json"), JSON.stringify({ state: "done", depth: "standard", initializedAt: "2026-11-06T07:00:00Z", initializedBy: ["bob"],
    members: { bob: { kind: "project_init", sessions: 6, finishedAt: "2026-11-06T07:00:00Z", initId: "i1", state: "done" } }, lastRun: { initId: "i1", kind: "project_init", requestedBy: ["bob"], commits: ["a"] } }));
  sh("git", ["add", "-A"], { cwd: work, env: w.env });
  sh("git", ["commit", "--quiet", "-m", "status"], { cwd: work, env: w.env });
  sh("git", ["push", "--quiet", "origin", "HEAD:main"], { cwd: work, env: w.env });
  const s1 = JSON.parse(run(["init", "--state"], { env: w.env, cwd: w.proj }).stdout);
  assert.equal(s1.pulled, true);
  assert.deepEqual([s1.projectInit.state, s1.projectInit.initialized, s1.projectInit.depth, s1.projectInit.initializedBy, s1.projectInit.myContribution.state],
    ["done", true, "standard", ["bob"], "not_reflected"]);

  // --reinit marks the request; --history-only keeps style/repos flags; the two exclude each other.
  const r = run(["init", "--yes", "--reinit"], { env: w.env, cwd: w.proj });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(showFile(w.transcriptsBare, "bootstrap/alice/request.json", w.env)).reinit, true);
  const x = run(["init", "--yes", "--reinit", "--history-only", "--history", "yes"], { env: w.env, cwd: w.proj });
  assert.equal(x.code, 2);
  assert.match(x.stderr, /--reinit and --history-only exclude each other/);
  const ho = run(["init", "--yes", "--history-only", "--history", "yes", "--style", "terse, Korean", "--repos", "acme/api"], { env: w.env, cwd: w.proj });
  assert.equal(ho.code, 0, ho.stderr);
  const req = JSON.parse(showFile(w.transcriptsBare, "bootstrap/alice/request.json", w.env));
  assert.deepEqual(req.answers, { history: true, style: "terse, Korean", repos: ["acme/api"] });
  assert.equal(req.historyOnly, true);
  assert.ok(!("reinit" in req));
  const s2 = JSON.parse(run(["init", "--state"], { env: w.env, cwd: w.proj }).stdout);
  assert.equal(s2.projectInit.myContribution.state, "requested");
});

test("init --state / status: aliases from members/<handle>.json; status.json with my entry under the alias", () => {
  const w = world();
  // alice used to be "al": her request and sessions sit under bootstrap/al/ and trajectories/.../al/.
  const work = path.join(w.root, "server-work");
  sh("git", ["clone", "--quiet", w.transcriptsBare, work], { env: w.env });
  const put = (rel, doc) => { fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true }); fs.writeFileSync(path.join(work, rel), typeof doc === "string" ? doc : JSON.stringify(doc)); };
  put("members/alice.json", { handle: "alice", displayName: "Alice", aliases: ["al"] });
  put("bootstrap/al/request.json", { requestedAt: "2026-11-06T11:45:39.726Z", member: "al", historyOnly: false, answers: { depth: "deep", history: true }, sessions: 4 });
  put("bootstrap/status.json", { state: "done", initId: "init-1", requestedBy: ["al"], requests: ["bootstrap/al/request.json"], startedAt: "2026-11-06T11:46:12.863Z",
    updatedAt: "2026-11-06T11:52:08.004Z", finishedAt: "2026-11-06T11:52:08.004Z", commits: [{ sha: "a" }], sessions: 4,
    depth: "deep", initializedAt: "2026-11-06T11:52:08.004Z", initializedBy: ["al"], repos: [],
    members: { al: { kind: "project_init", sessions: 4, finishedAt: "2026-11-06T11:52:08.004Z", initId: "init-1", state: "done" } },
    lastRun: { initId: "init-1", kind: "project_init", requestedBy: ["al"], state: "done", commits: [{ sha: "a" }] } });
  put("trajectories/2026-11/al/claude-code/x.json", "{}");
  put("ingest/log.jsonl", JSON.stringify({ event: "ingest", file: "trajectories/2026-11/al/claude-code/x.json", ts: "2026-11-06T12:00:00Z" }) + "\n");
  sh("git", ["add", "-A"], { cwd: work, env: w.env });
  sh("git", ["commit", "--quiet", "-m", "server init"], { cwd: work, env: w.env });
  sh("git", ["push", "--quiet", "origin", "HEAD:main"], { cwd: work, env: w.env });

  const st = run(["init", "--state"], { env: w.env, cwd: w.proj });
  assert.equal(st.code, 0, st.stderr);
  const p = JSON.parse(st.stdout).projectInit;
  assert.deepEqual([p.state, p.initialized, p.depth, p.initializedBy, p.initializedAt], ["done", true, "deep", ["al"], "2026-11-06T11:52:08.004Z"]);
  assert.deepEqual(p.myContribution, { state: "reflected", sessions: 4, kind: "project_init", finishedAt: "2026-11-06T11:52:08.004Z" });
  const s = run(["status"], { env: w.env, cwd: w.proj });
  assert.equal(s.code, 0, s.stderr);
  assert.match(s.stdout, /member alice, aliases al/);
  assert.match(s.stdout, /ingest: 1 session file\(s\) ingested, 0 skipped, 0 waiting/);
  assert.match(s.stdout, /\ninit: done \(deep, by al, 2026-11-06\), 1 commit\(s\)\n  my sessions: reflected \(4, project_init at 2026-11-06\)\n/);
  // MEMMEM_MEMBER still overrides the member; then members/<that>.json supplies the aliases (none here).
  const o = JSON.parse(run(["init", "--state"], { env: { ...w.env, MEMMEM_MEMBER: "bob" }, cwd: w.proj }).stdout);
  assert.equal(o.member, "bob");
  assert.equal(o.projectInit.myContribution.state, "not_reflected");
});

/** A second device's session store: one Claude session under `claudeId`, and (optionally) the same Codex rollout as stores(). */
function deviceStore(home, proj, { claudeId, codex = false }) {
  const cdir = path.join(home, ".claude", "projects", "-work-acme");
  fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, `${claudeId}.jsonl`), fs.readFileSync(CLAUDE_FIXTURE, "utf8").replaceAll("/home/dev/acme-app", proj).replaceAll(CLAUDE_ID, claudeId));
  if (codex) {
    const xdir = path.join(home, ".codex", "sessions", "2026", "11", "06");
    fs.mkdirSync(xdir, { recursive: true });
    fs.writeFileSync(path.join(xdir, "rollout-2026-11-06T02-00-00-019a0000-aaaa-7bbb-8ccc-dddddddddddd.jsonl"), fs.readFileSync(CODEX_FIXTURE, "utf8").replaceAll("/home/dev/acme-app", path.join(proj, "sub")));
  }
}

test("init on two devices: the manifest becomes the union by sessionId; sessions under an alias directory are not uploaded again", async () => {
  const w = world();
  const proj = fs.realpathSync(w.proj);
  const a = run(["init", "--yes", "--history", "yes"], { env: w.env, cwd: w.proj });
  assert.equal(a.code, 0, a.stderr);
  const manA = JSON.parse(showFile(w.transcriptsBare, "bootstrap/alice/manifest.json", w.env));
  assert.equal(manA.sessions.length, 2);

  // Device B: own HOME (session store, data root, transcripts clone); one new Claude session and the same Codex session.
  const envB = isolatedEnv(path.join(w.root, "homeB"));
  fs.mkdirSync(envB.HOME);
  deviceStore(envB.HOME, proj, { claudeId: "22222222-2222-4333-8444-555555555555", codex: true });
  const b = run(["init", "--yes", "--history", "yes"], { env: envB, cwd: w.proj });
  assert.equal(b.code, 0, b.stderr);
  assert.match(b.stdout, /and 1 new session\(s\), 1 already uploaded \(3 listed under bootstrap\/alice\)/);
  const man = JSON.parse(showFile(w.transcriptsBare, "bootstrap/alice/manifest.json", w.env));
  assert.equal(man.sessions.length, 3);
  assert.equal(new Set(man.sessions.map((s) => s.sessionId)).size, 3);
  assert.deepEqual(man.sources, { "claude-code": { discovered: 2, exported: 2 }, codex: { discovered: 1, exported: 1 } });
  for (const s of man.sessions) assert.ok(showFile(w.transcriptsBare, `bootstrap/alice/${s.file}`, w.env), s.file);
  assert.ok(manA.sessions.every((s) => man.sessions.some((x) => x.sessionId === s.sessionId && x.file === s.file)), "device A's entries kept");
  assert.equal(JSON.parse(showFile(w.transcriptsBare, "bootstrap/alice/request.json", w.env)).sessions, 3);
  // Device A again: nothing new.
  const a2 = run(["init", "--yes", "--history", "yes"], { env: w.env, cwd: w.proj });
  assert.equal(a2.code, 0, a2.stderr);
  assert.match(a2.stdout, /and 0 new session\(s\), 2 already uploaded \(3 listed/);

  // Device C: its session was uploaded earlier under the old handle "al" (an alias in members/alice.json).
  const envC = isolatedEnv(path.join(w.root, "homeC"));
  fs.mkdirSync(envC.HOME);
  deviceStore(envC.HOME, proj, { claudeId: "33333333-2222-4333-8444-555555555555" });
  const found = await discoverSessions({ projectDir: proj, roots: storeRoots({ env: envC, homedir: envC.HOME }), homedir: envC.HOME });
  assert.equal(found.sessions.length, 1);
  const seed = path.join(w.root, "seed");
  sh("git", ["clone", "--quiet", w.transcriptsBare, seed], { env: w.env });
  fs.mkdirSync(path.join(seed, "members"), { recursive: true });
  fs.writeFileSync(path.join(seed, "members", "alice.json"), JSON.stringify({ handle: "alice", gitAuthors: [], joinedAt: "2026-11-06T00:00:00Z", aliases: ["al"] }));
  const alDir = path.join(seed, "bootstrap", "al");
  fs.mkdirSync(path.join(alDir, "claude-code"), { recursive: true });
  const { json, ...meta } = found.sessions[0];
  fs.writeFileSync(path.join(alDir, meta.file), json);
  const alManifest = JSON.stringify({ version: 1, outDir: "bootstrap/al", member: "al", sources: {}, errors: [], sessions: [meta] }, null, 2) + "\n";
  fs.writeFileSync(path.join(alDir, "manifest.json"), alManifest);
  sh("git", ["add", "-A"], { cwd: seed, env: w.env });
  sh("git", ["commit", "--quiet", "-m", "old handle"], { cwd: seed, env: w.env });
  sh("git", ["push", "--quiet", "origin", "HEAD:main"], { cwd: seed, env: w.env });
  const c = run(["init", "--yes", "--history", "yes"], { env: envC, cwd: w.proj });
  assert.equal(c.code, 0, c.stderr);
  assert.match(c.stdout, /and 0 new session\(s\), 1 already uploaded \(3 listed/);
  assert.equal(JSON.parse(showFile(w.transcriptsBare, "bootstrap/alice/manifest.json", w.env)).sessions.length, 3);
  assert.equal(showFile(w.transcriptsBare, "bootstrap/al/manifest.json", w.env) + "\n", alManifest, "the alias directory is untouched");
});

test("mergeManifest: a larger copy of a known session replaces it; errors concatenated without duplicates", () => {
  const s = (id, bytes, file = `claude-code/2026-11-01T00-00-00_${id}.json`) => ({ source: "claude-code", sessionId: id, file, startedAt: "2026-11-01T00:00:00Z", bytes, json: "[]" });
  const strip = ({ json, ...m }) => m;
  const existing = { sessions: [strip(s("a", 100)), strip(s("b", 100))], errors: [{ source: "codex", error: "x" }], sources: {} };
  const m = mergeManifest(existing, { outDir: "bootstrap/alice", member: "alice", discovered: { sessions: [s("a", 50), s("b", 200, "claude-code/2026-11-01T00-00-00_b-v2.json"), s("c", 10)], errors: [{ source: "codex", error: "x" }, { source: "codex", sourcePath: "~/.codex/y.jsonl", error: "y" }], sources: {} }, aliasIds: new Set(["c"]) });
  assert.deepEqual(m.counts, { new: 0, updated: 1, already: 2 });
  assert.deepEqual(m.write.map((x) => x.file), ["claude-code/2026-11-01T00-00-00_b-v2.json"]);
  assert.deepEqual(m.remove, ["claude-code/2026-11-01T00-00-00_b.json"]);
  assert.deepEqual(m.manifest.sessions.map((x) => [x.sessionId, x.bytes]), [["a", 100], ["b", 200]]);
  assert.deepEqual(m.manifest.errors, [{ source: "codex", error: "x" }, { source: "codex", sourcePath: "~/.codex/y.jsonl", error: "y" }]);
  assert.deepEqual(m.manifest.sources, { "claude-code": { discovered: 2, exported: 2 }, codex: { discovered: 1, exported: 0 } });
});
