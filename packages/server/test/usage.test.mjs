// Token usage: normalization, reflection usage from a subagent conversation,
// the daily ledger, `memmem-server usage` and the status line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../dist/cli.js";
import { projectStatus, renderProject } from "../dist/cli/status.js";
import { readReflectionUsage, subagentConversationDir, sumReflectionUsage } from "../dist/letta.js";
import { emptyState, localDate, saveState } from "../dist/state.js";
import { USAGE_DAYS, formatUsageLine, normalizeUsage, parseSince, recordUsage, shiftDate, summarizeLedger } from "../dist/usage.js";
import { makeCtx, tempHome } from "./cli-helpers.mjs";

const FIXTURE = new URL("./fixtures/reflection-subagent-messages.jsonl", import.meta.url);
const SUB = "agent-local-00000000-0000-4000-8000-000000000000";
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test("normalizeUsage maps SDK turn usage, pi records and the normalized shape onto one shape", () => {
  assert.deepEqual(normalizeUsage({ promptTokens: 100, completionTokens: 3, cachedInputTokens: 50, cacheWriteTokens: 7, reasoningTokens: 2, totalTokens: 160, stepCount: 1, durationMs: 9 }), {
    input: 100, output: 3, cacheRead: 50, cacheWrite: 7, reasoning: 2, total: 160, costUsd: null,
  });
  // No total: input + output + cacheRead + cacheWrite.
  assert.equal(normalizeUsage({ promptTokens: 100, completionTokens: 3 }).total, 103);
  assert.deepEqual(normalizeUsage({ input: 148, output: 116, cacheRead: 17792, cacheWrite: 0, reasoning: 0, totalTokens: 18056, cost: { total: 0.01 } }), {
    input: 148, output: 116, cacheRead: 17792, cacheWrite: 0, reasoning: 0, total: 18056, costUsd: 0.01,
  });
  const n = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 0, total: 10, costUsd: 0.5 };
  assert.deepEqual(normalizeUsage(n), n);
  assert.equal(normalizeUsage({}), null);
  assert.equal(normalizeUsage({ durationMs: 5 }), null);
  assert.equal(normalizeUsage(null), null);
});

test("reflection usage: sums this run's assistant messages of a reused subagent conversation", () => {
  const lines = readFileSync(FIXTURE, "utf8").split("\n");
  // Run 2 started 11:53:20 and succeeded 11:53:50: run 1 (11:40) and run 3 (11:58) are left out,
  // the twice-written entry b2 counts once, user/tool lines and the partial last line are skipped.
  const r = sumReflectionUsage(lines, "2026-11-06T11:53:20.000Z", "2026-11-06T11:53:50.000Z");
  assert.equal(r.messages, 3);
  assert.equal(r.model, "openai-codex/gpt-5.6-sol");
  const { costUsd, ...tokens } = r.usage;
  assert.deepEqual(tokens, { input: 12971, output: 460, cacheRead: 38992, cacheWrite: 64, reasoning: 40, total: 52487 });
  near(costUsd, 0.08);
  // Run 1 alone.
  const r1 = sumReflectionUsage(lines, "2026-11-06T11:40:00.000Z", "2026-11-06T11:40:10.000Z");
  assert.equal(r1.messages, 2);
  assert.equal(r1.usage.total, 30790);
  near(r1.usage.costUsd, 0.062);
  // Open window: every distinct message.
  assert.equal(sumReflectionUsage(lines, null, null).messages, 6);
  // Nothing in range.
  assert.equal(sumReflectionUsage(lines, "2026-11-07T00:00:00Z", "2026-11-07T00:10:00Z"), null);
});

test("reflection usage: window slack and messages without timestamps", () => {
  const msg = (id, ts, extra = {}) =>
    JSON.stringify({ type: "message", id, ...(ts ? { timestamp: ts } : {}), message: { role: "assistant", content: [], model: "m1", usage: { input: 10, output: 1, totalTokens: 11 }, ...extra } });
  const lines = [
    msg("x1", "2026-11-06T10:00:00.000Z"), // 10 s before the start: in (Letta's start time can lag)
    msg("x2", "2026-11-06T09:59:49.000Z"), // 11 s before: out
    msg("x3", "2026-11-06T10:05:04.000Z"), // 4 s after success: in
    msg("x4", "2026-11-06T10:05:06.000Z"), // 6 s after: out
    msg("x5", null), // no timestamp anywhere: skipped inside a window
    msg("x6", null, { timestamp: Date.parse("2026-11-06T10:01:00Z") }), // the message's own ms timestamp
    msg("x7", null, { metadata: { created_at: "2026-11-06T10:02:00Z" }, provider: "anthropic", model: "m2" }),
  ];
  const r = sumReflectionUsage(lines, "2026-11-06T10:00:10.000Z", "2026-11-06T10:05:00.000Z");
  assert.equal(r.messages, 4);
  assert.equal(r.usage.total, 44);
  assert.equal(r.usage.costUsd, null, "no cost in the records");
  assert.equal(r.model, "m1, anthropic/m2");
  assert.equal(sumReflectionUsage(lines, null, null).messages, 7);
});

test("readReflectionUsage reads the subagent's messages.jsonl (null when missing)", async () => {
  const letta = mkdtempSync(join(tmpdir(), "memmem-usage-"));
  const p = { lettaConfigDir: letta, transcriptRoot: join(letta, "transcripts") };
  const dir = subagentConversationDir(p, SUB);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "messages.jsonl"), readFileSync(FIXTURE));
  const r = await readReflectionUsage(p, SUB, "2026-11-06T11:53:20.000Z", "2026-11-06T11:53:50.000Z");
  assert.equal(r.usage.total, 52487);
  assert.equal(await readReflectionUsage(p, "agent-local-missing", null, null), null);
});

test("ledger: per day and kind, a null usage still counts the run, at most 90 days kept", () => {
  const state = emptyState();
  const u = { input: 100, output: 10, cacheRead: 50, cacheWrite: 0, reasoning: 0, total: 160, costUsd: null };
  recordUsage(state, "ingest", u, "2026-11-06");
  recordUsage(state, "ingest", u, "2026-11-06");
  recordUsage(state, "reflection", { ...u, costUsd: 0.25 }, "2026-11-06");
  recordUsage(state, "reflection", null, "2026-11-06");
  assert.deepEqual(state.usage["2026-11-06"].ingest, { turns: 2, input: 200, output: 20, cacheRead: 100, cacheWrite: 0, reasoning: 0, total: 320, costUsd: null });
  assert.equal(state.usage["2026-11-06"].reflection.turns, 2);
  assert.equal(state.usage["2026-11-06"].reflection.total, 160);
  assert.equal(state.usage["2026-11-06"].reflection.costUsd, 0.25);

  // 120 consecutive days: only the last 90 stay.
  const s2 = emptyState();
  for (let i = 0; i < 120; i++) recordUsage(s2, "init", u, shiftDate("2026-07-01", i));
  const days = Object.keys(s2.usage).sort();
  assert.equal(days.length, USAGE_DAYS);
  assert.equal(days.at(-1), shiftDate("2026-07-01", 119));
  assert.equal(days[0], shiftDate("2026-07-01", 119 - 89));

  const sum = summarizeLedger(state.usage, "2026-11-01", "2026-11-07");
  assert.equal(sum.days.length, 1);
  assert.equal(sum.totals.ingest.turns, 2);
  assert.equal(sum.totals.init.turns, 0);
  assert.equal(formatUsageLine(sum.totals), "ingest 2 turns / 320 tokens · reflection 2 / 160 · init 0 / 0 (≈$0.25)");
});

test("parseSince: <n>d counts today, YYYY-MM-DD, invalid input", () => {
  assert.equal(parseSince("7d", "2026-11-07"), "2026-11-01");
  assert.equal(parseSince("1d", "2026-11-07"), "2026-11-07");
  assert.equal(parseSince("30d", "2026-11-07"), "2026-10-09");
  assert.equal(parseSince("2026-10-15", "2026-11-07"), "2026-10-15");
  assert.equal(parseSince("0d", "2026-11-07"), null);
  assert.equal(parseSince("2026-02-30", "2026-11-07"), null);
  assert.equal(parseSince("week", "2026-11-07"), null);
});

/** A data root with two projects; demo-shop has three days of ledger (relative to today). */
async function usageHome() {
  const home = tempHome();
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(
    join(home, "projects.json"),
    JSON.stringify({
      projects: [
        { project: "demo-shop", agentId: "agent-local-460a", memoryRepo: "m", transcriptsRepo: "t" },
        { project: "acme", agentId: "agent-local-3be1", memoryRepo: "m", transcriptsRepo: "t" },
      ],
    }),
  );
  const today = localDate();
  const st = emptyState();
  const tok = (input, cacheRead, costUsd = null) => ({ input, output: 100, cacheRead, cacheWrite: 0, reasoning: 0, total: input + 100 + cacheRead, costUsd });
  for (let i = 0; i < 12; i++) recordUsage(st, "ingest", tok(20_000, 0), today);
  recordUsage(st, "reflection", tok(13_000, 39_000, 0.07), today);
  recordUsage(st, "ingest", tok(1_900, 0), shiftDate(today, -2));
  recordUsage(st, "init", tok(400_000, 800_000), shiftDate(today, -2));
  recordUsage(st, "ingest", tok(5_000, 0), shiftDate(today, -20)); // outside 7d
  await saveState(join(home, "state"), "demo-shop", st);
  return { home, today };
}

test("usage command: a table per project with days, per-kind columns, totals and a summary line", async () => {
  const { home, today } = await usageHome();
  const ctx = makeCtx(home);
  assert.equal(await dispatch(ctx, "usage", {}, []), 0);
  const text = ctx.out.text();
  const lines = text.split("\n");
  assert.equal(lines[0], `demo-shop  usage ${shiftDate(today, -6)} .. ${today}`);
  // Cost column only for the kind Letta priced (reflection).
  assert.match(lines[1], /^ {2}date\s+ingest turns\s+tokens\s+cached\s+reflection runs\s+tokens\s+cached\s+cost\s+init runs\s+tokens\s+cached$/);
  assert.match(lines[2], new RegExp(`^  ${shiftDate(today, -2)}\\s+1\\s+2k\\s+0\\s+-\\s+-\\s+-\\s+-\\s+1\\s+1\\.2M\\s+800k$`));
  assert.match(lines[3], new RegExp(`^  ${today}\\s+12\\s+241\\.2k\\s+0\\s+1\\s+52\\.1k\\s+39k\\s+\\$0\\.07\\s+-\\s+-\\s+-$`));
  assert.match(lines[4], /^ {2}total\s+13\s+243\.2k\s+0\s+1\s+52\.1k\s+39k\s+\$0\.07\s+1\s+1\.2M\s+800k$/);
  assert.equal(lines[5], "  ingest 13 turns / 243.2k tokens · reflection 1 / 52.1k · init 1 / 1.2M (≈$0.07)");
  assert.match(text, /\n\nacme {2}usage .*\n {2}no usage recorded in this range/);

  // --since 30d picks up the older day; --project narrows.
  const c30 = makeCtx(home);
  await dispatch(c30, "usage", { since: "30d", project: "demo-shop" }, []);
  assert.match(c30.out.text(), new RegExp(`  ${shiftDate(today, -20)}\\s+1\\s+5\\.1k`));
  assert.doesNotMatch(c30.out.text(), /acme/);
  await assert.rejects(dispatch(makeCtx(home), "usage", { since: "soon" }, []), /--since must be/);
  await assert.rejects(dispatch(makeCtx(home), "usage", { project: "nope" }, []), /unknown project/);
});

test("usage command --json", async () => {
  const { home, today } = await usageHome();
  const ctx = makeCtx(home, { json: true });
  assert.equal(await dispatch(ctx, "usage", { since: "7d" }, []), 0);
  const doc = JSON.parse(ctx.out.text());
  assert.equal(doc.since, shiftDate(today, -6));
  assert.equal(doc.until, today);
  assert.equal(doc.keptDays, 90);
  const demo = doc.projects.find((p) => p.project === "demo-shop");
  assert.deepEqual(demo.days.map((d) => d.date), [shiftDate(today, -2), today]);
  assert.equal(demo.totals.ingest.turns, 13);
  assert.equal(demo.totals.reflection.costUsd, 0.07);
  assert.equal(demo.totals.init.cacheRead, 800_000);
  assert.deepEqual(doc.projects.find((p) => p.project === "acme").days, []);
});

test("status: one usage line per project over the last 7 days", async () => {
  const { home, today } = await usageHome();
  const st = JSON.parse(readFileSync(join(home, "state", "demo-shop.json"), "utf8"));
  const entry = { project: "demo-shop", agentId: "agent-local-460a", memoryRepo: "m", transcriptsRepo: "t" };
  const lines = renderProject(projectStatus(entry, st, today), Date.now());
  assert.ok(lines.includes("  usage 7d: ingest 13 turns / 243.2k tokens · reflection 1 / 52.1k · init 1 / 1.2M (≈$0.07)"), lines.join("\n"));
  const empty = renderProject(projectStatus(entry, emptyState(), today), Date.now());
  assert.ok(empty.includes("  usage 7d: ingest 0 turns / 0 tokens · reflection 0 / 0 · init 0 / 0"));
});
