import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { doctorChecks, renderChecks } from "../lib/doctor.mjs";
import { buildStatus, memberOfFile, normalizeUsage, projectInitState, renderStatus, usageFromLog } from "../lib/status.mjs";
import { isolatedEnv, makeBareRepo, REPO_DIR, run, SELF_CMD, sh, tmpDir } from "./helpers.mjs";

const T = (m, member, f) => `trajectories/${m}/${member}/claude-code/${f}.json`;
const LOG = [
  { ts: "2026-11-06T01:00:00Z", event: "ingest", project: "acme", file: T("2026-11", "alice", "a1"), reflectionOutcome: "committed", reflectionCommit: "abcdef1234567" },
  { ts: "2026-11-06T01:05:00Z", event: "ingest", project: "acme", file: T("2026-11", "bob", "b1") },
  { ts: "2026-11-06T01:06:00Z", event: "skip", project: "acme", file: T("2026-11", "alice", "a2"), error: "too large" },
  { ts: "2026-11-06T02:00:00Z", event: "reflection", project: "acme", outcome: "committed", reflectionCommit: "fedcba9876543", files: [] },
  { ts: "2026-11-06T02:00:01Z", event: "reflection", project: "acme", outcome: "nothing_to_save", carriedForward: true },
  { ts: "2026-11-06T03:00:00Z", event: "ingest", project: "acme", file: T("2026-11", "alice", "a3") },
];

test("status: usage (7d) line from log entries that carry usage; skipped when none do", () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  const n = (input, cacheRead, costUsd = null) => ({ input, output: 100, cacheRead, cacheWrite: 0, reasoning: 0, total: input + 100 + cacheRead, costUsd });
  const log = [
    { ts: "2026-10-20T00:00:00Z", event: "ingest", file: T("2026-10", "bob", "old"), parts: 1, usage: n(50_000, 0) }, // older than 7 days
    { ts: "2026-11-05T01:00:00Z", event: "ingest", file: T("2026-11", "bob", "b1"), parts: 2, usage: { promptTokens: 30_000, completionTokens: 200, totalTokens: 30_200 } }, // old raw shape
    { ts: "2026-11-06T01:00:00Z", event: "ingest", file: T("2026-11", "alice", "a1"), parts: 1, usage: n(20_000, 0) },
    { ts: "2026-11-06T01:01:00Z", event: "ingest", file: T("2026-11", "alice", "a2") }, // no usage
    { ts: "2026-11-06T02:00:00Z", event: "reflection", outcome: "committed", usage: n(13_000, 39_000, 0.07) },
    { ts: "2026-11-06T02:00:01Z", event: "reflection", outcome: "committed", carriedForward: true, usage: n(13_000, 39_000, 0.07) }, // same run
    { ts: "2026-11-06T03:00:00Z", event: "reflection", outcome: "failed" }, // no usage: not counted
    { ts: "2026-11-06T04:00:00Z", event: "init", initId: "init-1", state: "waiting_for_answer", usage: n(100_000, 0) },
    { ts: "2026-11-06T05:00:00Z", event: "init", initId: "init-1", state: "done", usage: n(400_000, 800_000) }, // running total of the same run
    { ts: "2026-11-06T06:00:00Z", event: "skip", file: "x" },
  ];
  const u = usageFromLog(log, { now });
  assert.deepEqual(u.ingest, { turns: 3, total: 50_300, cacheRead: 0, costUsd: null });
  assert.deepEqual(u.reflection, { turns: 1, total: 52_100, cacheRead: 39_000, costUsd: 0.07 });
  assert.deepEqual(u.init, { turns: 1, total: 1_200_100, cacheRead: 800_000, costUsd: null });
  const s = buildStatus({ project: "acme", member: "alice", log, initStatus: null, request: null, now });
  assert.deepEqual(s.usage, u);
  assert.match(renderStatus(s), /\nusage \(7d\): ingest 3 turns \/ 50\.3k tokens · reflection 1 \/ 52\.1k · init 1 \/ 1\.2M \(≈\$0\.07\)\n/);
  // No entry with usage (an older server): no line.
  const none = buildStatus({ project: "acme", member: "alice", log: LOG, initStatus: null, request: null, now });
  assert.equal(none.usage, null);
  assert.doesNotMatch(renderStatus(none), /usage/);
  assert.equal(normalizeUsage({ durationMs: 3 }), null);
  assert.equal(normalizeUsage({ promptTokens: 10, completionTokens: 2 }).total, 12);
});

test("status: member attribution from repo paths", () => {
  assert.equal(memberOfFile("trajectories/2026-11/alice/codex/x.json"), "alice");
  assert.equal(memberOfFile("inbox/bob/2026-11-06-x.md"), "bob");
  assert.equal(memberOfFile("bootstrap/carol/request.json"), "carol");
  assert.equal(memberOfFile("ingest/log.jsonl"), null);
});

test("status: counts for my member, last reflection, init states, pending question", () => {
  const myFiles = [T("2026-11", "alice", "a1"), T("2026-11", "alice", "a2"), T("2026-11", "alice", "a3"), T("2026-11", "alice", "a4")];
  const s = buildStatus({ project: "acme", member: "alice", log: LOG, initStatus: null, request: null, myFiles, memoryCommits: ["1a2b3c4 2026-11-06 decisions: stripe"] });
  assert.deepEqual(s.ingest, { ingested: 2, skipped: 1, waiting: 1, lastIngestAt: "2026-11-06T03:00:00Z", lastSkip: { file: T("2026-11", "alice", "a2"), error: "too large", ts: "2026-11-06T01:06:00Z" } });
  assert.deepEqual(s.reflection, { outcome: "committed", commit: "fedcba9876543", ts: "2026-11-06T02:00:00Z" });
  assert.equal(s.myLastReflection.commit, "abcdef1234567");
  assert.deepEqual(s.init, { state: "not_requested" });
  const text = renderStatus(s);
  assert.match(text, /^project acme \(member alice\)\n/);
  assert.match(text, /ingest: 2 session file\(s\) ingested, 1 skipped, 1 waiting \(last 2026-11-06T03:00:00Z\)/);
  assert.match(text, /last skip: .*a2\.json: too large/);
  assert.match(text, /reflection: committed fedcba9876 at 2026-11-06T02:00:00Z/);
  assert.match(text, /init: not requested \(run `memmem init`\)/);
  assert.match(text, /memory repo:\n  1a2b3c4 2026-11-06 decisions: stripe/);

  const requested = buildStatus({ project: "acme", member: "alice", log: [], initStatus: null, request: { requestedAt: "2026-11-06T04:00:00Z" } });
  assert.match(renderStatus(requested), /init: requested at 2026-11-06T04:00:00Z; the server has not picked up the request yet/);
  assert.match(renderStatus(requested), /reflection: none yet/);

  const waiting = buildStatus({ project: "acme", member: "alice", log: [], request: null,
    initStatus: { state: "waiting_for_answer", question: "Which DB is canonical?", updatedAt: "2026-11-06T05:00:00Z", serverVersion: "0.2.0", commits: ["a", "b"] } });
  const wt = renderStatus(waiting);
  assert.match(wt, /server 0\.2\.0/);
  assert.match(wt, /init: waiting_for_answer \(updated 2026-11-06T05:00:00Z\), 2 commit\(s\)/);
  assert.match(wt, /question: Which DB is canonical\?\n  answer with: memmem init --answer "<text>"/);
  const failed = renderStatus(buildStatus({ project: "acme", member: "alice", log: [], initStatus: { state: "failed", error: "clone failed", updatedAt: "x" } }));
  assert.match(failed, /init: failed .*\n  error: clone failed/);
  assert.equal(buildStatus({ project: "a", member: "b", log: [], initStatus: { state: "weird" } }).init.state, "unknown");
});

test("status command: pulls the transcripts repo and reads ingest/log.jsonl + bootstrap/status.json", () => {
  const root = tmpDir();
  const env = isolatedEnv(path.join(root, "home"));
  fs.mkdirSync(env.HOME);
  const seed = path.join(root, "seed");
  fs.cpSync(path.join(REPO_DIR, "templates", "transcripts-repo"), seed, { recursive: true });
  fs.mkdirSync(path.join(seed, "ingest"), { recursive: true });
  fs.writeFileSync(path.join(seed, "ingest", "log.jsonl"), LOG.map((e) => JSON.stringify(e)).join("\n") + "\nnot json\n");
  fs.mkdirSync(path.join(seed, "bootstrap"), { recursive: true });
  fs.writeFileSync(path.join(seed, "bootstrap", "status.json"), JSON.stringify({ state: "running", updatedAt: "2026-11-06T06:00:00Z" }));
  const tr = makeBareRepo(path.join(root, "tr.git"), seed, env);
  const mem = makeBareRepo(path.join(root, "mem.git"), path.join(REPO_DIR, "templates", "memory-repo", "en"), env);
  const proj = path.join(root, "app");
  fs.mkdirSync(proj);
  sh("git", ["init", "--quiet", "-b", "main", proj], { env });
  assert.equal(run(["setup", "--project", "acme", "--memory-repo", mem, "--transcripts-repo", tr, "--member", "alice"], { env, cwd: proj }).code, 0);
  const r = run(["status"], { env, cwd: proj });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ingest: 2 session file\(s\) ingested, 1 skipped, 0 waiting/);
  assert.match(r.stdout, /init: running \(updated 2026-11-06T06:00:00Z\)/);
  assert.match(r.stdout, /memory repo:\n  [0-9a-f]+ \d{4}-\d\d-\d\d seed/);
  const j = run(["status", "--json"], { env, cwd: proj });
  assert.equal(JSON.parse(j.stdout).init.state, "running");
  const w = run(["status", "--watch", "--json"], { env: { ...env, MEMMEM_STATUS_INTERVAL_MS: "10", MEMMEM_STATUS_ROUNDS: "2" }, cwd: proj });
  assert.equal(w.code, 0, w.stderr);
  assert.equal(w.stdout.trim().split("\n").length, 2, "two polls");
});

function doctorWorld() {
  const root = tmpDir();
  const env = isolatedEnv(path.join(root, "home"));
  fs.mkdirSync(env.HOME);
  const proj = path.join(root, "app");
  fs.mkdirSync(proj);
  sh("git", ["init", "--quiet", "-b", "main", proj], { env });
  const r = run(["setup", "--project", "acme", "--memory-repo", "o/m", "--transcripts-repo", "o/t", "--member", "alice", "--no-clone", "--shared"], { env, cwd: proj });
  assert.equal(r.code, 0, r.stderr);
  const pathBin = path.join(root, "bin");
  fs.mkdirSync(pathBin);
  fs.writeFileSync(path.join(pathBin, "memmem"), "#!/bin/sh\n", { mode: 0o755 });
  return { root, env, proj, pathBin };
}

const okRunner = (calls) => (cmd, args) => {
  calls?.push([cmd, ...args].join(" "));
  if (args[0] === "--version") return { ok: true, stdout: "git version 2.50.0" };
  if (args[0] === "config") return { ok: true, stdout: "!gh auth git-credential" };
  return { ok: true, stdout: "" };
};
const byName = (list, name) => list.filter((c) => c.name === name);

test("doctor: a fresh setup passes; network checks go through the injected runner", () => {
  const w = doctorWorld();
  const calls = [];
  const list = doctorChecks({ cwd: w.proj, runner: okRunner(calls), env: { ...w.env, PATH: w.pathBin } });
  const fails = list.filter((c) => c.status === "fail");
  assert.deepEqual(fails, []);
  assert.ok(calls.includes("git ls-remote --heads https://github.com/o/m.git"));
  assert.ok(calls.includes("git ls-remote --heads https://github.com/o/t.git"));
  for (const n of ["git", "PATH", "config", "layoutVersion", "language", "member", "credential helper", "memory repo", "transcripts repo", "data dir", "claude hooks (shared)", "claude hooks (local)", "codex hooks", "AGENTS.md", "codex trust"]) {
    assert.ok(byName(list, n).length, `check ${n}`);
  }
  assert.equal(byName(list, "skill").filter((c) => c.status === "ok").length, 3);
  assert.match(byName(list, "claude hooks (local)")[0].detail, /PATH safety net/);
  assert.match(renderChecks(list), /^ok +memmem: /);
});

test("doctor: reports unreachable repos, PATH, layout, stale skills, broken local override", () => {
  const w = doctorWorld();
  const cfgFile = path.join(w.proj, ".memmem", "config.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, "utf8")), layoutVersion: 3 }));
  fs.writeFileSync(path.join(w.proj, ".claude", "skills", "memmem-init", "SKILL.md"), "old memmem skill");
  const local = path.join(w.proj, ".claude", "settings.local.json");
  fs.writeFileSync(local, fs.readFileSync(local, "utf8").replaceAll(SELF_CMD.split(" ")[0], "/nowhere/memmem"));
  const runner = (cmd, args) => (args[0] === "ls-remote" ? { ok: false, stderr: "fatal: could not read Username" } : okRunner()(cmd, args));
  const list = doctorChecks({ cwd: w.proj, runner, env: { ...w.env, PATH: path.join(w.root, "empty") } });
  const get = (n) => byName(list, n)[0];
  assert.equal(get("memory repo").status, "fail");
  assert.match(get("memory repo").detail, /could not read Username/);
  assert.equal(get("PATH").status, "warn");
  assert.equal(get("layoutVersion").status, "fail");
  assert.equal(get("claude hooks (local)").status, "fail");
  assert.match(get("claude hooks (local)").detail, /\/nowhere\/memmem/);
  assert.ok(byName(list, "skill").some((c) => c.status === "warn" && /memmem-init.*out of date/.test(c.detail)));
  const r = run(["doctor"], { env: { ...w.env, PATH: process.env.PATH }, cwd: path.join(w.root) });
  assert.equal(r.code, 1, "no config here");
  assert.match(r.stdout, /FAIL {2}config: no \.memmem\/config\.json/);
});

const NEW_DONE = {
  state: "done", depth: "standard", initializedAt: "2026-11-06T07:00:00Z", initializedBy: ["alice-old"],
  members: {
    "alice-old": { kind: "project_init", sessions: 6, finishedAt: "2026-11-06T07:00:00Z", initId: "i1", state: "done" },
    minji: { kind: "contribute", sessions: 14, finishedAt: "2026-11-06T09:00:00Z", initId: "i2", state: "done" },
  },
  lastRun: { initId: "i2", kind: "contribute", requestedBy: ["minji"], commits: ["c1", "c2", "c3"] },
};

test("status: multi-member status.json (my contribution, by whom, depth); a partial status degrades", () => {
  const mine = buildStatus({ project: "acme", member: "minji", log: [], initStatus: NEW_DONE, request: null });
  assert.deepEqual(mine.projectInit, {
    state: "done", initialized: true, depth: "standard", initializedBy: ["alice-old"], initializedAt: "2026-11-06T07:00:00Z",
    myContribution: { state: "reflected", sessions: 14, kind: "contribute", finishedAt: "2026-11-06T09:00:00Z" },
    commits: 3, lastRun: { initId: "i2", kind: "contribute", requestedBy: ["minji"] },
  });
  const t = renderStatus(mine);
  assert.match(t, /\ninit: done \(standard, by alice-old, 2026-11-06\), 3 commit\(s\)\n  my sessions: reflected \(14, contribute at 2026-11-06\)\n/);
  const other = renderStatus(buildStatus({ project: "acme", member: "dave", log: [], initStatus: NEW_DONE, request: null }));
  assert.match(other, /my sessions: not reflected \(run \/memmem-init or memmem init --history-only --history yes\)/);
  const pending = buildStatus({ project: "acme", member: "dave", log: [], initStatus: NEW_DONE, request: { requestedAt: "2026-11-06T10:00:00Z" } });
  assert.equal(pending.projectInit.myContribution.state, "requested");
  assert.match(renderStatus(pending), /my sessions: requested at 2026-11-06T10:00:00Z \(waiting for the server\)/);
  // A contribution running after the project init: still "initialized".
  const running = buildStatus({ project: "acme", member: "dave", log: [], request: null,
    initStatus: { ...NEW_DONE, state: "running", members: { ...NEW_DONE.members, dave: { kind: "contribute", state: "running" } }, lastRun: { initId: "i3", kind: "contribute", requestedBy: ["dave"] } } });
  assert.equal(running.projectInit.initialized, true);
  const rt = renderStatus(running);
  assert.match(rt, /init: done \(standard, by alice-old, 2026-11-06\); now running \(contribute for dave\)/);
  assert.match(rt, /my sessions: running \(contribute\)/);
  // Waiting for an answer, new shape: question from lastRun.
  const wt = renderStatus(buildStatus({ project: "acme", member: "dave", log: [], request: null,
    initStatus: { state: "waiting_for_answer", updatedAt: "u", lastRun: { initId: "i1", kind: "project_init", question: "Which DB?" } } }));
  assert.match(wt, /init: waiting_for_answer \(updated u\)\n  question: Which DB\?\n  answer with: memmem init --answer "<text>"/);
  assert.doesNotMatch(wt, /my sessions/, "nothing about my sessions before the project is initialized");
  // A status without depth/initializedBy/members (or with junk in them): defaults, no throw.
  const partial = buildStatus({ project: "acme", member: "alice", log: [], request: null, initStatus: { state: "done", updatedAt: "x", commits: ["a"] } });
  assert.deepEqual(partial.projectInit, { state: "done", initialized: true, depth: null, initializedBy: [], initializedAt: null, myContribution: { state: "not_reflected" }, commits: 1 });
  assert.match(renderStatus(partial), /init: done \(updated x\), 1 commit\(s\)\n  my sessions: not reflected/);
  const junk = buildStatus({ project: "acme", member: "alice", log: [], request: null, initStatus: { state: "bogus", members: "x", lastRun: 5, initializedBy: 7 } });
  assert.equal(junk.projectInit.state, "unknown");
  assert.equal(junk.projectInit.myContribution.state, "not_reflected");
  assert.deepEqual(junk.projectInit.initializedBy, []);
  assert.match(renderStatus(junk), /\ninit: unknown\n/);
  assert.deepEqual(buildStatus({ project: "a", member: "b", log: [], initStatus: null, request: null }).projectInit,
    { state: "not_requested", initialized: false, depth: null, initializedBy: [], initializedAt: null, myContribution: { state: "not_reflected" } });
});

test("doctor: member vs gh login, member registration", () => {
  const w = doctorWorld();
  const gh = path.join(w.root, "ghbin");
  fs.mkdirSync(gh);
  fs.writeFileSync(path.join(gh, "gh"), "#!/bin/sh\n", { mode: 0o755 });
  const runnerAs = (login) => (cmd, args) => (cmd === "gh" ? { ok: true, stdout: JSON.stringify({ login, name: null }) } : okRunner()(cmd, args));
  const env = { ...w.env, PATH: `${w.pathBin}:${gh}` };
  const mismatch = doctorChecks({ cwd: w.proj, runner: runnerAs("bob"), env });
  const g = byName(mismatch, "github login")[0];
  assert.equal(g.status, "warn");
  assert.match(g.detail, /member alice != gh login bob \(run `memmem setup --member bob --alias alice`\)/);
  assert.equal(byName(doctorChecks({ cwd: w.proj, runner: runnerAs("alice"), env }), "github login")[0].status, "ok");
  const noGh = doctorChecks({ cwd: w.proj, runner: okRunner(), env: { ...w.env, PATH: w.pathBin } });
  assert.deepEqual(byName(noGh, "github login"), [], "no gh on PATH: no check");
  const reg = byName(noGh, "member registration")[0];
  assert.equal(reg.status, "info");
  assert.match(reg.detail, /no members\/alice\.json .*run `memmem setup` to register/);
});

// As the server writes it after alice (then alice-old) ran the project init.
const ALIAS_DONE = {
  state: "done", project: "acme", initId: "init-20261106T114612Z", requestedBy: ["alice-old"], requests: ["bootstrap/alice-old/request.json"],
  startedAt: "2026-11-06T11:46:12.863Z", updatedAt: "2026-11-06T11:52:08.004Z", finishedAt: "2026-11-06T11:52:08.004Z",
  commits: [{ sha: "a" }, { sha: "b" }, { sha: "c" }], sessions: 6, serverVersion: "0.1.0",
  depth: "standard", initializedAt: "2026-11-06T11:52:08.004Z", initializedBy: ["alice-old"], repos: [],
  members: { "alice-old": { kind: "project_init", sessions: 6, finishedAt: "2026-11-06T11:52:08.004Z", initId: "init-20261106T114612Z", state: "done" } },
  lastRun: { initId: "init-20261106T114612Z", kind: "project_init", requestedBy: ["alice-old"], state: "done", commits: [{ sha: "a" }, { sha: "b" }, { sha: "c" }] },
};
const ALIAS_REQ = { requestedAt: "2026-11-06T11:45:39.726Z", member: "alice-old", historyOnly: false, answers: { depth: "standard", history: true }, sessions: 6 };

test("status: status.json with my entry under an alias: reflected; without the alias someone else's", () => {
  const s = buildStatus({ project: "acme", member: "alice", aliases: ["alice-old"], log: [], initStatus: ALIAS_DONE, request: ALIAS_REQ });
  assert.deepEqual(s.projectInit, {
    state: "done", initialized: true, depth: "standard", initializedBy: ["alice-old"], initializedAt: ALIAS_DONE.initializedAt,
    myContribution: { state: "reflected", sessions: 6, kind: "project_init", finishedAt: ALIAS_DONE.finishedAt }, commits: 3,
    lastRun: { initId: ALIAS_DONE.initId, kind: "project_init", requestedBy: ["alice-old"] },
  });
  const t = renderStatus(s);
  assert.match(t, /^project acme \(member alice, aliases alice-old\)/);
  assert.match(t, /\ninit: done \(standard, by alice-old, 2026-11-06\), 3 commit\(s\)\n  my sessions: reflected \(6, project_init at 2026-11-06\)\n/);
  // The same with my own handle; without the alias the entry is someone else's.
  assert.equal(projectInitState({ initStatus: ALIAS_DONE, request: ALIAS_REQ, member: "alice-old" }).myContribution.state, "reflected");
  const other = projectInitState({ initStatus: ALIAS_DONE, request: null, member: "alice" });
  assert.equal(other.myContribution.state, "not_reflected");
  assert.equal(other.depth, "standard");
  assert.deepEqual(other.initializedBy, ["alice-old"]);
  // A request with no entry of mine yet is still waiting.
  const waiting = projectInitState({ initStatus: ALIAS_DONE, request: { ...ALIAS_REQ, member: "bob", requestedAt: "2026-11-06T13:00:00Z" }, member: "bob" });
  assert.deepEqual(waiting.myContribution, { state: "requested", requestedAt: "2026-11-06T13:00:00Z" });
  // New shape keyed by the alias, and the ingest log / trajectories under the alias count as mine.
  const keyed = projectInitState({ initStatus: { ...NEW_DONE }, request: null, member: "alice", aliases: ["alice-old"] });
  assert.deepEqual(keyed.myContribution, { state: "reflected", sessions: 6, kind: "project_init", finishedAt: "2026-11-06T07:00:00Z" });
  const log = [
    { event: "ingest", file: "trajectories/2026-11/alice-old/claude-code/a.json", ts: "1" },
    { event: "ingest", file: "trajectories/2026-11/alice/codex/b.json", ts: "2" },
    { event: "ingest", file: "trajectories/2026-11/minji/codex/c.json", ts: "3" },
  ];
  const s2 = buildStatus({ project: "acme", member: "alice", aliases: ["alice-old"], log, initStatus: null, request: null,
    myFiles: ["trajectories/2026-11/alice-old/claude-code/a.json", "trajectories/2026-11/alice-old/claude-code/d.json"] });
  assert.equal(s2.ingest.ingested, 2);
  assert.equal(s2.ingest.waiting, 1);
});
