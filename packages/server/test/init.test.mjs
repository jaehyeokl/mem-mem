// Project init: pure helpers, and the worker's init job against real git repos
// and a fake App Server session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";
import {
  anyWorkflowActive,
  applyProjectLanguage,
  buildPreAnswerTurn,
  isTerminalInitReply,
  waitingOnBackground,
  workflowExecutions,
  classifyBootstrapPaths,
  classifyInit,
  classifyInitReply,
  reflectedSessions,
  layoutHistory,
  mergeRequests,
  relatedRepoDir,
  repoCloneUrl,
} from "../dist/init.js";
import { applyRunToProject, initProjectOf, normalizeMemberKeys, statusDoc } from "../dist/init-runner.js";
import { LettaGateway } from "../dist/letta.js";
import { aliasMap, membersInstruction, parseMember, readMembers, readMembersDetailed, resolveMember } from "../dist/members.js";
import { buildReflectionInstruction } from "../dist/reflection.js";
import { emptyState, loadState, saveState } from "../dist/state.js";
import { markRequestsFromDoneStatus, seedInitStagedSessions } from "../dist/init-recovery.js";
import { Worker } from "../dist/worker.js";
import { renderStatus, projectStatus } from "../dist/cli/status.js";
import { fakeMemfs, seededTranscriptsRepo, sh, tempDir, writeAndPush } from "./helpers.mjs";

const AGENT = "agent-local-test";
const fixture = JSON.parse(readFileSync(new URL("./fixtures/trajectory-small.json", import.meta.url), "utf8"));
const TRAJ = "trajectories/2026-11/minji/claude-code/2026-11-02T09-00-00_s1.json";

function request(member, extra = {}) {
  return {
    layoutVersion: 1,
    memmemVersion: "0.1.0",
    requestedAt: "2026-11-06T07:00:00.000Z",
    project: "demo-shop",
    member,
    language: "en",
    historyOnly: false,
    answers: { depth: "standard", repos: [], style: "terse", history: true },
    codeRepo: null,
    codeSummary: { branch: "main", status: "", log: "abc123 first commit", shortlog: "1\tminji", remote: null },
    sessions: 1,
    ...extra,
  };
}

function manifest(member, sessions) {
  return {
    version: 1,
    generatedAt: "2026-11-06T07:00:00.000Z",
    outDir: `bootstrap/${member}`,
    member,
    sources: { "claude-code": { discovered: sessions.length, exported: sessions.length } },
    errors: [],
    sessions,
  };
}

function session(id, startedAt, bytes = 100, source = "claude-code") {
  return {
    source,
    id: `native-${id}`,
    sessionId: id,
    file: `${source}/${startedAt.slice(0, 19).replace(/:/g, "-")}_${id}.json`,
    sourcePath: `~/.claude/projects/x/${id}.jsonl`,
    project: "/home/minji/work/demo-shop",
    startedAt,
    userMessages: 1,
    assistantMessages: 1,
    records: 3,
    bytes,
  };
}

// ---------------------------------------------------------------- pure helpers

test("bootstrap paths: requests, answers in order, manifests; other files ignored", () => {
  const s = classifyBootstrapPaths([
    { path: "bootstrap/minji/request.json", blob: "a" },
    { path: "bootstrap/minji/answer-10.md", blob: "b" },
    { path: "bootstrap/minji/answer-2.md", blob: "c" },
    { path: "bootstrap/minji/manifest.json", blob: "d" },
    { path: "bootstrap/minji/codex/x.json", blob: "e" },
    { path: "bootstrap/status.json", blob: "f" },
  ]);
  assert.deepEqual(s.requests.map((r) => r.member), ["minji"]);
  assert.deepEqual(s.answers.map((a) => a.n), [2, 10]);
  assert.deepEqual(s.manifests.map((m) => m.path), ["bootstrap/minji/manifest.json"]);
});

test("mergeRequests: newest full request leads, repos union, deep wins, history-only alone", () => {
  const a = { path: "bootstrap/a/request.json", blob: "1", member: "a", doc: request("a", { requestedAt: "2026-11-06T01:00:00Z", answers: { depth: "deep", repos: ["org/x"], style: "", history: true }, codeRepo: "https://h/a.git" }) };
  const b = { path: "bootstrap/b/request.json", blob: "2", member: "b", doc: request("b", { requestedAt: "2026-11-06T02:00:00Z", answers: { depth: "standard", repos: ["org/x", "org/y"], style: "short", history: false }, codeRepo: "https://h/b.git" }) };
  const plan = mergeRequests([b, a]);
  assert.equal(plan.primary.member, "b");
  assert.equal(plan.depth, "deep");
  assert.deepEqual(plan.repos, ["org/x", "org/y"]);
  assert.equal(plan.codeRepo, "https://h/b.git");
  assert.deepEqual(plan.requestedBy, ["a", "b"]);
  assert.deepEqual(plan.historyApprovedBy, ["a"]);
  assert.equal(plan.historyOnly, false);
  const h = mergeRequests([{ ...a, doc: { ...a.doc, historyOnly: true, codeRepo: null } }]);
  assert.equal(h.historyOnly, true);
  assert.equal(repoCloneUrl("org/x"), "https://github.com/org/x.git");
  assert.equal(repoCloneUrl("git@github.com:org/x.git"), "git@github.com:org/x.git");
  assert.equal(relatedRepoDir("https://github.com/org/web-app.git"), "repo-web-app");
});

test("classifyInitReply: INIT line, question heuristic, closing offer after commits", () => {
  assert.deepEqual(classifyInitReply("Built memory.\n\nINIT: done", true), { kind: "done", source: "result_line" });
  const q = classifyInitReply("I found two databases.\n**INIT: question: Which one is canonical, Postgres or Mongo?**", false);
  assert.equal(q.kind, "question");
  assert.equal(q.question, "Which one is canonical, Postgres or Mongo?");
  assert.deepEqual(classifyInitReply("Could not commit.\nINIT: failed: memory guard denied the edit", false), {
    kind: "failed",
    reason: "memory guard denied the edit",
    source: "result_line",
  });
  const h = classifyInitReply("Before I continue: which repository holds the API?", false);
  assert.equal(h.kind, "question");
  assert.equal(h.source, "heuristic");
  const offer = classifyInitReply("Committed 4 topics.\n\nWant me to refine anything?", true);
  assert.equal(offer.kind, "done");
  assert.match(offer.followUp, /refine/);
  assert.equal(classifyInitReply("Done. Memory is initialized.", false).kind, "done");
  assert.equal(classifyInitReply("결정 사항을 정리했습니다. 어느 쪽이 맞나요？", false).kind, "question");
});

test("layoutHistory: export layout, dedupe by sessionId, newest kept, project points at the server clone", async () => {
  const root = tempDir("memmem-layout-");
  const repo = join(root, "t");
  const s1 = session("aaa", "2026-11-01T00:00:00Z", 100);
  const s2 = session("bbb", "2026-11-02T00:00:00Z", 200);
  const s3 = session("ccc", "2026-11-03T00:00:00Z", 300);
  const s2big = { ...session("bbb", "2026-11-02T00:00:00Z", 999) };
  for (const [member, list] of [["minji", [s1, s2]], ["joon", [s2big, s3]]]) {
    const dir = join(repo, "bootstrap", member);
    mkdirSync(join(dir, "claude-code"), { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest(member, list)));
    for (const s of list) writeFileSync(join(dir, s.file), JSON.stringify([{ role: "meta", member }]));
  }
  const out = join(root, "letta-trajectories");
  mkdirSync(out);
  writeFileSync(join(out, "stale.json"), "{}");
  const h = await layoutHistory({
    repoDir: repo,
    manifests: [
      { path: "bootstrap/joon/manifest.json", member: "joon", blob: "x" },
      { path: "bootstrap/minji/manifest.json", member: "minji", blob: "y" },
    ],
    outDir: out,
    maxSessions: 2,
    codeDir: "/srv/agentcwd/demo-shop/repo",
  });
  assert.deepEqual(h.sessions.map((s) => s.sessionId), ["bbb", "ccc"]); // oldest (aaa) dropped, oldest first
  assert.equal(h.sessions.find((s) => s.sessionId === "bbb").member, "joon"); // the larger copy
  assert.equal(h.sessions[0].project, "/srv/agentcwd/demo-shop/repo");
  assert.equal(h.sessions[0].clientProject, "/home/minji/work/demo-shop");
  assert.equal(h.bytes, 999 + 300);
  assert.equal(h.estimatedTokens, Math.ceil(1299 / 4));
  assert.ok(!existsSync(join(out, "stale.json")));
  const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.equal(m.version, 1);
  assert.equal(m.sessions.length, 2);
  assert.equal(m.sources["claude-code"].exported, 2);
  assert.ok(m.errors.some((e) => /initMaxSessions/.test(e.error)));
  assert.ok(m.errors.some((e) => /duplicate/.test(e.error)));
  for (const s of m.sessions) assert.ok(existsSync(join(out, s.file)), s.file);
});

test("pre-answer turn names the answers, the export dir, authorship, the clone and the INIT line", () => {
  const plan = mergeRequests([{ path: "bootstrap/minji/request.json", blob: "1", member: "minji", doc: request("minji", { codeRepo: "https://github.com/o/r.git" }) }]);
  const text = buildPreAnswerTurn({
    project: "demo-shop",
    initId: "init-1",
    plan,
    history: { outDir: "/tmp/letta-trajectories", sessions: [{}, {}], dropped: [], bytes: 1, estimatedTokens: 1, members: ["minji"], bySource: { codex: 2 } },
    codeDir: "/srv/repo",
    codeHead: "0123456789abcdef",
    relatedDirs: [],
    historyModel: null,
  });
  assert.match(text, /Research depth: standard/);
  assert.match(text, /Other repositories: none/);
  assert.match(text, /Communication style: terse/);
  assert.match(text, /approved by minji \(2 sessions: codex 2\)/);
  assert.match(text, /Do not run `letta trajectories detect` or `letta trajectories export` again/);
  assert.match(text, /prepare-history\.mjs --export \/tmp\/letta-trajectories/);
  assert.match(text, /`member` field of each session/);
  assert.match(text, /Subagent model for history analysis: your current model/);
  assert.match(text, /Language: write memory in English/);
  assert.match(text, /cloned at \/srv\/repo/);
  assert.match(text, /Rules for reflection/);
  assert.match(text, /do not delete them/);
  assert.match(text, /Workflow with `wait: true`/);
  assert.match(text, /INIT: done/);
  assert.match(text, /Reply to this message with one sentence only/);
});

// ---------------------------------------------------------------- worker flow

/**
 * Fake App Server: turns are recorded; `init` (runCommandTurn) and answer
 * turns follow `initPlan` entries `{commit, reply, wait}` in order.
 */
class FakeGateway extends LettaGateway {
  constructor(url, paths) {
    super(url, paths);
    this.sent = [];
    this.commands = [];
    this.convCounter = 0;
    this.initPlan = [];
    this.sessionOpts = [];
  }
  commitMemory(name) {
    const memfs = this.memfsDir(AGENT);
    writeFileSync(join(memfs, `${name}.md`), `---\nname: ${name}\ndescription: test\n---\n${name}\n`);
    sh(memfs, "add", "-A");
    sh(memfs, "commit", "--quiet", "-m", `memory(self): ${name}`);
  }
  async step(conv, text) {
    const plan = this.initPlan.shift() ?? { reply: "INIT: done", commit: "project" };
    if (plan.wait) await plan.wait;
    if (plan.before) plan.before();
    if (plan.commit) this.commitMemory(plan.commit);
    return plan.reply;
  }
  async openSession(agentId, conversationId, opts) {
    const conv = conversationId ?? `local-conv-${++this.convCounter}`;
    this.sessionOpts.push({ conv, ...opts });
    const gw = this;
    return {
      agentId,
      conversationId: conv,
      async sendTurn(text) {
        gw.sent.push({ conv, text });
        if (text.startsWith("<memmem-init-answer>") || text.startsWith("<memmem-init-continue>")) {
          const reply = await gw.step(conv, text);
          return { conversationId: conv, reply, finalReply: reply, durationMs: 5, usage: { promptTokens: 50, totalTokens: 60 } };
        }
        return { conversationId: conv, reply: "Understood.", finalReply: "Understood.", durationMs: 5, usage: { promptTokens: 10, totalTokens: 12 } };
      },
      async runCommandTurn(commandId) {
        gw.commands.push({ conv, commandId });
        const reply = await gw.step(conv, commandId);
        return { success: true, output: "Memory initialization completed", conversationId: conv, reply, finalReply: reply, durationMs: 9, usage: { promptTokens: 1000, totalTokens: 1200 }, toolCalls: { Skill: 1 }, notableCommands: [] };
      },
      async reflect() {
        return { outcome: "nothing_to_reflect", output: "No new transcript content to reflect on for this conversation." };
      },
      async abort() {},
      close() {},
    };
  }
}

function bareCodeRepo(root) {
  const work = join(root, "code-work");
  const bare = join(root, "code.git");
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", work]);
  writeFileSync(join(work, "README.md"), "# demo-shop\n");
  sh(work, "add", "-A");
  sh(work, "commit", "--quiet", "-m", "first commit");
  execFileSync("git", ["clone", "--quiet", "--bare", work, bare]);
  return bare;
}

function setup(settings = {}) {
  const root = tempDir("memmem-init-");
  const { bare, work } = seededTranscriptsRepo(root);
  const memoryRemote = join(root, "memory.git");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", memoryRemote]);
  const letta = join(root, "letta");
  fakeMemfs(join(letta, "lc-local-backend", "memfs", AGENT, "memory"));
  const configPath = join(root, "projects.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      settings: { stepCount: 1, dailyReflectHour: null, reflectionWaitSeconds: 0, ...settings },
      projects: [{ project: "demo-shop", agentId: AGENT, memoryRepo: memoryRemote, transcriptsRepo: bare }],
    }),
  );
  const traj = join(root, "letta-trajectories");
  const cfg = loadConfig({ MEMMEM_CONFIG: configPath, MEMMEM_SERVER_HOME: root, LETTA_CONFIG_DIR: letta, MEMMEM_INIT_TRAJECTORIES_DIR: traj });
  let gateway;
  const plan = [];
  const worker = new Worker(
    () => cfg,
    (url, paths) => {
      gateway = new FakeGateway(url, paths);
      gateway.initPlan = plan;
      return gateway;
    },
  );
  const show = (path) => execFileSync("git", ["--git-dir", bare, "show", `main:${path}`], { encoding: "utf8" });
  const status = () => JSON.parse(show("bootstrap/status.json"));
  const logLines = () => show("ingest/log.jsonl").trim().split("\n").map((l) => JSON.parse(l));
  const pass = async () => {
    const r = await worker.runPass(cfg);
    await worker.waitForInits();
    return r;
  };
  return { root, bare, work, memoryRemote, letta, cfg, worker, gw: () => gateway, plan, show, status, logLines, pass, traj };
}

test("init: a code repo that cannot be cloned fails cleanly, is marked processed, and ingest goes on", async () => {
  const t = setup();
  writeAndPush(t.work, { "bootstrap/minji/request.json": request("minji", { codeRepo: join(t.root, "missing.git") }) }, "init request");
  const r = await t.pass();
  assert.equal(r[0].init, "started");
  const st = t.status();
  assert.equal(st.state, "failed");
  assert.match(st.error, /cannot clone the code repo .*missing\.git/);
  assert.deepEqual(st.requestedBy, ["minji"]);
  assert.deepEqual(st.commits, []);
  assert.equal(st.serverVersion, "0.1.0");
  const state = await loadState(t.cfg.stateDir, "demo-shop");
  assert.equal(state.initRequests["bootstrap/minji/request.json"].outcome, "failed");
  assert.equal(state.init.state, "failed");
  assert.equal(t.gw().commands.length, 0); // no Letta turn
  const initLog = t.logLines().filter((l) => l.event === "init");
  assert.equal(initLog.length, 1);
  assert.equal(initLog[0].state, "failed");

  // The next pass does not run it again and ingests normally.
  writeAndPush(t.work, { [TRAJ]: fixture });
  const r2 = await t.pass();
  assert.equal(r2[0].init, undefined);
  assert.equal(r2[0].ingested, 1);
  assert.equal(t.gw().commands.length, 0);
});

test("init: code clone, history layout, pre-answer turn, Letta init, commits pushed, status done", async () => {
  const t = setup();
  const code = bareCodeRepo(t.root);
  const s = session("aaa", "2026-11-01T00:00:00Z", 120, "codex");
  writeAndPush(
    t.work,
    {
      "bootstrap/minji/request.json": request("minji", { codeRepo: code }),
      "bootstrap/minji/manifest.json": manifest("minji", [s]),
      [`bootstrap/minji/${s.file}`]: JSON.stringify(fixture.records),
    },
    "init request",
  );
  writeAndPush(t.work, { [TRAJ]: fixture });
  let release;
  t.plan.push({ wait: new Promise((r) => (release = r)), reply: "Built the memory.\nINIT: done", commit: "project" });
  const first = await t.worker.runPass(t.cfg); // starts init; ingest waits
  assert.equal(first[0].init, "started");
  assert.equal(first[0].ingested, 0);
  assert.deepEqual(t.worker.runningInits, ["demo-shop"]);
  // While the job runs, the project is skipped by other passes.
  const skip = await t.worker.runPass(t.cfg);
  assert.equal(skip[0].ingested, 0);
  assert.equal(skip[0].init, undefined);
  release();
  await t.worker.waitForInits();
  const gw = t.gw();
  assert.equal(gw.commands.length, 1);
  assert.equal(gw.commands[0].commandId, "init");
  const pre = gw.sent[0];
  assert.match(pre.text, /^<memmem-init project="demo-shop" init="init-/);
  assert.ok(pre.text.includes(t.traj), "names the trajectories dir");
  assert.equal(pre.conv, gw.commands[0].conv);
  const opts = gw.sessionOpts.find((o) => o.conv === pre.conv);
  assert.equal(opts.permissionMode, "unrestricted");
  assert.equal(opts.cwd, join(t.cfg.cwdBase, "demo-shop", "repo"));
  assert.ok(existsSync(join(t.cfg.cwdBase, "demo-shop", "repo", "README.md")), "code clone kept");
  assert.ok(!existsSync(t.traj), "trajectories dir cleaned");

  const st = t.status();
  assert.equal(st.state, "done");
  assert.equal(st.commits.length, 1);
  assert.equal(st.commits[0].subject, "memory(self): project");
  assert.equal(st.sessions, 1);
  assert.equal(st.usage.total, 12 + 1200);
  assert.equal(st.usage.input, 10 + 1000);
  assert.equal(st.usage.costUsd, null);
  const memHead = sh(gw.memfsDir(AGENT), "rev-parse", "main");
  assert.equal(execFileSync("git", ["--git-dir", t.memoryRemote, "rev-parse", "main"], { encoding: "utf8" }).trim(), memHead);
  const state = await loadState(t.cfg.stateDir, "demo-shop");
  assert.equal(state.memoryHeadSeen, memHead);
  assert.equal(state.initRequests["bootstrap/minji/request.json"].outcome, "done");
  // The whole run lands on the ledger once, under init.
  const today = Object.values(state.usage).at(-1);
  assert.equal(today.init.turns, 1);
  assert.equal(today.init.total, 12 + 1200);
  assert.equal(state.init.usageRecorded, true);
  const entry = t.logLines().find((l) => l.event === "init");
  assert.equal(entry.state, "done");
  assert.deepEqual(entry.commits, [memHead]);
  assert.equal(entry.usage.total, 12 + 1200);

  // Ingest resumes on the next pass, in a different (daily) conversation.
  const r3 = await t.pass();
  assert.equal(r3[0].ingested, 1);
  const ingestTurn = gw.sent.find((x) => x.text.startsWith("<team-memory-ingest"));
  assert.notEqual(ingestTurn.conv, pre.conv);
  assert.match(renderStatus({ now: new Date().toISOString(), home: t.root, lettaConfigDir: t.letta, configPath: "", server: { running: false, port: 4500, appServerReady: false }, projects: [projectStatus({ project: "demo-shop", agentId: AGENT, memoryRepo: "", transcriptsRepo: "" }, state)] }), /init done init-/);
});

test("init: a question waits for an answer file, which continues the same conversation", async () => {
  const t = setup();
  const code = bareCodeRepo(t.root);
  writeAndPush(t.work, { "bootstrap/minji/request.json": request("minji", { codeRepo: code, answers: { depth: "deep", repos: [], style: "", history: false } }) });
  t.plan.push({ reply: "Two databases exist.\nINIT: question: Which one is canonical?" });
  const first = await t.pass();
  assert.equal(first[0].init, "started");
  let st = t.status();
  assert.equal(st.state, "waiting_for_answer");
  assert.equal(st.question, "Which one is canonical?");
  const conv = t.gw().commands[0].conv;

  // Ingest is not paused while waiting.
  writeAndPush(t.work, { [TRAJ]: fixture });
  const r2 = await t.pass();
  assert.equal(r2[0].ingested, 1);

  t.plan.push({ reply: "Recorded.\nINIT: done", commit: "databases" });
  writeAndPush(t.work, { "bootstrap/joon/answer-1.md": "---\nmember: joon\ncreated: 2026-11-06T08:00:00Z\n---\n\nPostgres is canonical.\n" });
  const r3 = await t.pass();
  assert.match(r3[0].init, /^continued init-/);
  const answerTurn = t.gw().sent.find((x) => x.text.startsWith("<memmem-init-answer>"));
  assert.equal(answerTurn.conv, conv);
  assert.match(answerTurn.text, /joon: Postgres is canonical\./);
  st = t.status();
  assert.equal(st.state, "done");
  assert.equal(st.answers, 1);
  assert.deepEqual(st.commits.map((c) => c.subject), ["memory(self): databases"]);
});

test("init cancel drops a pending question; init run re-runs a processed request", async () => {
  const t = setup();
  const code = bareCodeRepo(t.root);
  writeAndPush(t.work, { "bootstrap/minji/request.json": request("minji", { codeRepo: code }) });
  t.plan.push({ reply: "Which branch is production?" }); // heuristic question, no commit
  await t.pass();
  assert.equal(t.status().state, "waiting_for_answer");
  const c = await t.worker.cancelInit(t.cfg, "demo-shop");
  assert.equal(c.ok, true);
  assert.equal(c.state, "failed");
  assert.equal(t.status().error, "cancelled by the operator");
  const state = await loadState(t.cfg.stateDir, "demo-shop");
  assert.equal(state.initRequests["bootstrap/minji/request.json"].outcome, "cancelled");

  const r = await t.worker.initNow(t.cfg, "demo-shop", { force: true, wait: true });
  assert.equal(r.ok, true);
  assert.equal(r.state, "done");
  assert.equal(t.gw().commands.length, 2);
  const nothing = await t.worker.initNow(t.cfg, "demo-shop", { force: false, wait: true });
  assert.equal(nothing.ok, false);
});

test("init: a run left 'running' by an earlier process is recorded as interrupted", async () => {
  const t = setup();
  const code = bareCodeRepo(t.root);
  writeAndPush(t.work, { "bootstrap/minji/request.json": request("minji", { codeRepo: code }) });
  await t.pass();
  const statePath = join(t.cfg.stateDir, "demo-shop.json");
  const st = JSON.parse(readFileSync(statePath, "utf8"));
  st.init.state = "running";
  delete st.init.finishedAt;
  writeFileSync(statePath, JSON.stringify(st));
  const r = await t.pass();
  assert.equal(r[0].init, undefined); // processed request: nothing new to start
  const after = await loadState(t.cfg.stateDir, "demo-shop");
  assert.equal(after.init.state, "failed");
  assert.match(after.init.error, /interrupted: the worker restarted/);
  assert.equal(t.status().state, "failed");
});

test("CLI: init status renders the run and the processed requests; run/cancel need --project", async () => {
  const { makeCtx, tempHome } = await import("./cli-helpers.mjs");
  const { dispatch } = await import("../dist/cli.js");
  const { parseCommandLine } = await import("../dist/cli/args.js");
  const home = tempHome();
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "projects.json"), JSON.stringify({ settings: {}, projects: [{ project: "demo-shop", agentId: AGENT, memoryRepo: "m", transcriptsRepo: "t" }] }));
  const run = {
    id: "init-20261106T080000Z",
    state: "waiting_for_answer",
    requests: [{ path: "bootstrap/minji/request.json", blob: "b1", member: "minji" }],
    requestedBy: ["minji"],
    conversationId: "local-conv-9",
    startedAt: "2026-11-06T08:00:00Z",
    updatedAt: "2026-11-06T08:10:00Z",
    baselineHead: null,
    answersSeen: {},
    answers: 0,
    usage: { totalTokens: 5000 },
    sessions: 3,
    estimatedTokens: 900,
    question: "Which database is canonical?",
  };
  writeFileSync(join(home, "state", "demo-shop.json"), JSON.stringify({ version: 1, init: run, initRequests: { "bootstrap/old/request.json": { blob: "b0", processedAt: "2026-11-05T00:00:00Z", outcome: "failed", initId: "init-x" } } }));
  const ctx = makeCtx(home);
  assert.equal(await dispatch(ctx, "init status", { project: "demo-shop" }, []), 0);
  const text = ctx.out.text();
  assert.match(text, /init waiting_for_answer init-20261106T080000Z {2}requested by minji/);
  assert.match(text, /sessions 3 \(~900 history tokens\)/);
  assert.match(text, /question: Which database is canonical\?/);
  assert.match(text, /bootstrap\/old\/request\.json {2}failed/);
  assert.match(text, /memmem init --answer/);
  const j = makeCtx(home, { json: true });
  await dispatch(j, "init status", { project: "demo-shop" }, []);
  assert.equal(JSON.parse(j.out.stdout.join("")).init.state, "waiting_for_answer");
  assert.equal(parseCommandLine(["init", "run", "-p", "demo-shop"]).cmd.spec.name, "init run");
  await assert.rejects(() => dispatch(makeCtx(home), "init cancel", {}, []), /needs --project/);
});

test("background work: terminal replies, waiting replies, Workflow journals", async () => {
  assert.equal(isTerminalInitReply("INIT: done"), true);
  assert.equal(isTerminalInitReply("INIT: question: which one?"), true);
  assert.equal(isTerminalInitReply("INIT: failed: memory guard denied"), true);
  assert.equal(isTerminalInitReply("Analyzing.\nINIT: failed: analysis workflow is still running"), false);
  assert.equal(isTerminalInitReply("Working on it."), false);
  assert.equal(waitingOnBackground("Initialization is in progress.\nINIT: failed: analysis workflow is still running"), true);
  assert.equal(waitingOnBackground("I will continue when the workflow notification arrives."), true);
  assert.equal(waitingOnBackground("INIT: done"), false);
  assert.equal(waitingOnBackground("INIT: failed: cannot commit"), false);

  const letta = tempDir("memmem-wf-");
  const dir = join(letta, "workflows", "executions", "wf-1");
  mkdirSync(dir, { recursive: true });
  const since = Date.now() - 1000;
  writeFileSync(join(dir, "script.js"), "export const meta = {}");
  writeFileSync(join(dir, "journal.jsonl"), [{ kind: "agent_started", callIndex: 0 }, { kind: "agent_started", callIndex: 1 }, { callIndex: 0, label: "a", prompt: "p", outcome: { value: {}, failed: false, durationMs: 5, totalTokens: 9 } }].map((l) => JSON.stringify(l)).join("\n") + "\n");
  let ex = await workflowExecutions(letta, since);
  assert.equal(ex.length, 1);
  assert.equal(ex[0].agentsStarted, 2);
  assert.equal(ex[0].agentsFinished, 1);
  assert.equal(anyWorkflowActive(ex), true);
  writeFileSync(join(dir, "journal.jsonl"), [{ kind: "agent_started", callIndex: 0 }, { callIndex: 0, result: {}, failed: false }].map((l) => JSON.stringify(l)).join("\n") + "\n");
  ex = await workflowExecutions(letta, since);
  assert.equal(anyWorkflowActive(ex, Date.now() + 60_000), false); // finished and quiet
  assert.equal((await workflowExecutions(letta, Date.now() + 60_000)).length, 0); // started before `since`
});

test("init: an agent that stops to wait for a background Workflow gets a continue turn naming its results", async () => {
  const t = setup();
  const code = bareCodeRepo(t.root);
  writeAndPush(t.work, { "bootstrap/minji/request.json": request("minji", { codeRepo: code }) });
  // The init turn launches a Workflow and stops before it finishes (Letta 0.34.41 over the App Server).
  const wfDir = join(t.letta, "workflows", "executions", "wf-test");
  t.plan.push({
    reply: "Initialization is in progress; the analysis workflow is running.\nINIT: failed: analysis workflow is still running",
    before: () => {
      mkdirSync(wfDir, { recursive: true });
      writeFileSync(join(wfDir, "script.js"), "export const meta = {}");
      writeFileSync(join(wfDir, "journal.jsonl"), JSON.stringify({ kind: "agent_started", callIndex: 0 }) + "\n" + JSON.stringify({ callIndex: 0, label: "history", prompt: "p", outcome: { value: { findings: [] }, failed: false, durationMs: 5, totalTokens: 9 } }) + "\n");
      const quiet = new Date(Date.now() - 31_000); // finished a while ago (the journal is quiet)
      utimesSync(join(wfDir, "journal.jsonl"), quiet, quiet);
    },
  });
  t.plan.push({ reply: "Curated and committed.\nINIT: done", commit: "project" });
  await t.pass();
  const cont = t.gw().sent.find((x) => x.text.startsWith("<memmem-init-continue>"));
  assert.ok(cont, "continue turn sent");
  assert.ok(cont.text.includes(join(wfDir, "journal.jsonl")));
  assert.equal(cont.conv, t.gw().commands[0].conv);
  const st = t.status();
  assert.equal(st.state, "done");
  assert.deepEqual(st.commits.map((c) => c.subject), ["memory(self): project"]);
});

// ---------------------------------------------------------------- classification, members, contributions

function loaded(member, extra = {}) {
  return { path: `bootstrap/${member}/request.json`, blob: `b-${member}`, member, doc: request(member, extra) };
}

test("classifyInit: first init, contribute, deepen, reinit, history-only, shallower depth ignored", () => {
  const none = { initialized: false, depth: null };
  const std = { initialized: true, depth: "standard" };
  const deep = { initialized: true, depth: "deep" };
  // No completed init: project_init (several requests merged, deep wins).
  let c = classifyInit(mergeRequests([loaded("minji"), loaded("joon", { answers: { depth: "deep", repos: [], style: "", history: true } })]), none);
  assert.equal(c.kind, "project_init");
  assert.equal(c.depthBefore, null);
  assert.equal(c.depthAfter, "deep");
  // Completed init, same or lower depth: contribute.
  c = classifyInit(mergeRequests([loaded("joon")]), std);
  assert.deepEqual([c.kind, c.depthBefore, c.depthAfter, c.downgradeIgnored], ["contribute", "standard", "standard", false]);
  c = classifyInit(mergeRequests([loaded("joon")]), deep);
  assert.deepEqual([c.kind, c.depthAfter, c.downgradeIgnored], ["contribute", "deep", true]);
  // Deeper than recorded: deepen. Unknown recorded depth counts as standard.
  const deeper = mergeRequests([loaded("joon", { answers: { depth: "deep", repos: [], style: "", history: true } })]);
  c = classifyInit(deeper, std);
  assert.deepEqual([c.kind, c.depthBefore, c.depthAfter], ["deepen", "standard", "deep"]);
  assert.equal(classifyInit(deeper, { initialized: true, depth: null }).kind, "deepen");
  assert.equal(classifyInit(deeper, deep).kind, "contribute");
  // reinit: project_init again; the depth does not go down.
  c = classifyInit(mergeRequests([loaded("joon", { reinit: true })]), deep);
  assert.deepEqual([c.kind, c.reinit, c.depthAfter, c.downgradeIgnored], ["project_init", true, "deep", true]);
  // history-only forces contribute, even before any init.
  const ho = mergeRequests([loaded("joon", { historyOnly: true, answers: { history: true } })]);
  assert.equal(classifyInit(ho, none).kind, "contribute");
  assert.equal(classifyInit(ho, std).kind, "contribute");
});

test("reflectedSessions: ingest entries with a reflection outcome and reflection entries' trajectory files", () => {
  const log = [
    { event: "ingest", file: "trajectories/2026-11/joon/codex/2026-11-01T00-00-00_s-a.json", session: "s-a", reflectionOutcome: "committed", reflectionCommit: "abc" },
    { event: "ingest", file: "trajectories/2026-11/joon/codex/2026-11-01T01-00-00_s-b.json", session: "s-b", reflectionOutcome: "failed" },
    { event: "ingest", file: "trajectories/2026-11/joon/codex/2026-11-01T02-00-00_s-c.json", session: "s-c" },
    { event: "reflection", outcome: "nothing_to_save", files: ["trajectories/2026-11/joon/codex/2026-11-01T02-00-00_s-c.json", "inbox/joon/note.md"] },
    { event: "reflection", outcome: "failed", files: ["trajectories/2026-11/joon/codex/2026-11-01T03-00-00_s-d.json"] },
    { event: "init", state: "done", sessions: 3 },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  assert.deepEqual([...reflectedSessions(log + "\nnot json\n")].sort(), ["s-a", "s-c"]);
});

test("layoutHistory: sessions already reflected are left out and counted; aliases map to handles", async () => {
  const root = tempDir("memmem-layout-x-");
  const repo = join(root, "t");
  const list = [session("aaa", "2026-11-01T00:00:00Z"), session("bbb", "2026-11-02T00:00:00Z")];
  const dir = join(repo, "bootstrap", "jj");
  mkdirSync(join(dir, "claude-code"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest("jj", list)));
  for (const s of list) writeFileSync(join(dir, s.file), "[]");
  const h = await layoutHistory({
    repoDir: repo,
    manifests: [{ path: "bootstrap/jj/manifest.json", member: "jj", blob: "x" }],
    outDir: join(root, "out"),
    maxSessions: 10,
    codeDir: null,
    exclude: new Set(["aaa"]),
    resolveMember: (m) => (m === "jj" ? "joon" : m),
  });
  assert.deepEqual(h.sessions.map((s) => s.sessionId), ["bbb"]);
  assert.equal(h.alreadyReflected, 1);
  assert.deepEqual(h.members, ["joon"]);
  assert.deepEqual(h.byMember, { joon: 1 });
  assert.ok(h.dropped.some((d) => d.sessionId === "aaa" && d.reason === "already reflected"));
  assert.equal(h.alreadyStaged, 0);
  // Sessions an earlier init analysed are left out with their own reason and count.
  const h2 = await layoutHistory({
    repoDir: repo,
    manifests: [{ path: "bootstrap/jj/manifest.json", member: "jj", blob: "x" }],
    outDir: join(root, "out"),
    maxSessions: 10,
    codeDir: null,
    excludeStaged: { bbb: { initId: "init-1", member: "joon" } },
  });
  assert.deepEqual(h2.sessions.map((s) => s.sessionId), ["aaa"]);
  assert.equal(h2.alreadyStaged, 1);
  assert.equal(h2.alreadyReflected, 0);
  assert.ok(h2.dropped.some((d) => d.sessionId === "bbb" && d.reason === "already analysed by init init-1"));
});

test("members: parse, merge, aliases, instruction table; the reflection instruction carries it", () => {
  const repo = tempDir("memmem-members-");
  mkdirSync(join(repo, "members"));
  writeFileSync(
    join(repo, "members", "alice.json"),
    JSON.stringify({ handle: "alice", displayName: "Alice Example", gitAuthors: [{ name: "alice", email: "alice@example.invalid" }], joinedAt: "2026-11-06T00:00:00Z", aliases: ["alice-old"] }),
  );
  writeFileSync(join(repo, "members", "minji.json"), JSON.stringify({ gitAuthors: [{ name: "Minji Kim" }] })); // handle from the file name
  writeFileSync(join(repo, "members", "broken.json"), "{");
  const members = readMembers(repo);
  assert.deepEqual(members.map((m) => m.handle), ["alice", "minji"]);
  assert.equal(members[1].displayName, "minji");
  assert.equal(parseMember(JSON.stringify({ handle: "bad handle" })), null);
  const aliases = aliasMap(members);
  assert.equal(resolveMember("alice-old", aliases), "alice");
  assert.equal(resolveMember("minji", aliases), "minji");
  const text = membersInstruction(members).join("\n");
  assert.match(text, /- alice \(Alice Example\): git author alice \(alice@example\.invalid\) = member alice; old handle alice-old = alice/);
  assert.match(text, /- minji: git author Minji Kim = member minji/);
  assert.match(text, /merge its content into people\/<handle>\.md/);
  assert.deepEqual(membersInstruction([]), []);
  const instr = buildReflectionInstruction({ agentId: "a", memfsAgentRoot: "/m", pending: [], transcriptPath: () => "", members });
  assert.match(instr, /old handle alice-old = alice/);
  assert.doesNotMatch(buildReflectionInstruction({ agentId: "a", memfsAgentRoot: "/m", pending: [], transcriptPath: () => "" }), /Team members/);
});

test("project record: hydrated from status.json, alias keys merged, a failed run keeps the earlier success", () => {
  const state = { init: null, initRequests: {}, initProject: null };
  const rec = initProjectOf(state, {
    state: "done", initId: "init-1", requestedBy: ["alice-old"], finishedAt: "2026-11-05T00:00:00Z", sessions: 6,
    depth: null, initializedAt: "2026-11-05T00:00:00Z", initializedBy: ["alice-old"], repos: [],
    members: { "alice-old": { kind: "project_init", sessions: 6, finishedAt: "2026-11-05T00:00:00Z", initId: "init-1", state: "done" } },
  });
  assert.equal(rec.initializedAt, "2026-11-05T00:00:00Z");
  assert.equal(rec.depth, null);
  assert.equal(rec.members["alice-old"].sessions, 6);
  normalizeMemberKeys(rec, new Map([["alice-old", "alice"]]));
  assert.deepEqual(Object.keys(rec.members), ["alice"]);
  assert.deepEqual(rec.initializedBy, ["alice"]);
  const run = {
    id: "init-2", kind: "deepen", state: "failed", requestedBy: ["alice"], requests: [], startedAt: "s", updatedAt: "u", finishedAt: "2026-11-06T00:00:00Z",
    error: "boom", usage: {}, sessions: 0, estimatedTokens: 0, answers: 0, answersSeen: {}, conversationId: null, baselineHead: null, depthAfter: "deep",
    prevMembers: { alice: { ...rec.members.alice } },
  };
  rec.members.alice = { kind: "deepen", sessions: 3, finishedAt: null, initId: "init-2", state: "running" };
  applyRunToProject(state, run);
  assert.equal(rec.members.alice.initId, "init-1");
  assert.equal(rec.members.alice.state, "done");
  assert.deepEqual(rec.members.alice.lastFailure, { initId: "init-2", kind: "deepen", finishedAt: "2026-11-06T00:00:00Z", error: "boom" });
  assert.equal(rec.depth, null); // a failed deepen does not change the depth
  const doc = statusDoc("demo-shop", run, "0.1.0", rec);
  assert.equal(doc.state, "failed");
  assert.deepEqual(doc.lastRun.kind, "deepen");
  assert.equal(doc.lastRun.error, "boom");
  assert.equal(doc.initializedAt, "2026-11-05T00:00:00Z");
});

test("init: minji initializes, joon (under an alias) contributes, minji deepens; status.json members persist", async () => {
  const t = setup();
  const code = bareCodeRepo(t.root);
  const m1 = session("m1", "2026-11-01T00:00:00Z");
  const mOld = session("m-old", "2026-11-01T01:00:00Z");
  const j1 = session("j1", "2026-11-02T00:00:00Z", 100, "codex");
  const jOld = session("j-old", "2026-11-02T01:00:00Z", 100, "codex");
  const jOld2 = session("j-old2", "2026-11-02T02:00:00Z", 100, "codex");
  const reflectedLog = [
    { ts: "2026-11-03T00:00:00Z", event: "ingest", project: "demo-shop", file: "trajectories/2026-11/minji/claude-code/2026-11-01T01-00-00_m-old.json", session: "m-old", member: "minji", reflectionOutcome: "committed", reflectionCommit: "c1" },
    { ts: "2026-11-03T00:00:00Z", event: "ingest", project: "demo-shop", file: "trajectories/2026-11/jj/codex/2026-11-02T01-00-00_j-old.json", session: "j-old", member: "jj", reflectionOutcome: "nothing_to_save", reflectionCommit: null },
    { ts: "2026-11-03T00:00:00Z", event: "reflection", project: "demo-shop", outcome: "committed", reflectionCommit: "c2", files: ["trajectories/2026-11/jj/codex/2026-11-02T02-00-00_j-old2.json"] },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  const pkg = (member, sessions) => ({
    [`bootstrap/${member}/manifest.json`]: manifest(member, sessions),
    ...Object.fromEntries(sessions.map((s) => [`bootstrap/${member}/${s.file}`, JSON.stringify(fixture.records)])),
  });
  writeAndPush(
    t.work,
    {
      "members/minji.json": { handle: "minji", displayName: "Minji Kim", gitAuthors: [{ name: "Minji Kim", email: "minji@example.invalid" }], joinedAt: "2026-11-01T00:00:00Z", aliases: [] },
      "members/joon.json": { handle: "joon", displayName: "Joon", gitAuthors: [{ name: "joon-dev", email: "joon@example.invalid" }], joinedAt: "2026-11-02T00:00:00Z", aliases: ["jj"] },
      "ingest/log.jsonl": reflectedLog + "\n",
      "bootstrap/minji/request.json": request("minji", { codeRepo: code }),
      ...pkg("minji", [m1, mOld]),
    },
    "minji init",
  );
  const staged = [];
  const capture = () => staged.push(JSON.parse(readFileSync(join(t.traj, "manifest.json"), "utf8")).sessions.map((s) => `${s.member}:${s.sessionId}`).sort());

  // 1. First init: project_init with everything (reflected sessions included).
  t.plan.push({ before: capture, reply: "INIT: done", commit: "init-minji" });
  await t.pass();
  let st = t.status();
  assert.equal(st.state, "done");
  assert.equal(st.depth, "standard");
  assert.deepEqual(st.initializedBy, ["minji"]);
  assert.equal(st.initializedAt, st.finishedAt);
  assert.deepEqual(st.lastRun.kind, "project_init");
  assert.deepEqual(staged[0], ["minji:m-old", "minji:m1"]);
  assert.deepEqual(st.members.minji, { kind: "project_init", sessions: 2, finishedAt: st.finishedAt, initId: st.initId, state: "done" });
  const pre1 = t.gw().sent.find((x) => x.text.startsWith("<memmem-init"));
  assert.match(pre1.text, /Run kind: project_init/);
  assert.match(pre1.text, /git author Minji Kim \(minji@example\.invalid\) = member minji/);
  assert.match(pre1.text, /old handle jj = joon/);

  // 2. joon (bootstrap/jj/, an alias) sends a full request: contribute, only joon's new sessions.
  writeAndPush(t.work, { "bootstrap/jj/request.json": request("jj", { codeRepo: code, requestedAt: "2026-11-06T09:00:00.000Z", answers: { depth: "standard", repos: [], style: "short answers", history: true } }), ...pkg("jj", [j1, jOld, jOld2]) }, "joon init");
  t.plan.push({ before: capture, reply: "INIT: done", commit: "contrib-joon" });
  await t.pass();
  st = t.status();
  assert.equal(st.state, "done");
  assert.deepEqual(st.requestedBy, ["joon"]);
  assert.equal(st.lastRun.kind, "contribute");
  assert.equal(st.lastRun.alreadyReflected, 2);
  assert.deepEqual(staged[1], ["joon:j1"]);
  assert.equal(st.depth, "standard");
  assert.deepEqual(st.initializedBy, ["minji"]);
  assert.equal(st.members.minji.kind, "project_init"); // persisted from run 1
  assert.deepEqual(st.members.joon, { kind: "contribute", sessions: 1, finishedAt: st.finishedAt, initId: st.initId, state: "done" });
  assert.equal(st.members.jj, undefined);
  const pre2 = t.gw().sent.filter((x) => x.text.startsWith("<memmem-init ")).at(-1).text;
  assert.match(pre2, /Run kind: contribute/);
  assert.match(pre2, /Do not research the codebase again beyond verifying claims/);
  assert.match(pre2, /short answers \(joon\)\. Record each member's answer in people\/<handle>\.md/);
  assert.match(pre2, /Sessions left out because the regular ingest already reflected them: 2/);
  assert.equal(t.logLines().filter((l) => l.event === "init").at(-1).classifiedAs, "contribute");

  // 3. minji asks for deep: deepen, every member's sessions re-staged (reflected ones still left out).
  writeAndPush(t.work, { "bootstrap/minji/request.json": request("minji", { codeRepo: code, requestedAt: "2026-11-06T10:00:00.000Z", answers: { depth: "deep", repos: [], style: "", history: true } }) }, "minji deep");
  t.plan.push({ before: capture, reply: "INIT: done", commit: "deepen" });
  await t.pass();
  st = t.status();
  assert.equal(st.state, "done");
  assert.equal(st.lastRun.kind, "deepen");
  assert.equal(st.depth, "deep");
  assert.deepEqual(staged[2], ["joon:j1", "minji:m1"]);
  assert.equal(st.members.minji.kind, "deepen");
  assert.equal(st.members.minji.sessions, 1);
  assert.equal(st.members.joon.kind, "contribute"); // not a requester: its entry stays
  const pre3 = t.gw().sent.filter((x) => x.text.startsWith("<memmem-init ")).at(-1).text;
  assert.match(pre3, /Research depth: deep\. The project was initialized by minji on .* at standard depth/);
  assert.match(pre3, /do not delete existing records/);

  // Emails reach the agent only: not status.json, not the ingest log.
  assert.doesNotMatch(t.show("bootstrap/status.json"), /example\.invalid/);
  assert.doesNotMatch(t.show("ingest/log.jsonl"), /example\.invalid/);

  // CLI: members and the per-member init table (the worker's clone and state).
  const { makeCtx } = await import("./cli-helpers.mjs");
  const { dispatch } = await import("../dist/cli.js");
  const ctx = makeCtx(t.root);
  assert.equal(await dispatch(ctx, "members", { project: "demo-shop" }, []), 0);
  const out = ctx.out.text();
  assert.match(out, /joon \(Joon\)\n {4}aliases jj {2}git authors joon-dev {2}joined 2026-11-02T00:00:00Z\n {4}init: contribute done {2}1 sessions/);
  assert.match(out, /minji \(Minji Kim\)/);
  assert.doesNotMatch(out, /example\.invalid/);
  const ictx = makeCtx(t.root);
  assert.equal(await dispatch(ictx, "init status", { project: "demo-shop" }, []), 0);
  const itext = ictx.out.text();
  assert.match(itext, /project initialized .* by minji {2}depth deep/);
  assert.match(itext, /members:\n {4}joon {3}contribute done {2}1 sessions/);
  assert.match(itext, /minji {2}deepen done {2}1 sessions/);
});

async function captureLogs(fn) {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    for (const l of String(chunk).split("\n")) {
      try {
        if (l.trim()) lines.push(JSON.parse(l));
      } catch {
        /* not a log line */
      }
    }
    return orig(chunk, ...rest);
  };
  try {
    return { result: await fn(), logs: lines };
  } finally {
    process.stdout.write = orig;
  }
}

test("members: one githubId under two handles is a rename (later joinedAt keeps the handle, tie -> first handle)", () => {
  const repo = tempDir("memmem-members-rename-");
  mkdirSync(join(repo, "members"));
  const put = (h, doc) => writeFileSync(join(repo, "members", `${h}.json`), JSON.stringify({ handle: h, gitAuthors: [{ name: h }], ...doc }));
  put("alice-old", { githubId: 42, joinedAt: "2026-11-01T00:00:00Z", aliases: ["oldest"] });
  put("alice", { githubId: "42", joinedAt: "2026-11-06T00:00:00Z", aliases: [] });
  put("minji", { githubId: 7, joinedAt: "2026-11-02T00:00:00Z" });
  put("bob", { joinedAt: "2026-11-02T00:00:00Z" });
  const { members, renames } = readMembersDetailed(repo);
  assert.deepEqual(members.map((m) => m.handle), ["alice", "bob", "minji"]);
  const j = members.find((m) => m.handle === "alice");
  assert.equal(j.githubId, 42);
  assert.deepEqual(j.aliases.sort(), ["alice-old", "oldest"]);
  assert.deepEqual(j.gitAuthors.map((a) => a.name).sort(), ["alice", "alice-old"]);
  assert.equal(members.find((m) => m.handle === "bob").githubId, undefined);
  assert.deepEqual(renames, [{ githubId: 42, handle: "alice", previous: ["alice-old"] }]);
  const aliases = aliasMap(readMembers(repo));
  assert.equal(resolveMember("alice-old", aliases), "alice");
  assert.equal(resolveMember("oldest", aliases), "alice");
  // Same joinedAt: the lexicographically first handle keeps it.
  put("alice-old", { githubId: 42, joinedAt: "2026-11-06T00:00:00Z" });
  assert.deepEqual(readMembersDetailed(repo).renames, [{ githubId: 42, handle: "alice", previous: ["alice-old"] }]);
  put("aaa", { githubId: 42, joinedAt: "2026-11-06T00:00:00Z" });
  assert.deepEqual(readMembersDetailed(repo).renames, [{ githubId: 42, handle: "aaa", previous: ["alice", "alice-old"] }]);
  assert.equal(parseMember(JSON.stringify({ handle: "x", githubId: "abc" })).githubId, undefined);
});

test("members: the worker logs members_rename_detected once per pass; `members` shows githubId", async () => {
  const t = setup();
  writeAndPush(
    t.work,
    {
      "members/alice-old.json": { handle: "alice-old", gitAuthors: [], joinedAt: "2026-11-01T00:00:00Z", githubId: 42, aliases: [] },
      "members/alice.json": { handle: "alice", displayName: "J", gitAuthors: [], joinedAt: "2026-11-06T00:00:00Z", githubId: 42, aliases: [] },
    },
    "members",
  );
  const { logs } = await captureLogs(() => t.pass());
  const hits = logs.filter((l) => l.event === "members_rename_detected");
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].renames, [{ handle: "alice", previous: ["alice-old"], githubId: 42 }]);
  const { makeCtx } = await import("./cli-helpers.mjs");
  const { dispatch } = await import("../dist/cli.js");
  const c = makeCtx(t.root);
  assert.equal(await dispatch(c, "members", { project: "demo-shop" }, []), 0);
  assert.match(c.out.text(), /alice \(J\)\n {4}githubId 42 {2}aliases alice-old/);
  assert.doesNotMatch(c.out.text(), /^ {2}alice-old/m);
});

const DONE_AT = "2026-11-06T11:52:08.004Z";
const DONE_STATUS = {
  state: "done",
  project: "demo-shop",
  initId: "init-20261106T114612Z",
  requestedBy: ["alice-old"],
  requests: ["bootstrap/alice-old/request.json"],
  startedAt: "2026-11-06T11:46:12.000Z",
  updatedAt: DONE_AT,
  conversationId: "local-conv-5",
  commits: [],
  sessions: 6,
  estimatedTokens: 12000,
  usage: {},
  answers: 0,
  serverVersion: "0.1.0",
  finishedAt: DONE_AT,
  durationMs: 356000,
  depth: "standard",
  initializedAt: DONE_AT,
  initializedBy: ["alice"],
  repos: [],
  members: { alice: { kind: "project_init", sessions: 6, finishedAt: DONE_AT, initId: "init-20261106T114612Z", state: "done", uploadedAs: "alice-old" } },
  lastRun: { initId: "init-20261106T114612Z", kind: "project_init", requestedBy: ["alice-old"], state: "done", commits: [], usage: {}, startedAt: "2026-11-06T11:46:12.000Z", finishedAt: DONE_AT, sessions: 6, alreadyReflected: 0, alreadyStaged: 0 },
};

test("fresh state + an earlier done status.json: its requests are marked processed, no run starts, init status shows it", async () => {
  // Pure: named requests and older request files are marked; a newer one stays pending; a used state is left alone.
  const st = emptyState();
  const scan = { requests: [
    { path: "bootstrap/alice-old/request.json", blob: "b1", member: "alice-old" },
    { path: "bootstrap/minji/request.json", blob: "b2", member: "minji" },
    { path: "bootstrap/joon/request.json", blob: "b3", member: "joon" },
  ] };
  const src = { requests: [
    { member: "minji", path: "bootstrap/minji/request.json", doc: request("minji", { requestedAt: "2026-11-06T11:50:00Z" }) },
    { member: "joon", path: "bootstrap/joon/request.json", doc: request("joon", { requestedAt: "2026-11-07T00:00:00Z" }) },
  ] };
  assert.deepEqual(markRequestsFromDoneStatus(st, DONE_STATUS, scan, src), ["bootstrap/alice-old/request.json", "bootstrap/minji/request.json"]);
  assert.deepEqual(st.initRequests["bootstrap/alice-old/request.json"], { blob: "b1", processedAt: DONE_STATUS.finishedAt, outcome: "done", initId: DONE_STATUS.initId });
  assert.deepEqual(markRequestsFromDoneStatus(st, DONE_STATUS, scan, src), [], "only a fresh state");
  assert.deepEqual(markRequestsFromDoneStatus(emptyState(), { ...DONE_STATUS, state: "failed" }, scan, src), []);

  // Worker: wiped state, a done status.json and the request file in the repo.
  const t = setup();
  writeAndPush(
    t.work,
    {
      "members/alice.json": { handle: "alice", gitAuthors: [], joinedAt: "2026-11-06T12:35:16.150Z", aliases: ["alice-old"] },
      "bootstrap/alice-old/request.json": request("alice-old", { requestedAt: "2026-11-06T11:45:39.726Z", sessions: 6 }),
      "bootstrap/alice-old/manifest.json": manifest("alice-old", [session("s1", "2026-11-01T00:00:00Z")]),
      "bootstrap/status.json": DONE_STATUS,
    },
    "earlier server init",
  );
  const { logs } = await captureLogs(() => t.pass());
  assert.equal(logs.filter((l) => l.event === "init_started").length, 0, "no init run");
  assert.equal(t.gw()?.commands?.length ?? 0, 0);
  const saved = await loadState(t.cfg.stateDir, "demo-shop");
  assert.equal(saved.initRequests["bootstrap/alice-old/request.json"].outcome, "done");
  assert.equal(saved.initRequests["bootstrap/alice-old/request.json"].initId, DONE_STATUS.initId);
  assert.equal(saved.initProject.initializedAt, DONE_STATUS.finishedAt);
  // The sessions of the earlier run's manifest count as analysed by it (alias mapped).
  assert.deepEqual(saved.initStagedSessions, { s1: { initId: DONE_STATUS.initId, member: "alice" } });
  // The second pass starts nothing either.
  const { logs: logs2 } = await captureLogs(() => t.pass());
  assert.equal(logs2.filter((l) => l.event === "init_started").length, 0);
  const { makeCtx } = await import("./cli-helpers.mjs");
  const { dispatch } = await import("../dist/cli.js");
  const c = makeCtx(t.root);
  assert.equal(await dispatch(c, "init status", { project: "demo-shop" }, []), 0);
  assert.match(c.out.text(), /project initialized 2026-11-06T11:52:08.004Z by alice/);
});

test("init: a contribute after a done project_init with a merged manifest lays out only the new session; nothing left finishes without Letta", async () => {
  const t = setup();
  const code = bareCodeRepo(t.root);
  const m1 = session("m1", "2026-11-01T00:00:00Z");
  const m2 = session("m2", "2026-11-01T01:00:00Z");
  const m3 = session("m3", "2026-11-04T00:00:00Z", 100, "codex");
  const pkg = (sessions) => ({
    "bootstrap/minji/manifest.json": manifest("minji", sessions),
    ...Object.fromEntries(sessions.map((s) => [`bootstrap/minji/${s.file}`, JSON.stringify(fixture.records)])),
  });
  const staged = [];
  const capture = () => staged.push(JSON.parse(readFileSync(join(t.traj, "manifest.json"), "utf8")));

  // 1. project_init from the first device: m1, m2 recorded as analysed by it.
  writeAndPush(t.work, { "bootstrap/minji/request.json": request("minji", { codeRepo: code }), ...pkg([m1, m2]) }, "minji init");
  t.plan.push({ before: capture, reply: "INIT: done", commit: "init" });
  await t.pass();
  const first = t.status();
  assert.equal(first.state, "done");
  assert.equal(first.lastRun.kind, "project_init");
  let saved = await loadState(t.cfg.stateDir, "demo-shop");
  assert.deepEqual(saved.initStagedSessions, { m1: { initId: first.initId, member: "minji" }, m2: { initId: first.initId, member: "minji" } });
  assert.equal(saved.init.stagedSessions, undefined, "not kept on the finished run");

  // 2. Second device: the merged manifest keeps m1, m2 and adds m3; contribute lays out m3 only.
  writeAndPush(t.work, { "bootstrap/minji/request.json": request("minji", { codeRepo: code, requestedAt: "2026-11-07T00:00:00.000Z", sessions: 3 }), ...pkg([m1, m2, m3]) }, "minji, second device");
  t.plan.push({ before: capture, reply: "INIT: done", commit: "contrib" });
  const { logs } = await captureLogs(() => t.pass());
  const second = t.status();
  assert.equal(second.state, "done");
  assert.equal(second.lastRun.kind, "contribute");
  assert.deepEqual(staged[1].sessions.map((s) => s.sessionId), ["m3"]);
  assert.equal(staged[1].errors.filter((e) => e.error === `not laid out: already analysed by init ${first.initId}`).length, 2);
  assert.equal(second.lastRun.alreadyStaged, 2);
  assert.equal(second.lastRun.sessions, 1);
  assert.equal(second.members.minji.sessions, 1);
  assert.equal(logs.find((l) => l.event === "init_estimate").alreadyStaged, 2);
  assert.equal(t.logLines().filter((l) => l.event === "init").at(-1).alreadyStaged, 2);
  assert.match(t.gw().sent.filter((x) => x.text.startsWith("<memmem-init ")).at(-1).text, /Sessions left out because an earlier init already analysed them: 2/);
  saved = await loadState(t.cfg.stateDir, "demo-shop");
  assert.equal(saved.initStagedSessions.m3.initId, second.initId);
  assert.equal(saved.initStagedSessions.m1.initId, first.initId);

  // 3. Nothing left (history-only, every session analysed): done without a Letta turn.
  const turns = () => t.gw().sessionOpts.length;
  const before = turns();
  writeAndPush(t.work, { "bootstrap/minji/request.json": request("minji", { historyOnly: true, requestedAt: "2026-11-08T00:00:00.000Z", sessions: 3 }) }, "minji history-only");
  const { logs: logs3 } = await captureLogs(() => t.pass());
  const third = t.status();
  assert.equal(third.state, "done");
  assert.equal(third.lastRun.kind, "contribute");
  assert.equal(third.lastRun.sessions, 0);
  assert.equal(third.lastRun.alreadyStaged, 3);
  assert.equal(turns(), before, "no Letta conversation");
  const nothing = logs3.find((l) => l.event === "init_nothing_to_contribute");
  assert.equal(nothing.alreadyStaged, 3);

  // 4. A full request with no style and no repositories and nothing new: also done without Letta.
  writeAndPush(t.work, { "bootstrap/minji/request.json": request("minji", { codeRepo: code, requestedAt: "2026-11-09T00:00:00.000Z", answers: { depth: "standard", repos: [], style: "", history: true } }) }, "minji again");
  await t.pass();
  const fourth = t.status();
  assert.equal(fourth.state, "done");
  assert.equal(fourth.lastRun.kind, "contribute");
  assert.equal(fourth.lastRun.alreadyStaged, 3);
  assert.equal(turns(), before);
  assert.equal(fourth.depth, "standard");
  assert.deepEqual(fourth.initializedBy, ["minji"]);
});

test("fresh state: seedInitStagedSessions marks the manifests of done members (aliases mapped), skips pending and failed ones, runs once", () => {
  const rec = {
    depth: "standard",
    initializedAt: "2026-11-06T11:52:08.004Z",
    initializedBy: ["alice"],
    repos: [],
    members: {
      alice: { kind: "project_init", sessions: 2, finishedAt: "2026-11-06T11:52:08.004Z", initId: "init-a", state: "done", uploadedAs: "alice-old" },
      minji: { kind: "contribute", sessions: 0, finishedAt: "2026-11-06T12:00:00Z", initId: "init-b", state: "failed" },
      joon: { kind: "contribute", sessions: 1, finishedAt: "2026-11-06T13:00:00Z", initId: "init-c", state: "done" },
      lee: { kind: "contribute", sessions: 1, finishedAt: "2026-11-06T14:00:00Z", initId: "init-d", state: "done" },
    },
  };
  const src = {
    manifestSessionIds: { "alice-old": ["s1", "s2"], minji: ["m1"], jj: ["j1"], lee: ["l1"] },
    aliases: new Map([["alice-old", "alice"], ["jj", "joon"]]),
  };
  const st = emptyState();
  assert.equal(st.initStagedSessions, undefined);
  assert.equal(seedInitStagedSessions(st, rec, src, ["bootstrap/jj/request.json"]), 3);
  assert.deepEqual(st.initStagedSessions, {
    s1: { initId: "init-a", member: "alice" },
    s2: { initId: "init-a", member: "alice" },
    l1: { initId: "init-d", member: "lee" },
  });
  assert.equal(seedInitStagedSessions(st, rec, src), null, "a present map is left alone");
  const none = emptyState();
  assert.equal(seedInitStagedSessions(none, { ...rec, initializedAt: null }, src), null, "no completed init");
  assert.equal(none.initStagedSessions, undefined);
  assert.equal(seedInitStagedSessions(none, null, src), null);
});

test("init language: the project's language wins over the request's; the override is logged", async () => {
  const req = (member, language) => ({ path: `bootstrap/${member}/request.json`, blob: "1", member, doc: request(member, { language }) });
  const merged = mergeRequests([req("minji", "en"), req("joon", "ko")]);
  const same = applyProjectLanguage(merged, "ko");
  assert.equal(same.plan.language, "ko");
  assert.deepEqual(same.requested, ["en"]);
  assert.deepEqual(applyProjectLanguage(mergeRequests([req("minji", "ko")]), "ko").requested, []);
  const text = buildPreAnswerTurn({ project: "demo-shop", initId: "init-1", plan: same.plan, history: null, codeDir: null, codeHead: null, relatedDirs: [], historyModel: null });
  assert.match(text, /- Language: write memory in Korean \(한국어\)\. Sessions and remember notes in other languages are recorded in Korean \(한국어\)\. Keep proper nouns, titles, identifiers and code verbatim\./);

  const t = setup();
  t.cfg.projects[0].language = "ko";
  const code = bareCodeRepo(t.root);
  writeAndPush(t.work, { "bootstrap/minji/request.json": request("minji", { language: "en", codeRepo: code, answers: { depth: "standard", repos: [], style: "terse", history: false } }) }, "init request");
  t.plan.push({ reply: "Built the memory.\nINIT: done", commit: "project" });
  const { logs } = await captureLogs(() => t.pass());
  const pre = t.gw().sent.find((x) => x.text.startsWith("<memmem-init "));
  assert.match(pre.text, /write memory in Korean \(한국어\)/);
  assert.doesNotMatch(pre.text, /write memory in English/);
  const o = logs.find((l) => l.event === "init_language_overridden");
  assert.ok(o, "init_language_overridden logged");
  assert.equal(o.requested, "en");
  assert.equal(o.language, "ko");
});
