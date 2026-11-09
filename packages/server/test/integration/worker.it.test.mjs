// End-to-end test against a real Letta Code App Server on this host.
// Skipped unless MEMMEM_IT=1. Uses real model quota (one ingest turn + one
// reflection) and pushes the reflection commit to the agent's memory repo.
//
//   MEMMEM_IT=1 npm run test:integration
//
// Optional env:
//   MEMMEM_IT_AGENT        agent id (default: the mem-mem test agent)
//   MEMMEM_IT_MEMORY_REPO  memory repo URL of that agent (default: a placeholder, set it)
//   MEMMEM_IT_GH_REPO      owner/name used to verify the push with `gh api` (default: a placeholder)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { seededTranscriptsRepo, sh, tempDir, writeAndPush } from "../helpers.mjs";

const ENABLED = process.env.MEMMEM_IT === "1";
const AGENT = process.env.MEMMEM_IT_AGENT ?? "agent-local-00000000-0000-4000-8000-000000000000";
const MEMORY_REPO = process.env.MEMMEM_IT_MEMORY_REPO ?? "https://github.com/acme-org/mem-acme.git";
const GH_REPO = process.env.MEMMEM_IT_GH_REPO ?? "acme-org/mem-acme";
const PORT = Number(process.env.MEMMEM_IT_PORT ?? 4500);
const WORKER_JS = resolve(import.meta.dirname, "..", "..", "dist", "index.js");
const LETTA_DIR = process.env.LETTA_CONFIG_DIR || join(homedir(), ".letta");
const MEMFS = join(LETTA_DIR, "lc-local-backend", "memfs", AGENT, "memory");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ready() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/readyz`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Fictional demo-shop session. The warm-up count and date are unique per run
 * so the reflection always has something new to record (a repeated identical
 * session can legitimately end in a reflection with no memory change).
 */
function synthTrajectory(runTag, warmCount) {
  const ts = (s) => `2026-11-06T01:${String(s).padStart(2, "0")}:00.000Z`;
  return {
    records: [
      { role: "meta", source: "claude-code", cwd: "/home/dev/demo-shop", git_branch: "feat/product-cache", model: "example-model" },
      { role: "user", timestamp: ts(0), content: "GET /products p95 is ~900ms at peak. The listing query hits Postgres every time. What should we do?" },
      { role: "assistant", timestamp: ts(1), content: "Let me check how the listing endpoint queries the catalog.", tool_calls: [{ id: "c1", name: "Read", args: "{\"file_path\":\"services/catalog/src/products/list.ts\"}" }] },
      { role: "tool", timestamp: ts(2), tool_call_id: "c1", content: "export async function listProducts(q) { return db.query('SELECT ... FROM products WHERE category = $1 ORDER BY rank LIMIT 50', [q.category]); }" },
      { role: "assistant", timestamp: ts(3), content: "Every request runs the full ranked query. The listing changes rarely compared to how often it is read, so a short-lived cache in front of it is the cheapest fix." },
      { role: "user", timestamp: ts(4), content: "Decision: add a Redis cache for product listings, key products:list:{category}:{page}, TTL 60 seconds. Reason: listings tolerate up to a minute of staleness, and a 60s TTL avoids building invalidation for every catalog write. Price changes must still invalidate the key immediately because stale prices cause checkout mismatches. Target p95 under 150ms." },
      { role: "assistant", timestamp: ts(5), content: "Implemented: Redis read-through cache in services/catalog/src/products/list.ts with TTL 60s, key products:list:{category}:{page}; PriceUpdated events delete the matching keys. Open question: whether to warm the cache for the top 10 categories at deploy time.", tool_calls: [{ id: "c2", name: "Edit", args: "{\"file_path\":\"services/catalog/src/products/list.ts\",\"note\":\"wrap listProducts with redis get/set EX 60\"}" }] },
      { role: "tool", timestamp: ts(6), tool_call_id: "c2", content: "ok" },
      { role: "user", timestamp: ts(7), content: `Follow-up decision (${runTag}): yes, warm the cache at deploy time for the top ${warmCount} categories by traffic, because the first minute after a deploy otherwise sends every listing request to Postgres at once.` },
      { role: "assistant", timestamp: ts(8), content: `Added a deploy hook that pre-fills products:list for the top ${warmCount} categories (page 1) with the same 60s TTL.` },
    ],
  };
}

test("worker ingests a synthetic session, reflection commits, memory is pushed, log is committed", { skip: !ENABLED, timeout: 15 * 60_000 }, async () => {
  const timings = {};
  const t0 = Date.now();
  const root = tempDir("memmem-it-");

  // 1. App Server (ours, unless one is already listening).
  let server = null;
  if (await ready()) {
    console.log(`[it] App Server already running on ${PORT}; reusing it`);
  } else {
    server = spawn("letta", ["server", "--backend", "local", "--listen", `ws://127.0.0.1:${PORT}`], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const serverLog = [];
    server.stdout.on("data", (d) => serverLog.push(String(d)));
    server.stderr.on("data", (d) => serverLog.push(String(d)));
    const deadline = Date.now() + 90_000;
    while (!(await ready())) {
      if (Date.now() > deadline || server.exitCode !== null) {
        throw new Error(`App Server did not become ready:\n${serverLog.join("").slice(-2000)}`);
      }
      await sleep(500);
    }
    timings.serverReadyMs = Date.now() - t0;
  }

  try {
    // 2. Transcripts repo with one synthetic session.
    const { bare, work } = seededTranscriptsRepo(root);
    const file = "trajectories/2026-11/minji/claude-code/2026-11-06T01-00-00_it-redis-cache.json";
    const runTag = new Date().toISOString();
    const warmCount = 3 + Math.floor(Math.random() * 40);
    writeAndPush(work, { [file]: synthTrajectory(runTag, warmCount) }, "add synthetic session");

    const memBefore = sh(MEMFS, "rev-parse", "main");
    const configPath = join(root, "projects.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          settings: { stepCount: 1, dailyReflectHour: null, ingestMaxChars: 40000, reflectionWaitSeconds: 180 },
          projects: [{ project: "demo-shop", agentId: AGENT, memoryRepo: MEMORY_REPO, transcriptsRepo: bare }],
        },
        null,
        2,
      ),
    );
    mkdirSync(join(root, "agentcwd"), { recursive: true });

    // 3. One worker pass as a real child process.
    const env = {
      ...process.env,
      MEMMEM_CONFIG: configPath,
      MEMMEM_SERVER_HOME: root,
      // The host's Letta state (the worker's default is <server home>/letta).
      LETTA_CONFIG_DIR: LETTA_DIR,
      MEMMEM_STATE_DIR: join(root, "state"),
      MEMMEM_REPOS_DIR: join(root, "repos"),
      MEMMEM_CWD: join(root, "agentcwd"),
      MEMMEM_APP_SERVER_URL: `ws://127.0.0.1:${PORT}`,
      MEMMEM_ONCE: "1",
    };
    const tWorker = Date.now();
    const events = [];
    const code = await new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, [WORKER_JS], { env, stdio: ["ignore", "pipe", "inherit"] });
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          console.log(`[worker] ${line}`);
          try {
            events.push({ at: Date.now() - tWorker, ...JSON.parse(line) });
          } catch {
            // non-JSON output
          }
        }
      });
      child.on("error", reject);
      child.on("exit", resolveRun);
    });
    timings.workerMs = Date.now() - tWorker;
    assert.equal(code, 0, "worker exit code");

    const ev = (name) => events.find((e) => e.event === name);
    const turn = ev("turn_done");
    assert.ok(turn, "turn completed");
    timings.turnMs = turn.durationMs;
    timings.turnUsage = turn.usage;
    timings.turnReply = turn.reply;
    const done = ev("reflection_done");
    assert.ok(done, "reflection finished within the wait");
    timings.reflectionWaitMs = done.waitedMs;
    assert.ok(done.commit, "reflection produced a MemFS commit (null means it found nothing new to record)");

    // 4. MemFS moved, and GitHub has the same HEAD.
    const memAfter = sh(MEMFS, "rev-parse", "main");
    assert.notEqual(memAfter, memBefore);
    assert.equal(done.commit, memAfter);
    timings.reflectionCommit = memAfter;
    timings.reflectionSubject = sh(MEMFS, "log", "-1", "--format=%s", "main");
    timings.reflectionFiles = sh(MEMFS, "diff", "--name-only", `${memBefore}`, memAfter).split("\n");
    const pushed = ev("memory_pushed");
    assert.ok(pushed, "memory pushed");
    const ghHead = execFileSync("gh", ["api", `repos/${GH_REPO}/commits`, "--jq", ".[0].sha"], { encoding: "utf8" }).trim();
    assert.equal(ghHead, memAfter, "GitHub HEAD equals MemFS HEAD");

    // 5. ingest/log.jsonl committed to the transcripts repo.
    const log = execFileSync("git", ["--git-dir", bare, "show", "main:ingest/log.jsonl"], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const ingest = log.find((l) => l.event === "ingest" && l.file === file);
    assert.ok(ingest, "ingest entry");
    assert.equal(ingest.reflectionCommit, memAfter);
    assert.ok(ingest.conversationId?.startsWith("local-conv-") || ingest.conversationId?.startsWith("conv-"));
    assert.ok(log.some((l) => l.event === "reflection" && l.reflectionCommit === memAfter));

    timings.totalMs = Date.now() - t0;
    console.log(`[it] timings ${JSON.stringify(timings)}`);
  } finally {
    if (server) {
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        // already gone
      }
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && (await ready())) await sleep(250);
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
});
