// Reflection instruction, carry-forward list, reflect arg escaping, and the subagent report reader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  conversationTranscriptPath,
  escapeReflectArgs,
  memfsAgentRoot,
  memfsDir,
  readReflectionReport,
  readReflectionToolErrors,
  reportExcerpt,
  subagentConversationDir,
} from "../dist/letta.js";
import {
  MAX_PENDING_REFLECTION,
  addPending,
  buildReflectionInstruction,
  buildRetryTurn,
  classifyReflectionOutcome,
  explainReflectionOutcome,
  parseResultLine,
  reportSections,
} from "../dist/reflection.js";

const AGENT = "agent-local-00000000-0000-4000-8000-000000000000";
const paths = { lettaConfigDir: "/root/.letta", transcriptRoot: "/root/.letta/transcripts" };

/** Letta Code 0.34.41 `parseModCommandArgv` + the `--` branch of `parseReflectCommandArgs`. */
function lettaParseInstruction(args) {
  const argv = [];
  let current = "";
  let quote = null;
  let escaping = false;
  const push = () => {
    if (current.length > 0) argv.push(current);
    current = "";
  };
  for (const ch of args) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    current += ch;
  }
  if (escaping) current += "\\";
  push();
  assert.equal(argv[0], "--");
  return argv.slice(1).join(" ").trim();
}

test("MemFS paths", () => {
  assert.equal(memfsAgentRoot(paths, AGENT), `/root/.letta/lc-local-backend/memfs/${AGENT}`);
  assert.equal(memfsDir(paths, AGENT), `/root/.letta/lc-local-backend/memfs/${AGENT}/memory`);
  assert.equal(conversationTranscriptPath(paths, AGENT, "local-conv-1"), `/root/.letta/transcripts/${AGENT}/local-conv-1/transcript.jsonl`);
});

test("reflection instruction names the MemFS root and forbids guessing agent ids", () => {
  const root = memfsAgentRoot(paths, AGENT);
  const text = buildReflectionInstruction({ agentId: AGENT, memfsAgentRoot: root, pending: [], transcriptPath: () => "x" });
  assert.ok(text.includes(`primary agent id is ${AGENT}`));
  assert.ok(text.includes(`${root}/memory`));
  assert.ok(text.includes(`must start with ${root}/`));
  assert.match(text, /Write memory files only inside \$MEMORY_DIR/);
  assert.match(text, /Never retype, guess or combine agent ids/);
  assert.match(text, /Do not finish before the changes you planned are committed/);
  assert.ok(text.endsWith('End your report with exactly one line: "RESULT: committed", "RESULT: nothing-to-save" (nothing worth keeping), or "RESULT: failed: <one-line reason>".'));
  assert.doesNotMatch(text, /previous reflection could not save/);
  assert.doesNotMatch(text, /Sessions still to review/);
  assert.ok(text.includes("Language: write memory in English. Sessions and remember notes in other languages are recorded in English. Keep proper nouns, titles, identifiers and code verbatim."));
  const ko = buildReflectionInstruction({ agentId: AGENT, memfsAgentRoot: root, pending: [], transcriptPath: () => "x", language: "ko" });
  assert.match(ko, /write memory in Korean \(한국어\)\. Sessions and remember notes in other languages are recorded in Korean \(한국어\)/);

  const pending = [
    { file: "trajectories/2026-11/alice/claude-code/a_s1.json", conversationId: "local-conv-1", session: "s1", member: "alice", tool: "claude-code" },
    { file: "inbox/minji/n.md", conversationId: "local-conv-2", member: "minji" },
  ];
  const retry = buildReflectionInstruction({
    agentId: AGENT,
    memfsAgentRoot: root,
    pending,
    transcriptPath: (c) => conversationTranscriptPath(paths, AGENT, c),
    retry: true,
    retryReason: "Edit: Permission denied by cross-agent memory guard\n(agent-local-x)",
  });
  assert.match(
    retry,
    /^The previous reflection could not save its changes \(Edit: Permission denied by cross-agent memory guard \(agent-local-x\)\)\. Record what is worth keeping under the Rules for reflection; if nothing is, end with RESULT: nothing-to-save\.\n/,
  );
  assert.doesNotMatch(retry, /still need to be recorded/);
  assert.match(retry, /RESULT: failed: <one-line reason>/);
  assert.match(retry, /Sessions still to review/);
  const noReason = buildReflectionInstruction({ agentId: AGENT, memfsAgentRoot: root, pending: [], transcriptPath: () => "x", retry: true });
  assert.match(noReason, /^The previous reflection could not save its changes \(unknown\)\./);
  assert.ok(retry.includes(`- session s1 (member alice, tool claude-code): /root/.letta/transcripts/${AGENT}/local-conv-1/transcript.jsonl`));
  assert.ok(retry.includes(`- file inbox/minji/n.md (member minji): /root/.letta/transcripts/${AGENT}/local-conv-2/transcript.jsonl`));

  // The instruction survives Letta's shell-like argument split intact.
  assert.equal(lettaParseInstruction(`-- ${escapeReflectArgs(retry)}`), retry.replace(/\s+/g, " ").trim());
  assert.match(lettaParseInstruction(`-- ${escapeReflectArgs(retry)}`), /printf "%s\\n" "\$MEMORY_DIR"/);
  assert.equal(lettaParseInstruction(`-- ${escapeReflectArgs(`it's a "test" \\ ok`)}`), `it's a "test" \\ ok`);

  const turn = buildRetryTurn("demo-shop", pending);
  assert.match(turn, /^<team-memory-retry project="demo-shop" sessions="s1,inbox\/minji\/n.md">/);
  assert.match(turn, /\nAn earlier reflection failed to save memory for the sessions below.*Reply with one sentence only/);
  assert.match(turn, /<\/team-memory-retry>$/);
});

test("carry-forward list: dedupe, miss count, size cap", () => {
  const item = (n, extra = {}) => ({ file: `f${n}`, conversationId: "c", session: `s${n}`, ...extra });
  let r = addPending([], [item(1), item(2)]);
  assert.deepEqual(r.pending.map((i) => [i.file, i.misses]), [["f1", 1], ["f2", 1]]);
  assert.deepEqual(r.dropped, []);
  // Same files again (one more miss each); newest last.
  r = addPending(r.pending, [item(2), item(1)]);
  assert.deepEqual(r.pending.map((i) => [i.file, i.misses]), [["f2", 2], ["f1", 2]]);
  // Too many misses: dropped.
  r = addPending([item(1, { misses: 3 })], [item(1, { misses: 3 })]);
  assert.deepEqual(r.pending, []);
  assert.equal(r.dropped[0].file, "f1");
  // Size cap keeps the newest.
  const many = Array.from({ length: MAX_PENDING_REFLECTION + 5 }, (_, i) => item(i));
  r = addPending([], many);
  assert.equal(r.pending.length, MAX_PENDING_REFLECTION);
  assert.equal(r.pending[0].file, "f5");
  assert.deepEqual(r.dropped.map((d) => d.file), ["f0", "f1", "f2", "f3", "f4"]);
});

test("report excerpt keeps head and tail within the limit", () => {
  assert.equal(reportExcerpt("a\n\n b"), "a b");
  const long = `HEAD ${"x".repeat(1000)} TAIL`;
  const ex = reportExcerpt(long);
  assert.ok(ex.length <= 500);
  assert.ok(ex.startsWith("HEAD "));
  assert.ok(ex.endsWith(" TAIL"));
});

test("readReflectionReport finds the newest reflection subagent of the agent", async () => {
  const letta = mkdtempSync(join(tmpdir(), "memmem-report-"));
  const p = { lettaConfigDir: letta, transcriptRoot: join(letta, "transcripts") };
  const base = join(letta, "lc-local-backend");
  const b64 = (x) => Buffer.from(x).toString("base64url");
  mkdirSync(join(base, "agents"), { recursive: true });
  const sub = (id, tags, createdAt, messages) => {
    writeFileSync(join(base, "agents", `${b64(id)}.json`), JSON.stringify({ id, tags, hidden: true }));
    const dir = join(base, "conversations", b64(`default:${id}`));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "conversation.json"), JSON.stringify({ id: "default", agent_id: id, created_at: createdAt }));
    writeFileSync(join(dir, "messages.jsonl"), messages.map((m) => JSON.stringify({ type: "message", message: m })).join("\n") + "\n");
    return dir;
  };
  const final = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
  const tool = { role: "assistant", content: [{ type: "toolCall", name: "Bash", arguments: {} }] };
  const older = sub("agent-local-old", ["type:reflection", `parent:${AGENT}`], "2026-11-06T00:37:34.530Z", [final("old report")]);
  utimesSync(older, new Date("2026-11-06T00:38:00Z"), new Date("2026-11-06T00:38:00Z"));
  sub("agent-local-new", ["role:subagent", "type:reflection", `parent:${AGENT}`], "2026-11-06T00:39:20.023Z", [
    { role: "user", content: [{ type: "text", text: "Review..." }] },
    final("## Summary\nRecorded it."),
    { role: "toolResult", content: [{ type: "text", text: "ok" }] },
    tool,
  ]);
  sub("agent-local-other", ["type:reflection", "parent:agent-local-someone-else"], "2026-11-06T00:40:00.000Z", [final("not ours")]);
  sub("agent-local-plain", ["origin:letta-code"], "2026-11-06T00:41:00.000Z", [final("not a reflection")]);
  // A non-subagent conversation directory is ignored.
  mkdirSync(join(base, "conversations", b64("conversation:local-conv-1")), { recursive: true });

  const r = await readReflectionReport(p, AGENT, "2026-11-06T00:39:19.256Z");
  assert.deepEqual(r, { reflectionAgentId: "agent-local-new", text: "## Summary\nRecorded it." });
  const all = await readReflectionReport(p, AGENT, null);
  assert.equal(all.reflectionAgentId, "agent-local-new");
  assert.equal(await readReflectionReport(p, AGENT, "2026-11-06T01:00:00Z"), null);
  // Bounded by the reflection's success time: an older reflection's report.
  const old = await readReflectionReport(p, AGENT, null, "2026-11-06T00:38:03.800Z");
  assert.deepEqual(old, { reflectionAgentId: "agent-local-old", text: "old report" });
  assert.equal(await readReflectionReport({ lettaConfigDir: join(letta, "missing"), transcriptRoot: "x" }, AGENT, null), null);
});

// Final reports of real Letta Code 0.34.41 reflection subagents (2026-11-06, trimmed).
const REAL = {
  // demo-shop session C (README typo): `##` sections.
  typo: "## Summary\nReviewed the alice Claude Code session. It only fixed a one-off README typo (`recieve` -> `receive`), with no durable decision.\n\n## Memory changes\nNone.\n\n## Skipped\nThe typo fix was too minor and transient to preserve as project memory.\n\n## Commit\nNo commit.\n\n## Issues\nNone.",
  // acme: numbered bold items, and the summary mentions a failed attempt and a permission request.
  numbered: "1. **Summary** \u2014 Reviewed one ingest session. It only contained a failed attempt to inspect existing team memory due to sandbox restrictions and an aborted escalation request.\n2. **Memory changes** \u2014 None.\n3. **Skipped** \u2014 The sandbox error and aborted permission request were transient session details.\n4. **Commit** \u2014 No commit.\n5. **Issues** \u2014 None.",
  // acme: `###` sections.
  h3: "### Summary\nReviewed the single ingest transcript; nothing durable.\n\n### Memory changes\nNone.\n\n### Skipped\n- The memory inventory duplicated existing files.\n\n### Commit\nNo commit.\n\n### Issues\nNone.",
  // demo-shop run 1: the memory guard denied the edit and the subagent gave up.
  guard: "## Summary\nReviewed the session.\n\n## Memory changes\nNone persisted. Planned updates:\n- Add `decisions/2026-11-06-stripe-checkout.md`\n\n## Commit\nNo commit.\n\n## Issues\nThe memory edit was blocked by the cross-agent memory guard despite the target agent appearing in the allowed list. Since uncommitted edits do not persist, reflection stopped.",
};

test("parseResultLine and reportSections handle the report formats", () => {
  assert.deepEqual(parseResultLine("## Commit\nNo commit.\n\nRESULT: nothing-to-save"), { result: "nothing-to-save" });
  assert.deepEqual(parseResultLine("x\n**RESULT:** `committed`"), { result: "committed" });
  assert.deepEqual(parseResultLine("RESULT: failed: Edit denied by the memory guard  "), { result: "failed", reason: "Edit denied by the memory guard" });
  assert.deepEqual(parseResultLine("RESULT: nothing to save\nmore\nRESULT: failed: second wins"), { result: "failed", reason: "second wins" });
  assert.equal(parseResultLine("The RESULT: committed is mid-sentence"), null);
  assert.equal(parseResultLine("no result here"), null);

  for (const r of [REAL.typo, REAL.numbered, REAL.h3]) {
    const s = reportSections(r);
    assert.equal(s.get("commit"), "No commit.");
    assert.equal(s.get("issues"), "None.");
  }
  assert.equal(reportSections("No durable facts. No commit. Issues: None.").get("issues"), "None.");
  // "Committed as ..." in a body line is not a section start.
  assert.equal(reportSections("## Summary\nCommitted as abc\n## Issues\nNone").get("commit"), undefined);
});

test("classifyReflectionOutcome: each rule and their precedence", () => {
  const c = (commit, report, errs) => explainReflectionOutcome({ commit, report, subagentToolErrors: errs });
  const guardErr = ["Edit: Permission denied by cross-agent memory guard (agent-local-x). Allowed: ..."];

  // a. head moved wins over everything.
  assert.deepEqual(c("abc123", "RESULT: failed: whatever", guardErr), { outcome: "committed", source: "head" });
  assert.equal(classifyReflectionOutcome({ commit: "abc", report: null }), "committed");

  // b. RESULT line.
  assert.deepEqual(c(null, `${REAL.typo}\n\nRESULT: nothing-to-save`, []), { outcome: "nothing_to_save", source: "result_line" });
  assert.deepEqual(c(null, "RESULT: failed: git commit failed: index.lock exists", []), {
    outcome: "failed",
    source: "result_line",
    reason: "git commit failed: index.lock exists",
  });
  const claimed = c(null, "## Commit\nCommitted as abc\n\nRESULT: committed", []);
  assert.equal(claimed.outcome, "failed");
  assert.equal(claimed.claimedCommit, true);
  // b before c: the subagent's own verdict wins over tool errors it recovered from.
  assert.equal(c(null, "RESULT: nothing-to-save", guardErr).outcome, "nothing_to_save");

  // c. tool errors, before the prose (whose wording says nothing to save).
  const t = c(null, REAL.typo, guardErr);
  assert.equal(t.outcome, "failed");
  assert.equal(t.source, "tool_errors");
  assert.match(t.reason, /^Edit: Permission denied by cross-agent memory guard/);
  // ... and even without a report.
  assert.equal(c(null, null, guardErr).source, "tool_errors");

  // d. prose.
  for (const r of [REAL.typo, REAL.numbered, REAL.h3]) assert.deepEqual(c(null, r, []), { outcome: "nothing_to_save", source: "report_prose" });
  assert.equal(c(null, "No durable project facts, decisions... No commit. Issues: None.", []).outcome, "nothing_to_save");
  const g = c(null, REAL.guard, []);
  assert.equal(g.outcome, "failed");
  assert.equal(g.source, "report_prose");
  assert.match(g.reason, /^The memory edit was blocked by the cross-agent memory guard/);
  assert.equal(c(null, "## Commit\nNo commit.\n\n## Issues\n- Could not write decisions/x.md (read-only).", []).outcome, "failed");
  // An Issues section that is not None is a failure even without failure words.
  assert.equal(c(null, "## Commit\nNo commit.\n\n## Issues\nThe worktree was missing.", []).outcome, "failed");
  // Failure words in the Summary (the session's own topic) do not count when sections exist.
  assert.equal(c(null, "## Summary\nThe session debugged a permission denied error; access was blocked by a guard.\n\n## Commit\nNo commit.\n\n## Issues\nNone.", []).outcome, "nothing_to_save");
  // A Commit section that claims a commit, while MemFS main did not move.
  const claimedProse = c(null, "## Commit\nCommitted as `6453605` - feat(reflection): x\n\n## Skipped\nREADME typo.\n\n## Issues\nNone.", []);
  assert.equal(claimedProse.outcome, "failed");
  assert.equal(claimedProse.claimedCommit, true);
  // Without sections, the whole report is scanned.
  assert.equal(c(null, "I could not commit because the edit was denied.", []).outcome, "failed");
  assert.equal(c(null, "Skipped everything: nothing durable.", []).outcome, "nothing_to_save");
  assert.deepEqual(c(null, "Reviewed the transcript.", []), { outcome: "unknown", source: "report_prose", reason: "report has no RESULT line and no clear outcome" });

  // e. no report.
  assert.deepEqual(c(null, null, []), { outcome: "unknown", source: "no_report", reason: "no reflection report found" });
  assert.equal(c(null, "   ", undefined).outcome, "unknown");
});

test("readReflectionToolErrors reads failed tool results from the subagent's messages.jsonl", async () => {
  const letta = mkdtempSync(join(tmpdir(), "memmem-toolerr-"));
  const p = { lettaConfigDir: letta, transcriptRoot: join(letta, "transcripts") };
  const sub = "agent-local-00000000-0000-4000-8000-000000000001";
  const dir = subagentConversationDir(p, sub);
  assert.equal(dir, join(letta, "lc-local-backend", "conversations", Buffer.from(`default:${sub}`).toString("base64url")));
  mkdirSync(dir, { recursive: true });
  let n = 0;
  const result = (toolName, text, isError) => ({
    type: "message",
    id: `m${++n}`,
    parentId: `m${n - 1}`,
    timestamp: "2026-11-06T01:11:46.784Z",
    message: { id: `ui-msg-${n}`, role: "toolResult", toolCallId: `call_${n}|fc_${n}`, toolName, content: [{ type: "text", text }], isError, timestamp: 1700000000000, metadata: {} },
  });
  const guard = `Permission denied by cross-agent memory guard (agent-local-00000000-0000-4000-8000-000000000002). Allowed: ${sub}, ${AGENT}. Pass --disable-memory-guard from the parent agent process to opt out.`;
  const lines = [
    { type: "session", version: 3, id: "default", timestamp: "2026-11-06T01:11:04Z", cwd: "/" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "If an edit is denied (for example by the cross-agent memory guard) ..." }] } },
    result("Bash", "1608 /root/.letta/transcripts/x/payload.json\n[user] docker: permission denied while connecting\nfatal: not a git repository", false),
    result("Bash", "Exit code: 127\n2601 /root/.letta/x.json\n\n/bin/bash: line 1: python: command not found\n", false),
    result("Bash", 'Exit code: 1\n{"kind":"user","text":"git says fatal: permission denied"}\n  "content": "error: nope"', false),
    result("Read", "File does not exist.", true),
    result("Edit", guard, true),
    result("Edit", guard, true),
    result("Bash", "Exit code: 128\nfatal: Unable to create '/root/.letta/lc-local-backend/memfs/x/memory/.git/worktrees/r/index.lock': File exists.", false),
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "The memory guard denied my edit." }] } },
    "{ partial line",
  ];
  writeFileSync(join(dir, "messages.jsonl"), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  const errs = await readReflectionToolErrors(p, sub);
  assert.equal(errs.length, 3);
  assert.ok(errs[0].startsWith("Edit: Permission denied by cross-agent memory guard (agent-local-00000000-0000-4000-8000-000000000002"));
  assert.ok(errs[0].length <= 240 && errs[0].endsWith("..."));
  assert.equal(errs[1], errs[0]);
  assert.match(errs[2], /^Bash: exit 128: fatal: Unable to create '.*index\.lock': File exists\.$/);
  assert.deepEqual(await readReflectionToolErrors(p, "agent-local-missing"), []);
  // Bounded.
  writeFileSync(join(dir, "messages.jsonl"), Array.from({ length: 30 }, () => JSON.stringify(result("Edit", guard, true))).join("\n"));
  assert.equal((await readReflectionToolErrors(p, sub)).length, 10);
});
