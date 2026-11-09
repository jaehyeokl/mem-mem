import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildIngestTexts,
  buildNoteTexts,
  cap,
  deriveMeta,
  extractRecords,
  packLines,
  parseInboxPath,
  parseTrajectoryPath,
  renderRecords,
} from "../dist/ingest-text.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/trajectory-small.json", import.meta.url), "utf8"));
const PATH = "trajectories/2026-11/minji/claude-code/2026-11-02T09-00-00_abc123.json";
const INSTRUCTION =
  "Below is the normalized transcript of a work session that team member minji ran with claude-code. You are this project's team memory manager. Reply with one sentence only, and leave memory updates to the background reflection.";

test("parseTrajectoryPath reads month/member/tool/startedAt/sessionId", () => {
  assert.deepEqual(parseTrajectoryPath(PATH), {
    month: "2026-11",
    member: "minji",
    tool: "claude-code",
    startedAt: "2026-11-02T09-00-00",
    sessionId: "abc123",
  });
  // Only the first underscore separates startedAt from the session id.
  assert.equal(parseTrajectoryPath("trajectories/2026-11/a/codex/2026-11-02T09-00-00_x_y.json")?.sessionId, "x_y");
  assert.equal(parseTrajectoryPath("trajectories/2026-11/a/codex/nounderscore.json"), null);
  assert.equal(parseTrajectoryPath("trajectories/2026-11/a/b.json"), null);
  assert.equal(parseTrajectoryPath("inbox/a/b.md"), null);
});

test("parseInboxPath reads the member", () => {
  assert.deepEqual(parseInboxPath("inbox/minji/2026-11-02-cache-ttl.md"), { member: "minji", name: "2026-11-02-cache-ttl.md" });
  assert.equal(parseInboxPath("inbox/readme.md"), null);
});

test("extractRecords accepts {records} and bare arrays, rejects others", () => {
  assert.equal(extractRecords(fixture).length, 10);
  assert.equal(extractRecords(fixture.records).length, 10);
  assert.equal(extractRecords([{ role: "user", content: "x" }, null, { nope: 1 }]).length, 1);
  assert.throws(() => extractRecords({ foo: [] }), /trajectory/);
});

test("deriveMeta prefers the path and falls back to the meta record", () => {
  const recs = extractRecords(fixture);
  assert.deepEqual(deriveMeta("demo-shop", PATH, recs), {
    project: "demo-shop",
    member: "minji",
    tool: "claude-code",
    sessionId: "abc123",
    startedAt: "2026-11-02T09-00-00",
  });
  const fallback = deriveMeta("demo-shop", "trajectories/odd/place.json", recs);
  assert.equal(fallback.tool, "claude-code");
  assert.equal(fallback.member, "unknown");
  assert.equal(fallback.sessionId, "place");
  assert.equal(fallback.startedAt, "2026-11-02T09:00:00.000Z");
});

test("buildIngestTexts renders the exact ingest shape", () => {
  const recs = extractRecords(fixture);
  const texts = buildIngestTexts(recs, deriveMeta("demo-shop", PATH, recs));
  assert.equal(texts.length, 1);
  const expected = [
    '<team-memory-ingest project="demo-shop" member="minji" tool="claude-code" session="abc123" started="2026-11-02T09-00-00">',
    INSTRUCTION,
    "[user] Checkout fails when the cart has more than 50 items. Can you find out why?",
    "[assistant] I'll look at the checkout handler first.",
    '[tool_call] Read {"file_path": "src/checkout/handler.ts"}',
    "[tool_result] export const MAX_ITEMS = 50; export function validate(cart) { if (cart.items.length > MAX_ITEMS) throw new Error('too many'); }",
    "[assistant] The handler rejects carts above MAX_ITEMS = 50. That limit was a placeholder.",
    "[user] Raise it to 200 and note why: wholesale customers order in bulk.",
    '[tool_call] Edit {"file_path":"src/checkout/handler.ts","old":"50","new":"200"}',
    "[tool_result] ok",
    "[assistant] Raised MAX_ITEMS to 200 for wholesale bulk orders.",
    "</team-memory-ingest>",
  ].join("\n");
  assert.equal(texts[0], expected);
  assert.ok(!texts[0].includes("Internal reasoning"));
});

test("message, tool args and tool results are capped", () => {
  const recs = [
    { role: "user", content: "u".repeat(5000) },
    { role: "assistant", content: "a", tool_calls: [{ name: "Bash", args: "x".repeat(1000) }] },
    { role: "tool", content: "r".repeat(1000) },
  ];
  const lines = renderRecords(recs, { maxChars: 40000, messageMaxChars: 1500, toolArgsMaxChars: 300, toolResultMaxChars: 400 });
  assert.equal(lines[0].length, "[user] ".length + 1500);
  assert.match(lines[0], /…\[\+\d+ chars\]$/);
  assert.equal(lines[2].length, "[tool_call] Bash ".length + 300);
  assert.equal(lines[3].length, "[tool_result] ".length + 400);
  assert.equal(cap("short", 10), "short");
});

test("long sessions split into parts within ingestMaxChars, in order, nothing lost", () => {
  const recs = [];
  for (let i = 0; i < 60; i++) {
    recs.push({ role: i % 2 ? "assistant" : "user", content: `message ${i} ` + "z".repeat(400) });
  }
  const meta = { project: "p", member: "m", tool: "codex", sessionId: "s", startedAt: "t" };
  const max = 5000;
  const texts = buildIngestTexts(recs, meta, { maxChars: max });
  assert.ok(texts.length > 1);
  texts.forEach((t, i) => {
    assert.ok(t.length <= max, `part ${i + 1} is ${t.length} chars`);
    assert.ok(t.startsWith(`<team-memory-ingest project="p" member="m" tool="codex" session="s" started="t" part="${i + 1}/${texts.length}">\n`));
    assert.ok(t.endsWith("\n</team-memory-ingest>"));
  });
  const body = texts.flatMap((t) => t.split("\n").slice(2, -1));
  assert.equal(body.length, 60);
  body.forEach((line, i) => assert.ok(line.includes(`message ${i} `)));
});

test("fromRecord sends only the new tail and marks the header", () => {
  const recs = extractRecords(fixture);
  const texts = buildIngestTexts(recs, deriveMeta("demo-shop", PATH, recs), { fromRecord: 9 });
  assert.equal(texts.length, 1);
  assert.match(texts[0], /from-record="9">\n/);
  assert.equal(texts[0].split("\n").length, 4);
  assert.deepEqual(buildIngestTexts(recs, deriveMeta("demo-shop", PATH, recs), { fromRecord: 10 }), []);
});

test("header attributes are escaped", () => {
  const texts = buildIngestTexts([{ role: "user", content: "hi" }], {
    project: "p",
    member: 'a"b<c>',
    tool: "t",
    sessionId: "s",
    startedAt: "x",
  });
  assert.match(texts[0], /member="a&quot;b&lt;c&gt;"/);
});

test("packLines respects the budget and cuts oversized lines", () => {
  const chunks = packLines(["aaaa", "bbbb", "cccc", "d".repeat(50)], 9);
  assert.deepEqual(chunks.slice(0, 2), [["aaaa", "bbbb"], ["cccc"]]);
  assert.equal(chunks[2][0].length, 9);
});

test("inbox notes become team-memory-note turns", () => {
  const texts = buildNoteTexts("# Cache TTL\n\nProduct list cache TTL stays at 60s.\n", {
    project: "demo-shop",
    member: "minji",
    file: "inbox/minji/2026-11-02-cache-ttl.md",
  });
  assert.equal(texts.length, 1);
  const lines = texts[0].split("\n");
  assert.equal(lines[0], '<team-memory-note project="demo-shop" member="minji" file="inbox/minji/2026-11-02-cache-ttl.md">');
  assert.match(lines[1], /^Below is a note that team member minji explicitly asked to keep in team memory\. /);
  assert.equal(lines.at(-1), "</team-memory-note>");
  assert.ok(texts[0].includes("Product list cache TTL stays at 60s."));
  assert.deepEqual(buildNoteTexts("   \n", { project: "p", member: "m", file: "f" }), []);
});
