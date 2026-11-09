// Worker flow against real git repos and a fake App Server session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";
import { LettaGateway, TurnError } from "../dist/letta.js";
import { loadState, localDate } from "../dist/state.js";
import { Worker } from "../dist/worker.js";
import { fakeMemfs, seededTranscriptsRepo, sh, tempDir, writeAndPush } from "./helpers.mjs";

const AGENT = "agent-local-test";
const fixture = JSON.parse(readFileSync(new URL("./fixtures/trajectory-small.json", import.meta.url), "utf8"));
const TRAJ = "trajectories/2026-11/minji/claude-code/2026-11-02T09-00-00_s1.json";
const NOTE = "inbox/minji/2026-11-02-ttl.md";

/** Subagent reports, in the shapes seen from Letta Code 0.34.41 reflections. */
const REPORT = {
  committed: "## Summary\nRecorded the session.\n\n## Commit\nabc\n\n## Issues\nNone.\n\nRESULT: committed",
  // Run 1: the edit was denied and the subagent gave up (no RESULT line).
  guardDenied: "## Summary\nPlanned a decision file.\n\n## Commit\nNo commit.\n\n## Issues\nPermission denied by cross-agent memory guard.",
  // The acme sessions: a correct "nothing worth saving".
  empty: "## Summary\nOnly debugging chatter; no durable project facts.\n\n## Memory changes\nNone.\n\n## Commit\nNo commit.\n\n## Issues\nNone.\n\nRESULT: nothing-to-save",
  // No RESULT line, no sections, no failure or skip wording.
  vague: "Reviewed the transcript.",
};

/** A pi `usage` record as Letta Code 0.34.41 writes it on assistant messages. */
const SUB_USAGE = { input: 148, output: 116, cacheRead: 17792, cacheWrite: 0, reasoning: 0, totalTokens: 18056, cost: { input: 0.001, output: 0.002, cacheRead: 0.007, cacheWrite: 0, total: 0.01 } };
const assistantWithUsage = (content, ts) => ({
  type: "message",
  id: `e${Math.random()}`,
  timestamp: ts,
  message: { role: "assistant", content, provider: "openai-codex", model: "gpt-5.6-sol", usage: SUB_USAGE, timestamp: Date.parse(ts) },
});

/** A tool result line in the real `messages.jsonl` shape. */
const toolResult = (toolName, text, isError) => ({
  type: "message",
  message: { role: "toolResult", toolCallId: `call_${Math.random()}`, toolName, content: [{ type: "text", text }], isError, timestamp: Date.now() },
});

/**
 * A reflection plan: `true` (commit), `false` (no commit, guard-denied
 * report), or `{commit, report, toolResults}`; `report: null` leaves no
 * subagent record at all.
 */
function normalizePlan(plan) {
  if (plan === true) return { commit: true, report: REPORT.committed, toolResults: [] };
  if (plan === false) return { commit: false, report: REPORT.guardDenied, toolResults: [] };
  return { toolResults: [], ...plan };
}

/**
 * Simulates Letta with the step-count trigger off: each turn is one step, and
 * `reflect` starts a reflection over the unreflected steps that commits to
 * MemFS shortly after (or not, per `commitPlan` / `reflectionChangesMemory`).
 * Each reflection also leaves a hidden subagent record like Letta's local
 * backend, so the worker's report and tool-error readers run against the real layout.
 */
class FakeGateway extends LettaGateway {
  constructor(url, paths) {
    super(url, paths);
    this.reflectionChangesMemory = true;
    /** Per-reflection overrides of reflectionChangesMemory, consumed in order. */
    this.commitPlan = [];
    this.sent = [];
    this.reflects = [];
    this.convCounter = 0;
    this.subCounter = 0;
    this.failNext = null;
  }
  statePath(conv) {
    return join(this.paths.transcriptRoot, AGENT, conv, "state.json");
  }
  readState(conv) {
    try {
      return JSON.parse(readFileSync(this.statePath(conv), "utf8"));
    } catch {
      return { total_completed_steps: 0, reflected_completed_steps: 0, steps_since_last_successful_reflection: 0 };
    }
  }
  writeState(conv, st) {
    mkdirSync(join(this.paths.transcriptRoot, AGENT, conv), { recursive: true });
    writeFileSync(this.statePath(conv), JSON.stringify(st));
  }
  writeSubagentRecord(plan) {
    if (plan.report === null) return;
    const id = `agent-local-sub-${++this.subCounter}`;
    const base = join(this.paths.lettaConfigDir, "lc-local-backend");
    const b64 = (x) => Buffer.from(x).toString("base64url");
    mkdirSync(join(base, "agents"), { recursive: true });
    writeFileSync(join(base, "agents", `${b64(id)}.json`), JSON.stringify({ id, tags: ["type:reflection", `parent:${AGENT}`], hidden: true }));
    const dir = join(base, "conversations", b64(`default:${id}`));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "conversation.json"), JSON.stringify({ id: "default", agent_id: id, created_at: new Date().toISOString() }));
    writeFileSync(
      join(dir, "messages.jsonl"),
      [
        { type: "session", id: "default" },
        // An earlier run in the same conversation: outside this reflection's window, not counted.
        assistantWithUsage([{ type: "text", text: "old run" }], "2026-01-01T00:00:00.000Z"),
        { type: "message", message: { role: "user", content: [{ type: "text", text: "Review the conversation transcript payload" }] } },
        assistantWithUsage([{ type: "toolCall", name: "Bash", arguments: {} }], new Date().toISOString()),
        ...plan.toolResults.map(([name, text, isError]) => toolResult(name, text, isError)),
        assistantWithUsage([{ type: "text", text: plan.report }], new Date().toISOString()),
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
  }
  startReflection(conv) {
    const st = this.readState(conv);
    st.last_reflection_started_at = new Date().toISOString();
    this.writeState(conv, st);
    const plan = normalizePlan(this.commitPlan.length ? this.commitPlan.shift() : this.reflectionChangesMemory);
    setTimeout(() => {
      const memfs = this.memfsDir(AGENT);
      this.writeSubagentRecord(plan);
      if (plan.commit) {
        writeFileSync(join(memfs, "MEMORY.md"), `# Memory\n- reflected ${Date.now()} ${Math.random()}\n`);
        sh(memfs, "add", "-A");
        sh(memfs, "commit", "--quiet", "-m", "feat(reflection): fake 🔮");
      }
      const s = this.readState(conv);
      s.reflected_completed_steps = s.total_completed_steps;
      s.steps_since_last_successful_reflection = 0;
      s.last_reflection_succeeded_at = new Date().toISOString();
      this.writeState(conv, s);
    }, 300);
  }
  async openSession(agentId, conversationId, opts) {
    const conv = conversationId ?? `local-conv-${++this.convCounter}`;
    const gw = this;
    return {
      agentId,
      conversationId: conv,
      async sendTurn(text) {
        if (gw.failNext) {
          const e = gw.failNext;
          gw.failNext = null;
          throw e;
        }
        gw.sent.push({ conv, text });
        const st = gw.readState(conv);
        st.total_completed_steps += 1;
        st.steps_since_last_successful_reflection += 1;
        gw.writeState(conv, st);
        await new Promise((r) => setTimeout(r, 25));
        return { conversationId: conv, reply: "ok.", durationMs: 5, usage: { promptTokens: 100, completionTokens: 3 } };
      },
      async reflect(instruction) {
        gw.reflects.push({ conv, instruction });
        if (gw.readState(conv).steps_since_last_successful_reflection === 0) {
          return { outcome: "nothing_to_reflect", output: "No new transcript content to reflect on for this conversation." };
        }
        gw.startReflection(conv);
        return { outcome: "started", output: "Started a reflection pass for this conversation." };
      },
      close() {},
    };
  }
}

/** Capture the worker's JSON log lines while `fn` runs. */
async function captureLogs(fn) {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    for (const l of String(chunk).split("\n")) {
      if (!l.trim()) continue;
      try {
        lines.push(JSON.parse(l));
        continue;
      } catch {
        // not a log line
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

function setup(settings = {}) {
  const root = tempDir("memmem-worker-");
  const { bare, work } = seededTranscriptsRepo(root);
  const memoryRemote = join(root, "memory.git");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", memoryRemote]);
  const letta = join(root, "letta");
  fakeMemfs(join(letta, "lc-local-backend", "memfs", AGENT, "memory"));
  const configPath = join(root, "projects.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      settings: { stepCount: 2, dailyReflectHour: null, ingestMaxChars: 40000, reflectionWaitSeconds: 10, ...settings },
      projects: [{ project: "demo-shop", agentId: AGENT, memoryRepo: memoryRemote, transcriptsRepo: bare }],
    }),
  );
  const cfg = loadConfig({ MEMMEM_CONFIG: configPath, MEMMEM_SERVER_HOME: root, LETTA_CONFIG_DIR: letta, MEMMEM_ONCE: "1" });
  let gateway;
  const worker = new Worker(
    () => cfg,
    (url, paths) => (gateway = new FakeGateway(url, paths)),
  );
  const logLines = () =>
    execFileSync("git", ["--git-dir", bare, "show", "main:ingest/log.jsonl"], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  const freshWorker = (opts = {}) => {
    const stateDir = join(root, `state-${Date.now()}`);
    const cfg2 = { ...cfg, stateDir, reposDir: join(stateDir, "repos") };
    let g2;
    const w = new Worker(
      () => cfg2,
      (url, paths) => {
        g2 = new FakeGateway(url, paths);
        Object.assign(g2, opts);
        return g2;
      },
    );
    return { worker: w, cfg: cfg2, gw: () => g2 };
  };
  return { root, bare, work, memoryRemote, letta, cfg, worker, gw: () => gateway, logLines, freshWorker };
}

test("one pass ingests, waits for reflection, pushes memory, and commits the log", async () => {
  const t = setup();
  writeAndPush(t.work, { [TRAJ]: fixture, [NOTE]: "# TTL\nProduct list cache TTL is 60s.\n" });
  assert.equal(await t.worker.run(), 0);

  const gw = t.gw();
  assert.equal(gw.sent.length, 2);
  assert.match(gw.sent[0].text, /^<team-memory-note project="demo-shop" member="minji"/); // inbox sorts first
  assert.match(gw.sent[1].text, /^<team-memory-ingest project="demo-shop" member="minji" tool="claude-code" session="s1"/);

  const memHead = sh(gw.memfsDir(AGENT), "rev-parse", "main");
  assert.equal(execFileSync("git", ["--git-dir", t.memoryRemote, "rev-parse", "main"], { encoding: "utf8" }).trim(), memHead);

  const lines = t.logLines();
  const ingests = lines.filter((l) => l.event === "ingest");
  const refl = lines.filter((l) => l.event === "reflection");
  assert.equal(ingests.length, 2);
  assert.equal(refl.length, 1);
  assert.equal(refl[0].reflectionCommit, memHead);
  assert.deepEqual(refl[0].files.sort(), [NOTE, TRAJ].sort());
  assert.equal(refl[0].outcome, "committed");
  for (const e of ingests) {
    assert.equal(e.reflectionCommit, memHead);
    assert.equal(e.reflectionOutcome, "committed");
    assert.equal(e.project, "demo-shop");
    assert.equal(e.conversationId, "local-conv-1");
    assert.deepEqual(e.usage, { input: 100, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 103, costUsd: null });
  }
  // Reflection usage: the subagent's two messages of this run (not the earlier run's), Letta's cost, the model handle.
  const reflUsage = { input: 296, output: 232, cacheRead: 35584, cacheWrite: 0, reasoning: 0, total: 36112, costUsd: 0.02 };
  assert.deepEqual(refl[0].usage, reflUsage);
  assert.equal(refl[0].model, "openai-codex/gpt-5.6-sol");

  const st = await loadState(t.cfg.stateDir, "demo-shop");
  assert.deepEqual(st.lastReflection.usage, reflUsage);
  assert.equal(st.lastReflection.model, "openai-codex/gpt-5.6-sol");
  const day = st.usage[localDate()];
  assert.deepEqual(day.ingest, { turns: 2, input: 200, output: 6, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 206, costUsd: null });
  assert.deepEqual(day.reflection, { turns: 1, ...reflUsage });
  assert.equal(day.init, undefined);
  assert.equal(st.queue.length, 0);
  assert.equal(st.unreflected.length, 0);
  assert.equal(st.pendingLog.length, 0);
  assert.equal(st.lastPushedMemoryHead, memHead);
  assert.equal(st.files[TRAJ].records, 10);

  // A second pass with no changes sends nothing.
  const results = await t.worker.runPass(t.cfg);
  assert.equal(results[0].ingested, 0);
  assert.equal(gw.sent.length, 2);

  // A grown trajectory sends only the new records, in the same daily conversation.
  const grown = { records: [...fixture.records, { role: "user", content: "Also add a test for 200 items." }] };
  writeAndPush(t.work, { [TRAJ]: grown }, "session continued");
  const r3 = await t.worker.runPass(t.cfg);
  assert.equal(r3[0].ingested, 1);
  assert.equal(gw.sent.length, 3);
  assert.match(gw.sent[2].text, /from-record="10">\n/);
  assert.equal(gw.sent[2].conv, "local-conv-1");
});

test("provider errors back off and keep the file queued", async () => {
  const t = setup();
  writeAndPush(t.work, { [TRAJ]: fixture });
  // First run creates the gateway; make its first turn fail with a quota error.
  const origOpen = FakeGateway.prototype.openSession;
  FakeGateway.prototype.openSession = async function (...args) {
    this.failNext = new TurnError("You have hit your usage limit", "provider");
    FakeGateway.prototype.openSession = origOpen;
    return origOpen.apply(this, args);
  };
  assert.equal(await t.worker.run(), 1);
  const st = await loadState(t.cfg.stateDir, "demo-shop");
  assert.equal(st.queue.length, 1);
  assert.equal(st.queue[0].attempts, 0);
  assert.equal(st.backoff.failures, 1);
  assert.ok(Date.parse(st.backoff.until) > Date.now());
  assert.match(st.backoff.reason, /provider/);

  // While backing off, the project is skipped.
  const r = await t.worker.runPass(t.cfg);
  assert.equal(r[0].ingested, 0);
  assert.equal(t.gw().sent.length, 0);
});

test("a reflection that failed to save is retried once, then carried forward to the next reflection", async () => {
  const t = setup();
  writeAndPush(t.work, { [TRAJ]: fixture, [NOTE]: "note" });
  assert.equal(await t.worker.run(), 0); // first worker: reflection with a commit
  const memHead = sh(t.gw().memfsDir(AGENT), "rev-parse", "main");
  const memfsRoot = join(t.letta, "lc-local-backend", "memfs", AGENT);
  assert.match(t.gw().reflects[0].instruction, new RegExp(`primary agent id is ${AGENT}`));
  assert.ok(t.gw().reflects[0].instruction.includes(`${memfsRoot}/memory`));
  assert.match(t.gw().reflects[0].instruction, /Language: write memory in English\./, "projects.json without a language: en");

  // A second worker with empty state ingests the same files again; this
  // time neither the reflection nor its retry changes MemFS main.
  const f = t.freshWorker({ reflectionChangesMemory: false });
  const { logs } = await captureLogs(() => f.worker.run());
  const gw = f.gw();
  assert.equal(gw.sent.length, 3); // two sessions + the retry marker turn
  assert.match(gw.sent[2].text, /^<team-memory-retry project="demo-shop" sessions="[^"]*s1/);
  assert.equal(gw.reflects.length, 2);
  assert.doesNotMatch(gw.reflects[0].instruction, /previous reflection could not save/);
  assert.match(gw.reflects[0].instruction, /End your report with exactly one line: "RESULT: committed"/);
  assert.match(
    gw.reflects[1].instruction,
    /^The previous reflection could not save its changes \(Permission denied by cross-agent memory guard\.\)\. Record what is worth keeping under the Rules for reflection; if nothing is, end with RESULT: nothing-to-save\./,
  );
  assert.doesNotMatch(gw.reflects[1].instruction, /still need to be recorded/);
  assert.match(gw.reflects[1].instruction, /session s1 \(member minji, tool claude-code\): .*local-conv-1\/transcript\.jsonl/);
  assert.equal(sh(gw.memfsDir(AGENT), "rev-parse", "main"), memHead);

  const noCommit = logs.find((l) => l.event === "reflection_no_commit");
  assert.ok(noCommit, "reflection_no_commit logged");
  assert.equal(noCommit.level, "warn");
  assert.equal(noCommit.outcome, "failed");
  assert.match(noCommit.reason, /memory guard/);
  assert.equal(logs.find((l) => l.event === "reflection_retry").outcome, "failed");
  assert.ok(!logs.some((l) => l.event === "reflection_empty"));
  assert.ok(noCommit.sessions.includes("minji:s1"));
  assert.match(noCommit.report, /Permission denied by cross-agent memory guard/);
  assert.ok(noCommit.report.length <= 500);
  const done = logs.find((l) => l.event === "reflection_done");
  assert.match(done.report, /No commit/);
  assert.equal(done.outcome, "failed");
  assert.equal(done.outcomeSource, "report_prose");
  // A failed reflection still spent tokens: its usage is logged and counted.
  assert.equal(done.usage.total, 36112);
  assert.equal(done.model, "openai-codex/gpt-5.6-sol");

  const last = t.logLines().slice(-4);
  const refl = last.filter((l) => l.event === "reflection");
  assert.equal(refl.length, 2);
  assert.deepEqual(refl.map((r) => r.reflectionCommit), [null, null]);
  assert.deepEqual(refl.map((r) => r.outcome), ["failed", "failed"]);
  assert.equal(refl[1].retry, true);
  for (const r of refl) assert.deepEqual(r.files.sort(), [NOTE, TRAJ].sort());
  for (const e of last.filter((l) => l.event === "ingest")) {
    assert.equal(e.reflectionCommit, null);
    assert.equal(e.reflectionOutcome, "failed");
  }

  let st = await loadState(f.cfg.stateDir, "demo-shop");
  assert.deepEqual(st.pendingReflection.map((x) => x.file).sort(), [NOTE, TRAJ].sort());
  assert.equal(st.pendingReflection.find((x) => x.file === TRAJ).session, "s1");
  assert.equal(st.unreflected.length, 0);

  // Next scheduled reflection: its instruction names the carried sessions,
  // and its commit is recorded for them too.
  gw.reflectionChangesMemory = true;
  const TRAJ2 = "trajectories/2026-11/jun/codex/2026-11-02T10-00-00_s2.json";
  const TRAJ3 = "trajectories/2026-11/jun/codex/2026-11-02T11-00-00_s3.json";
  writeAndPush(t.work, { [TRAJ2]: fixture, [TRAJ3]: fixture }, "two more sessions");
  const { logs: logs2 } = await captureLogs(() => f.worker.runPass(f.cfg));
  assert.equal(gw.reflects.length, 3);
  assert.match(gw.reflects[2].instruction, /Sessions still to review/);
  assert.match(gw.reflects[2].instruction, /session s1 \(member minji/);
  const newHead = sh(gw.memfsDir(AGENT), "rev-parse", "main");
  assert.notEqual(newHead, memHead);
  const lines = t.logLines();
  const carried = lines.find((l) => l.event === "reflection" && l.carriedForward);
  assert.ok(carried, "carried-forward reflection entry");
  assert.equal(carried.reflectionCommit, newHead);
  assert.equal(carried.outcome, "committed");
  assert.deepEqual(carried.files.sort(), [NOTE, TRAJ].sort());
  const main = lines.filter((l) => l.event === "reflection" && !l.carriedForward).at(-1);
  assert.deepEqual(main.files.sort(), [TRAJ2, TRAJ3].sort());
  // One run, one usage: the carried-forward entry does not repeat it.
  assert.equal(main.usage.total, 36112);
  assert.equal(carried.usage, undefined);
  assert.ok(logs2.some((l) => l.event === "reflection_pending_recorded"));
  st = await loadState(f.cfg.stateDir, "demo-shop");
  assert.deepEqual(st.pendingReflection, []);
});

test("a commit on the retry is recorded for the sessions of the first try", async () => {
  const t = setup();
  const f = t.freshWorker({ commitPlan: [false, true] });
  writeAndPush(t.work, { [TRAJ]: fixture, [NOTE]: "note" });
  assert.equal(await f.worker.run(), 0);
  const gw = f.gw();
  assert.equal(gw.reflects.length, 2);
  const memHead = sh(gw.memfsDir(AGENT), "rev-parse", "main");
  const lines = t.logLines();
  const refl = lines.filter((l) => l.event === "reflection");
  assert.deepEqual(refl.map((r) => r.reflectionCommit), [null, memHead]);
  assert.deepEqual(refl.map((r) => r.outcome), ["failed", "committed"]);
  assert.equal(refl[1].retry, true);
  for (const e of lines.filter((l) => l.event === "ingest")) {
    assert.equal(e.reflectionCommit, memHead);
    assert.equal(e.reflectionOutcome, "committed");
  }
  const st = await loadState(f.cfg.stateDir, "demo-shop");
  assert.deepEqual(st.pendingReflection, []);
  assert.equal(execFileSync("git", ["--git-dir", t.memoryRemote, "rev-parse", "main"], { encoding: "utf8" }).trim(), memHead);
});

test("a backoff saved by an earlier process does not delay the first pass", async () => {
  const t = setup();
  writeAndPush(t.work, { [TRAJ]: fixture, [NOTE]: "note" });
  const until = new Date(Date.now() + 3_600_000).toISOString();
  mkdirSync(t.cfg.stateDir, { recursive: true });
  writeFileSync(join(t.cfg.stateDir, "demo-shop.json"), JSON.stringify({ backoff: { failures: 4, until, reason: "connection: down" } }));
  const { result, logs } = await captureLogs(() => t.worker.run());
  assert.equal(result, 0);
  assert.equal(t.gw().sent.length, 2);
  const reset = logs.find((l) => l.event === "backoff_reset");
  assert.equal(reset.previousFailures, 4);
  assert.equal(reset.previousUntil, until);
  const st = await loadState(t.cfg.stateDir, "demo-shop");
  assert.deepEqual(st.backoff, { failures: 0, until: null });
});

const grow = (n) => ({
  records: [...fixture.records, ...Array.from({ length: n }, (_, i) => ({ role: "user", content: `Follow-up ${i + 1}: keep the pagination test.` }))],
});

test("a re-ingested session counts as one step until a reflection covers it", async () => {
  const t = setup({ stepCount: 2 });
  writeAndPush(t.work, { [TRAJ]: fixture });
  const { logs } = await captureLogs(() => t.worker.run());
  const gw = t.gw();
  let st = await loadState(t.cfg.stateDir, "demo-shop");
  assert.equal(st.unreflected.length, 1);
  assert.equal(gw.reflects.length, 0);
  assert.equal(logs.find((l) => l.event === "turn_done").fromRecord, 0);
  const firstSentAt = st.unreflected[0].sentAt;

  // The client checkpoint re-syncs the growing session: still one step.
  writeAndPush(t.work, { [TRAJ]: grow(1) }, "checkpoint 1");
  const { result: r2, logs: logs2 } = await captureLogs(() => t.worker.runPass(t.cfg));
  assert.equal(r2[0].ingested, 1);
  assert.equal(gw.sent.length, 2);
  assert.match(gw.sent[1].text, /from-record="10">/);
  assert.equal(logs2.find((l) => l.event === "turn_done").fromRecord, 10);
  st = await loadState(t.cfg.stateDir, "demo-shop");
  assert.equal(st.unreflected.length, 1, "same file and conversation: one unreflected item");
  assert.ok(st.unreflected[0].sentAt > firstSentAt, "sentAt moved forward");
  assert.equal(st.unreflected[0].session, "s1");
  assert.equal(gw.reflects.length, 0, "a re-ingest does not reach stepCount on its own");

  // A second distinct file reaches stepCount = 2.
  writeAndPush(t.work, { [NOTE]: "note" }, "note");
  await t.worker.runPass(t.cfg);
  assert.equal(gw.reflects.length, 1);
  st = await loadState(t.cfg.stateDir, "demo-shop");
  assert.equal(st.unreflected.length, 0);

  // After the reflection, the next re-ingest counts again (once).
  writeAndPush(t.work, { [TRAJ]: grow(2) }, "checkpoint 2");
  await t.worker.runPass(t.cfg);
  writeAndPush(t.work, { [TRAJ]: grow(3) }, "checkpoint 3");
  await t.worker.runPass(t.cfg);
  st = await loadState(t.cfg.stateDir, "demo-shop");
  assert.deepEqual(st.unreflected.map((u) => u.file), [TRAJ]);
  assert.equal(gw.reflects.length, 1);
  assert.equal(gw.sent.length, 5);
});

test("a reflection that started before the latest re-ingest does not cover that file", async () => {
  const t = setup({ stepCount: 5 });
  writeAndPush(t.work, { [TRAJ]: fixture, [NOTE]: "note" });
  assert.equal(await t.worker.run(), 0);
  const gw = t.gw();
  const conv = "local-conv-1";
  const reflectionStartedAt = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 20));

  writeAndPush(t.work, { [TRAJ]: grow(1) }, "checkpoint");
  await t.worker.runPass(t.cfg);
  let st = await loadState(t.cfg.stateDir, "demo-shop");
  assert.equal(st.unreflected.length, 2);
  assert.ok(st.unreflected.find((u) => u.file === TRAJ).sentAt > reflectionStartedAt);

  // A reflection the worker did not launch finishes now; it started before
  // the re-ingest, so it covers the note but not the session's new tail.
  const s = gw.readState(conv);
  gw.writeState(conv, { ...s, last_reflection_started_at: reflectionStartedAt, last_reflection_succeeded_at: new Date().toISOString() });
  const { logs } = await captureLogs(() => t.worker.runPass(t.cfg));
  assert.equal(logs.find((l) => l.event === "reflection_recorded").trigger, "collected");
  st = await loadState(t.cfg.stateDir, "demo-shop");
  assert.deepEqual(st.unreflected.map((u) => u.file), [TRAJ]);
  const refl = t.logLines().filter((l) => l.event === "reflection").at(-1);
  assert.deepEqual(refl.files, [NOTE]);
});

test("a reflection that finds nothing worth saving is accepted: no retry, no carry-forward", async () => {
  const t = setup();
  const f = t.freshWorker({ commitPlan: [{ commit: false, report: REPORT.empty }] });
  writeAndPush(t.work, { [TRAJ]: fixture, [NOTE]: "note" });
  const memHead = sh(join(t.letta, "lc-local-backend", "memfs", AGENT, "memory"), "rev-parse", "main");
  const { result, logs } = await captureLogs(() => f.worker.run());
  assert.equal(result, 0);
  const gw = f.gw();
  assert.equal(gw.reflects.length, 1, "no retry reflection");
  assert.equal(gw.sent.length, 2, "no retry marker turn");
  assert.equal(sh(gw.memfsDir(AGENT), "rev-parse", "main"), memHead);
  for (const ev of ["reflection_retry", "reflection_no_commit"]) assert.ok(!logs.some((l) => l.event === ev), `${ev} not logged`);

  const empty = logs.find((l) => l.event === "reflection_empty");
  assert.ok(empty, "reflection_empty logged");
  assert.equal(empty.level, "info");
  assert.equal(empty.outcome, "nothing_to_save");
  assert.equal(empty.outcomeSource, "result_line");
  assert.ok(empty.sessions.includes("minji:s1"));
  assert.match(empty.report, /RESULT: nothing-to-save/);
  const done = logs.find((l) => l.event === "reflection_done");
  assert.equal(done.outcome, "nothing_to_save");
  assert.equal(done.toolErrors, undefined);
  assert.equal(logs.find((l) => l.event === "reflection_recorded").outcome, "nothing_to_save");

  const lines = t.logLines();
  const refl = lines.filter((l) => l.event === "reflection");
  assert.equal(refl.length, 1);
  assert.equal(refl[0].reflectionCommit, null);
  assert.equal(refl[0].outcome, "nothing_to_save");
  assert.equal(refl[0].retry, undefined);
  for (const e of lines.filter((l) => l.event === "ingest")) {
    assert.equal(e.reflectionCommit, null);
    assert.equal(e.reflectionOutcome, "nothing_to_save");
  }
  const st = await loadState(f.cfg.stateDir, "demo-shop");
  assert.deepEqual(st.pendingReflection, []);
  assert.deepEqual(st.unreflected, []);
});

test("an unknown outcome (no report) is retried", async () => {
  const t = setup();
  const f = t.freshWorker({ commitPlan: [{ commit: false, report: null }, { commit: false, report: REPORT.vague }] });
  writeAndPush(t.work, { [TRAJ]: fixture, [NOTE]: "note" });
  const { logs } = await captureLogs(() => f.worker.run());
  const gw = f.gw();
  assert.equal(gw.reflects.length, 2);
  assert.match(gw.sent[2].text, /^<team-memory-retry /);
  assert.match(gw.reflects[1].instruction, /^The previous reflection could not save its changes \(no reflection report found\)\./);
  const retry = logs.find((l) => l.event === "reflection_retry");
  assert.equal(retry.outcome, "unknown");
  const noCommit = logs.find((l) => l.event === "reflection_no_commit");
  assert.equal(noCommit.outcome, "unknown");
  assert.deepEqual(t.logLines().filter((l) => l.event === "reflection").map((r) => r.outcome), ["unknown", "unknown"]);
  const st = await loadState(f.cfg.stateDir, "demo-shop");
  assert.deepEqual(st.pendingReflection.map((x) => x.file).sort(), [NOTE, TRAJ].sort());
});

test("failed tool results mark a reflection failed; a retry that finds nothing worth saving is accepted", async () => {
  const t = setup();
  const denied = {
    commit: false,
    // No RESULT line, and prose that would read as "nothing to save": the tool errors decide.
    report: "## Summary\nNothing new.\n\n## Commit\nNo commit.\n\n## Issues\nNone.",
    toolResults: [
      ["Bash", "Exit code: 1\n{\"text\":\"user: docker says permission denied on /var/run\"}", false],
      ["Edit", "Permission denied by cross-agent memory guard (agent-local-x). Allowed: agent-local-y.", true],
    ],
  };
  const f = t.freshWorker({ commitPlan: [denied, { commit: false, report: REPORT.empty }] });
  writeAndPush(t.work, { [TRAJ]: fixture, [NOTE]: "note" });
  const { logs } = await captureLogs(() => f.worker.run());
  const gw = f.gw();
  assert.equal(gw.reflects.length, 2);
  assert.match(gw.reflects[1].instruction, /could not save its changes \(Edit: Permission denied by cross-agent memory guard/);
  const done = logs.filter((l) => l.event === "reflection_done");
  assert.equal(done[0].outcome, "failed");
  assert.equal(done[0].outcomeSource, "tool_errors");
  assert.equal(done[0].toolErrors.count, 1, "the Bash output that only mentions 'permission denied' is not an error");
  assert.match(done[0].toolErrors.first, /^Edit: Permission denied by cross-agent memory guard/);
  assert.equal(logs.find((l) => l.event === "reflection_recorded").toolErrors.count, 1);
  assert.equal(done[1].outcome, "nothing_to_save");
  assert.ok(!logs.some((l) => l.event === "reflection_no_commit"));
  const empty = logs.find((l) => l.event === "reflection_empty");
  assert.equal(empty.trigger, "step-count-retry");

  const lines = t.logLines();
  const refl = lines.filter((l) => l.event === "reflection");
  assert.deepEqual(refl.map((r) => [r.outcome, r.reflectionCommit, r.retry ?? false]), [
    ["failed", null, false],
    ["nothing_to_save", null, true],
  ]);
  for (const e of lines.filter((l) => l.event === "ingest")) {
    assert.equal(e.reflectionCommit, null);
    assert.equal(e.reflectionOutcome, "nothing_to_save", "the retry's outcome replaces the first try's");
  }
  const st = await loadState(f.cfg.stateDir, "demo-shop");
  assert.deepEqual(st.pendingReflection, []);
});

test("a later reflection that finds nothing worth saving resolves the carried sessions it was given", async () => {
  const t = setup();
  const f = t.freshWorker({ commitPlan: [false, false, { commit: false, report: REPORT.empty }] });
  writeAndPush(t.work, { [TRAJ]: fixture, [NOTE]: "note" });
  await captureLogs(() => f.worker.run());
  let st = await loadState(f.cfg.stateDir, "demo-shop");
  assert.equal(st.pendingReflection.length, 2);

  const TRAJ2 = "trajectories/2026-11/jun/codex/2026-11-02T10-00-00_s2.json";
  const TRAJ3 = "trajectories/2026-11/jun/codex/2026-11-02T11-00-00_s3.json";
  writeAndPush(t.work, { [TRAJ2]: fixture, [TRAJ3]: fixture }, "two more sessions");
  const { logs } = await captureLogs(() => f.worker.runPass(f.cfg));
  const gw = f.gw();
  assert.equal(gw.reflects.length, 3, "no retry after nothing_to_save");
  assert.match(gw.reflects[2].instruction, /Sessions still to review/);
  assert.ok(logs.some((l) => l.event === "reflection_empty"));
  const pend = logs.find((l) => l.event === "reflection_pending_recorded");
  assert.equal(pend.outcome, "nothing_to_save");
  const carried = t.logLines().find((l) => l.event === "reflection" && l.carriedForward);
  assert.equal(carried.outcome, "nothing_to_save");
  assert.equal(carried.reflectionCommit, null);
  assert.deepEqual(carried.files.sort(), [NOTE, TRAJ].sort());
  st = await loadState(f.cfg.stateDir, "demo-shop");
  assert.deepEqual(st.pendingReflection, []);
});

test("reflect now (manual) runs the scheduled path once and records it like any reflection", async () => {
  const t = setup({ stepCount: 5 });
  writeAndPush(t.work, { [TRAJ]: fixture, [NOTE]: "note" });
  assert.equal(await t.worker.run(), 0);
  const gw = t.gw();
  assert.equal(gw.reflects.length, 0, "stepCount 5 not reached");
  let st = await loadState(t.cfg.stateDir, "demo-shop");
  assert.equal(st.unreflected.length, 2);

  const r = await t.worker.reflectOnce(t.cfg, "demo-shop", "now");
  assert.equal(r.ok, true);
  assert.equal(r.reflections, 1);
  assert.equal(r.entries[0].trigger, "manual");
  assert.equal(r.entries[0].outcome, "committed");
  assert.deepEqual(r.entries[0].files.sort(), [NOTE, TRAJ].sort());
  assert.equal(r.pushed, sh(gw.memfsDir(AGENT), "rev-parse", "main"));
  assert.equal(r.unreflected, 0);
  st = await loadState(t.cfg.stateDir, "demo-shop");
  assert.equal(st.lastReflection.trigger, "manual");
  assert.equal(st.pendingLog.length, 0);
  assert.equal(t.logLines().filter((l) => l.event === "reflection" && l.trigger === "manual").length, 1);

  // Nothing left: a second run is a no-op that still succeeds.
  const again = await t.worker.reflectOnce(t.cfg, "demo-shop", "now");
  assert.equal(again.ok, true);
  assert.equal(again.reflections, 0);
  assert.match(again.message, /nothing to reflect/);
  assert.equal(gw.reflects.length, 1);
  await assert.rejects(t.worker.reflectOnce(t.cfg, "nope", "now"), /unknown project/);
});

test("CLI requests in requestsDir run between passes and leave a result file", async () => {
  const t = setup({ stepCount: 5 });
  writeAndPush(t.work, { [TRAJ]: fixture });
  assert.equal(await t.worker.run(), 0);
  const dir = join(t.root, "requests");
  t.cfg.requestsDir = dir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "r1.json"), JSON.stringify({ id: "r1", kind: "reflect", project: "demo-shop", mode: "retry", createdAt: new Date().toISOString() }));
  await captureLogs(() => t.worker.handleRequests(t.cfg));
  const res = JSON.parse(readFileSync(join(dir, "r1.result.json"), "utf8"));
  assert.equal(res.id, "r1");
  assert.equal(res.ok, true);
  assert.equal(res.mode, "retry");
  assert.equal(res.entries[0].trigger, "manual-retry");
  assert.equal(res.entries[0].retry, true);
  assert.equal(existsSync(join(dir, "r1.json")), false, "the request is consumed");
  assert.match(t.gw().sent.at(-1).text, /^<team-memory-retry/);
});
