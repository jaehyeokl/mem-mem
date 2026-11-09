import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gatherStatus, renderStatus } from "../dist/cli/status.js";
import { formatLine, matchesProject, tailLines } from "../dist/cli/logs.js";
import { makeCtx, tempHome } from "./cli-helpers.mjs";

const FIXTURE = new URL("./fixtures/state-demo-shop.json", import.meta.url);

function setup() {
  const home = tempHome();
  mkdirSync(join(home, "state"), { recursive: true });
  cpSync(FIXTURE, join(home, "state", "demo-shop.json"));
  writeFileSync(
    join(home, "projects.json"),
    JSON.stringify({
      settings: { stepCount: 1 },
      projects: [
        { project: "demo-shop", agentId: "agent-local-460a", memoryRepo: "https://github.com/o/mem-demo-shop.git", transcriptsRepo: "https://github.com/o/mem-demo-shop-transcripts.git", model: "openai-codex/gpt-5.6-sol" },
        { project: "acme", agentId: "agent-local-3be1", memoryRepo: "m", transcriptsRepo: "t", enabled: false },
      ],
    }),
  );
  return home;
}

test("status from fixture state files", async () => {
  const ctx = makeCtx(setup(), { readyz: async () => true });
  const report = await gatherStatus(ctx);
  assert.equal(report.server.running, false);
  assert.equal(report.server.appServerReady, true);
  const demo = report.projects.find((p) => p.project === "demo-shop");
  assert.equal(demo.queue, 1);
  assert.equal(demo.unreflected, 2);
  assert.equal(demo.pendingReflection, 1);
  assert.equal(demo.lastReflection.outcome, "committed");
  assert.equal(demo.backoff.failures, 2);
  const dub = report.projects.find((p) => p.project === "acme");
  assert.equal(dub.enabled, false);
  assert.equal(dub.lastPassAt, null, "missing state file = empty state");

  const text = renderStatus({ ...report, now: "2026-11-06T06:10:00.000Z" });
  assert.match(text, /memmem-server: not running/);
  assert.match(text, /App Server: ws:\/\/127\.0\.0\.1:4500 ready/);
  assert.match(text, /Projects \(2\):/);
  assert.match(text, /demo-shop  agent agent-local-460a  model openai-codex\/gpt-5\.6-sol/);
  assert.match(text, /queue 1  unreflected 2  carried-forward 1  unpushed log entries 1/);
  assert.match(text, /last pass 2026-11-06T06:05:00.000Z \(5m 0s ago\)/);
  assert.match(text, /last reflection committed 4b30286 \(step-count, 1h 10m ago\)/);
  assert.match(text, /memory pushed 4b30286  transcripts seen 9f8e7d6/);
  assert.match(text, /backoff 2 failure\(s\) until 2026-11-06T06:20:00.000Z: provider: usage limit/);
  assert.match(text, /acme  \(paused\)/);

  const only = await gatherStatus(ctx, "acme");
  assert.deepEqual(only.projects.map((p) => p.project), ["acme"]);
  await assert.rejects(gatherStatus(ctx, "nope"), /unknown project/);
});

test("status with no projects says how to add one", async () => {
  const ctx = makeCtx(tempHome());
  const text = renderStatus(await gatherStatus(ctx));
  assert.match(text, /not running/);
  assert.match(text, /memmem-server project add <name>/);
});

test("log formatting, project filter and tail", () => {
  const line = JSON.stringify({ ts: "2026-11-06T00:00:00Z", level: "info", event: "turn_done", project: "demo-shop", file: "a b.json", usage: { totalTokens: 5 } });
  assert.equal(formatLine(line), '2026-11-06T00:00:00Z info  turn_done [demo-shop] file="a b.json" usage={"totalTokens":5}');
  assert.equal(formatLine("Listening on ws://127.0.0.1:4500"), "Listening on ws://127.0.0.1:4500");
  assert.equal(matchesProject(line, "demo-shop"), true);
  assert.equal(matchesProject(line, "acme"), false);
  assert.equal(matchesProject("not json", "demo-shop"), false);
  const home = tempHome();
  const file = join(home, "worker.log");
  const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ event: "e", n: i, project: i % 2 ? "a" : "b" }));
  writeFileSync(file, lines.join("\n") + "\n");
  assert.deepEqual(tailLines(file, 3).lines.map((l) => JSON.parse(l).n), [7, 8, 9]);
  assert.deepEqual(tailLines(file, 2, "a").lines.map((l) => JSON.parse(l).n), [7, 9]);
});
