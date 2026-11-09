import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, DEFAULT_SETTINGS, loadConfig, parseProjects, parseSettings } from "../dist/config.js";
import { redact } from "../dist/log.js";
import { backoffMs, emptyState, loadState, saveState } from "../dist/state.js";
import { agentNotFoundHint, classifyError, classifyReflectOutput, stepsSinceReflection } from "../dist/letta.js";

test("redact strips credentials from URLs and tokens", () => {
  assert.equal(redact("https://x-access-token:ghp_abc123@github.com/o/r.git"), "https://***@github.com/o/r.git");
  assert.equal(redact("https://github.com/o/r.git"), "https://github.com/o/r.git");
  assert.equal(redact("Authorization: Bearer abc.def"), "Authorization: Bearer ***");
  assert.equal(redact("?token=secret&x=1"), "?token=***&x=1");
});

test("settings defaults and validation", () => {
  assert.deepEqual(parseSettings(undefined), DEFAULT_SETTINGS);
  const s = parseSettings({ stepCount: 1, dailyReflectHour: null, ingestMaxChars: 40000 });
  assert.equal(s.stepCount, 1);
  assert.equal(s.dailyReflectHour, null);
  assert.throws(() => parseSettings({ stepCount: 0 }), ConfigError);
  assert.throws(() => parseSettings({ dailyReflectHour: 24 }), ConfigError);
});

test("projects validation", () => {
  const ok = { project: "demo-shop", agentId: "agent-local-1", memoryRepo: "m", transcriptsRepo: "t" };
  assert.equal(parseProjects([ok])[0].enabled, true);
  assert.equal(parseProjects([ok])[0].language, "en", "entries without a language are en");
  assert.equal(parseProjects([{ ...ok, language: "ko" }])[0].language, "ko");
  assert.throws(() => parseProjects([{ ...ok, language: "fr" }]), /language must be one of en, ko/);
  assert.throws(() => parseProjects([{ ...ok, agentId: "" }]), /agentId/);
  assert.throws(() => parseProjects([ok, ok]), /duplicate/);
  assert.throws(() => parseProjects([{ ...ok, project: "../evil" }]), /invalid/);
});

test("loadConfig reads MEMMEM_CONFIG and env overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "memmem-cfg-"));
  const path = join(dir, "projects.json");
  writeFileSync(path, JSON.stringify({ settings: { stepCount: 2 }, projects: [] }));
  const cfg = loadConfig({ MEMMEM_CONFIG: path, MEMMEM_SERVER_HOME: dir, MEMMEM_POLL_SECONDS: "5", MEMMEM_ONCE: "1", LETTA_CONFIG_DIR: "/x/.letta" });
  assert.equal(cfg.settings.stepCount, 2);
  assert.equal(cfg.pollSeconds, 5);
  assert.equal(cfg.once, true);
  assert.equal(cfg.stateDir, join(dir, "state"));
  assert.equal(cfg.reposDir, join(dir, "repos"));
  assert.equal(cfg.cwdBase, join(dir, "agentcwd"));
  assert.equal(cfg.appServerUrl, "ws://127.0.0.1:4500");
  assert.equal(cfg.transcriptRoot, "/x/.letta/transcripts");
  assert.equal(cfg.requestsDir, join(dir, "requests"));
  // Without LETTA_CONFIG_DIR the server uses its own Letta state under the data root.
  assert.equal(loadConfig({ MEMMEM_CONFIG: path, MEMMEM_SERVER_HOME: dir }).lettaConfigDir, join(dir, "letta"));
  assert.throws(() => loadConfig({ MEMMEM_CONFIG: join(dir, "missing.json") }), ConfigError);
});

test("state round-trips atomically and backoff grows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memmem-state-"));
  assert.deepEqual(await loadState(dir, "p"), emptyState());
  const st = emptyState();
  st.lastSeenCommit = "abc";
  await saveState(dir, "p", st);
  assert.equal((await loadState(dir, "p")).lastSeenCommit, "abc");
  assert.equal(backoffMs(0), 0);
  assert.equal(backoffMs(1), 60_000);
  assert.equal(backoffMs(3), 240_000);
  assert.equal(backoffMs(30), 3_600_000);
});

test("reflect output and error classification", () => {
  assert.equal(classifyReflectOutput(true, "Started a reflection pass for this conversation."), "started");
  assert.equal(classifyReflectOutput(true, "A reflection agent is already running for this conversation."), "already_running");
  assert.equal(classifyReflectOutput(true, "No new transcript content to reflect on for this conversation."), "nothing_to_reflect");
  assert.equal(classifyReflectOutput(false, "Failed to start reflection: x"), "failed");
  assert.equal(classifyError("You exceeded your usage limit"), "provider");
  assert.equal(classifyError("x", "llm_api_error"), "provider");
  assert.equal(classifyError("connect ECONNREFUSED 127.0.0.1:4500"), "connection");
  assert.equal(classifyError("tool call rejected"), "agent");
  assert.equal(stepsSinceReflection({ total_completed_steps: 5, reflected_completed_steps: 2 }), 3);
  assert.equal(stepsSinceReflection({ steps_since_last_successful_reflection: 1 }), 1);
  assert.equal(stepsSinceReflection(null), 0);
});

test("agent-not-found errors carry an App Server restart hint", () => {
  assert.match(agentNotFoundHint("Agent agent-local-1234 not found"), /restart/);
  assert.equal(agentNotFoundHint("connect ECONNREFUSED 127.0.0.1:4500"), "");
});
