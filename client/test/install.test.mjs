import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { mergeHooks, OURS, claudeEntries, codexContextTokensFromEnv, codexEntries } from "../lib/install.mjs";
import { isolatedEnv, run, tmpDir } from "./helpers.mjs";

/** `memmem setup --hooks-only` into `proj` with `--bin <bin>`. */
const hooksOnly = (proj, bin, env) => run(["setup", "--hooks-only", "--dir", proj, "--bin", bin], { env });

test("setup --hooks-only merges hooks into the project idempotently, keeps existing hooks, leaves HOME alone", () => {
  const home = tmpDir();
  const proj = tmpDir();
  const env = isolatedEnv(home);
  const settings = path.join(proj, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const existing = {
    model: "opus",
    hooks: {
      SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
    },
  };
  fs.writeFileSync(settings, JSON.stringify(existing));

  const r1 = hooksOnly(proj, "memmem", env);
  assert.equal(r1.code, 0, r1.stdout + r1.stderr);
  const s1 = fs.readFileSync(settings, "utf8");
  const codexFile = path.join(proj, ".codex", "hooks.json");
  const c1 = fs.readFileSync(codexFile, "utf8");
  const r2 = hooksOnly(proj, "memmem", env);
  assert.equal(r2.code, 0);
  assert.equal(fs.readFileSync(settings, "utf8"), s1, "second run is a no-op (claude)");
  assert.equal(fs.readFileSync(codexFile, "utf8"), c1, "second run is a no-op (codex)");
  assert.match(r2.stdout, /unchanged/);

  const s = JSON.parse(s1);
  assert.equal(s.model, "opus");
  assert.deepEqual(s.hooks.PreToolUse, existing.hooks.PreToolUse);
  assert.equal(s.hooks.SessionStart.length, 2);
  assert.deepEqual(s.hooks.SessionStart[0], existing.hooks.SessionStart[0]);
  assert.deepEqual(s.hooks.SessionStart[1], { hooks: [{ type: "command", command: "memmem session-start --tool claude-code", timeout: 20 }] });
  assert.deepEqual(s.hooks.SessionEnd, [{ hooks: [{ type: "command", command: "memmem session-end --tool claude-code" }] }]);
  assert.deepEqual(s.hooks.Stop, [{ hooks: [{ type: "command", command: "memmem checkpoint --tool claude-code", timeout: 5 }] }]);
  assert.deepEqual(s.hooks.PreCompact, [{ hooks: [{ type: "command", command: "memmem checkpoint --tool claude-code", timeout: 10 }] }]);

  const c = JSON.parse(c1);
  assert.deepEqual(Object.keys(c.hooks).sort(), ["PreCompact", "SessionEnd", "SessionStart", "Stop"]);
  assert.deepEqual(c.hooks.SessionStart, [{ hooks: [{ type: "command", command: "memmem session-start --tool codex",
    statusMessage: "Loading team memory", timeout: 20, additionalContextLimit: 12000 }] }]);
  assert.equal(c.hooks.SessionEnd[0].hooks[0].timeout, 3);
  assert.deepEqual(c.hooks.Stop, [{ hooks: [{ type: "command", command: "memmem checkpoint --tool codex", timeout: 5 }] }]);
  assert.deepEqual(c.hooks.PreCompact, [{ hooks: [{ type: "command", command: "memmem checkpoint --tool codex", timeout: 10 }] }]);

  const skill = path.join(proj, ".claude", "skills", "remember", "SKILL.md");
  assert.match(fs.readFileSync(skill, "utf8"), /memmem remember/);
  assert.ok(!fs.existsSync(path.join(home, ".claude")));
  assert.ok(!fs.existsSync(path.join(home, ".codex")));

  // Changing --bin replaces our entry instead of adding a second one.
  hooksOnly(proj, "node /opt/mem-mem/client/bin/memmem.mjs", env);
  const s3 = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.equal(s3.hooks.SessionStart.length, 2);
  assert.equal(s3.hooks.SessionStart[1].hooks[0].command, "node /opt/mem-mem/client/bin/memmem.mjs session-start --tool claude-code");
  assert.equal(s3.hooks.Stop.length, 1);
  assert.equal(s3.hooks.Stop[0].hooks[0].command, "node /opt/mem-mem/client/bin/memmem.mjs checkpoint --tool claude-code");
  assert.equal(s3.hooks.PreCompact.length, 1);
});

test("setup --hooks-only: MEMMEM_CODEX_CONTEXT_TOKENS sets the Codex additionalContextLimit (0 = unlimited)", () => {
  assert.equal(codexContextTokensFromEnv({}), 12000);
  assert.equal(codexContextTokensFromEnv({ MEMMEM_CODEX_CONTEXT_TOKENS: "0" }), 0);
  assert.equal(codexContextTokensFromEnv({ MEMMEM_CODEX_CONTEXT_TOKENS: " 30000 " }), 30000);
  for (const bad of ["-1", "1.5", "lots"]) assert.equal(codexContextTokensFromEnv({ MEMMEM_CODEX_CONTEXT_TOKENS: bad }), null, bad);

  const home = tmpDir();
  const proj = tmpDir();
  const codexFile = path.join(proj, ".codex", "hooks.json");
  const limit = () => JSON.parse(fs.readFileSync(codexFile, "utf8")).hooks.SessionStart[0].hooks[0].additionalContextLimit;
  const r0 = hooksOnly(proj, "memmem", isolatedEnv(home, { MEMMEM_CODEX_CONTEXT_TOKENS: "0" }));
  assert.equal(r0.code, 0, r0.stdout);
  assert.equal(limit(), 0);
  const rBad = hooksOnly(proj, "memmem", isolatedEnv(home, { MEMMEM_CODEX_CONTEXT_TOKENS: "lots" }));
  assert.equal(rBad.code, 0, rBad.stdout);
  assert.match(rBad.stdout, /WARNING: MEMMEM_CODEX_CONTEXT_TOKENS/);
  assert.equal(limit(), 12000, "invalid value falls back to the default");
  assert.match(rBad.stdout, /changed hooks need trusting again/);
  const claude = JSON.parse(fs.readFileSync(path.join(proj, ".claude", "settings.json"), "utf8"));
  assert.ok(!("additionalContextLimit" in claude.hooks.SessionStart[0].hooks[0]), "Claude Code entries have no such field");
});

test("setup --hooks-only refuses to clobber invalid JSON", () => {
  const home = tmpDir();
  const proj = tmpDir();
  const env = isolatedEnv(home);
  const settings = path.join(proj, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, "{ not json");
  const r = hooksOnly(proj, "memmem", env);
  assert.equal(r.code, 1);
  assert.equal(fs.readFileSync(settings, "utf8"), "{ not json");
});

test("OURS matches every memmem hook command and nothing else", () => {
  for (const cmd of [
    "memmem session-start --tool claude-code",
    "memmem session-end --tool codex",
    "memmem checkpoint --tool claude-code",
    "node /opt/mem-mem/client/bin/memmem.mjs checkpoint --tool codex",
    '"/opt/x/memmem" checkpoint',
  ]) assert.match(cmd, OURS, cmd);
  for (const cmd of ["memmem remember hi", "memmem sync --tool codex", "echo checkpoint", "guard.sh session-start", "memmem checkpoints"]) {
    assert.doesNotMatch(cmd, OURS, cmd);
  }
});

test("mergeHooks keeps foreign Stop/PreCompact hooks and replaces only ours", () => {
  const foreign = { matcher: "", hooks: [{ type: "command", command: "notify-send done" }] };
  const mixed = { hooks: [{ type: "command", command: "say hi" }, { type: "command", command: "memmem checkpoint --tool claude-code", timeout: 99 }] };
  const cfg = { hooks: { Stop: [foreign, mixed] } };
  const once = mergeHooks(cfg, claudeEntries("memmem"));
  const twice = mergeHooks(once, claudeEntries("memmem"));
  assert.deepEqual(twice, once);
  assert.deepEqual(once.hooks.Stop, [foreign, { hooks: [{ type: "command", command: "say hi" }] }, claudeEntries("memmem").Stop]);
  assert.deepEqual(Object.keys(once.hooks).sort(), ["PreCompact", "SessionEnd", "SessionStart", "Stop"]);
  assert.deepEqual(Object.keys(codexEntries("memmem")).sort(), ["PreCompact", "SessionEnd", "SessionStart", "Stop"]);
});
