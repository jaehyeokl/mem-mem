// User mode (0.1.1): the activation rule, the user-level install, setup without
// touching the project's tracked files, the session-start pointer, uninstall.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { USER_SKILLS } from "../lib/assets.generated.mjs";
import { intro } from "../lib/context.mjs";
import { doctorChecks } from "../lib/doctor.mjs";
import { commandPaths, OURS } from "../lib/install.mjs";
import { codexTrustKeys, hasInlineCodexHooks, installUser, removeTrustRecords, uninstallUser, userCodexEntries, userHookCommand, userInstallState } from "../lib/user.mjs";
import { findConfig, mainCheckout, readLocal } from "../lib/util.mjs";
import { BIN, CLAUDE_FIXTURE, CODEX_FIXTURE, lsTree, makeBareRepo, REPO_DIR, run, sh, snapshot, strictEnv, TEST_BIN, tmpDir, waitFor } from "./helpers.mjs";

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
// git records real paths (macOS: /var is a symlink to /private/var), and a spawned CLI's process.cwd() is real too.
const real = (p) => fs.realpathSync(p);
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TEMPLATE = path.join(REPO_DIR, "templates", "memory-repo", "en");
const HOOKS = ["session-start", "session-end", "checkpoint"];
const TOOLS = ["claude-code", "codex"];
/** The invocation the CLI under test writes into user-level hook commands. */
const SELF = TEST_BIN ? { cmd: TEST_BIN, args: [] } : { cmd: process.execPath, args: [BIN] };
const FAKE = { cmd: "/home/u/.local/bin/memmem", args: [] };

function writeConfig(dir, config, local) {
  fs.mkdirSync(path.join(dir, ".memmem"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".memmem", "config.json"), typeof config === "string" ? config : JSON.stringify(config));
  if (local !== undefined) fs.writeFileSync(path.join(dir, ".memmem", "local.json"), typeof local === "string" ? local : JSON.stringify(local));
}

test("findConfig stops at the first folder with .git (directory or worktree file)", () => {
  const root = tmpDir();
  const proj = path.join(root, "proj");
  writeConfig(proj, { project: "acme" }, { member: "alice" });
  fs.mkdirSync(path.join(proj, ".git"));
  fs.mkdirSync(path.join(proj, "src", "deep"), { recursive: true });
  assert.equal(findConfig(path.join(proj, "src", "deep")).dir, proj, "inside the project's own repo");
  const nested = path.join(proj, "vendor", "lib");
  fs.mkdirSync(path.join(nested, ".git"), { recursive: true });
  fs.mkdirSync(path.join(nested, "x"));
  assert.equal(findConfig(path.join(nested, "x")), null, "a nested repository is its own boundary");
  const wt = path.join(proj, "wt");
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: /elsewhere\n");
  assert.equal(findConfig(wt), null, "a worktree's .git file is a boundary too");
  writeConfig(nested, { project: "inner" }, { member: "bob" });
  assert.equal(findConfig(path.join(nested, "x")).dir, nested, "the boundary folder itself is checked");
});

test("no-op lock: every hook, both tools, with and without --user, prints nothing and creates nothing", () => {
  const root = tmpDir();
  const env = strictEnv(root);
  fs.mkdirSync(env.HOME);
  const w = (name) => path.join(root, "w", name);
  const cases = [];
  // A folder without .memmem.
  fs.mkdirSync(w("plain"), { recursive: true });
  cases.push(["no .memmem", w("plain"), [false, true]]);
  // A nested, unrelated repository under a user-mode project and under a shared project.
  for (const mode of ["user", "shared"]) {
    const outer = w(`outer-${mode}`);
    writeConfig(outer, { project: "acme", memoryRepo: "/nope/m.git", transcriptsRepo: "/nope/t.git" }, { member: "alice", ...(mode === "user" ? { mode } : {}) });
    sh("git", ["init", "--quiet", "-b", "main", path.join(outer, "vendor", "lib")], { env });
    cases.push([`nested repo under a ${mode} project`, path.join(outer, "vendor", "lib"), [false, true]]);
  }
  // Config without a member.
  writeConfig(w("nomember"), { project: "acme", memoryRepo: "/nope/m.git", transcriptsRepo: "/nope/t.git" }, { mode: "user" });
  cases.push(["no member", w("nomember"), [false, true]]);
  writeConfig(w("nolocal"), { project: "acme", memoryRepo: "/nope/m.git", transcriptsRepo: "/nope/t.git" });
  cases.push(["no local.json", w("nolocal"), [false, true]]);
  // Mode mismatch, both directions.
  writeConfig(w("usermode"), { project: "acme", memoryRepo: "/nope/m.git", transcriptsRepo: "/nope/t.git" }, { member: "alice", mode: "user" });
  cases.push(["user-mode project, project-level hook", w("usermode"), [false]]);
  writeConfig(w("sharedmode"), { project: "acme", memoryRepo: "/nope/m.git", transcriptsRepo: "/nope/t.git" }, { member: "alice" });
  cases.push(["shared project, user-level hook", w("sharedmode"), [true]]);
  // Invalid JSON.
  writeConfig(w("badconfig"), "{ not json", { member: "alice", mode: "user" });
  cases.push(["invalid config.json", w("badconfig"), [false, true]]);
  writeConfig(w("badlocal"), { project: "acme", memoryRepo: "/nope/m.git", transcriptsRepo: "/nope/t.git" }, "{ not json");
  cases.push(["invalid local.json", w("badlocal"), [false, true]]);
  writeConfig(w("arrayconfig"), "[1]", { member: "alice", mode: "user" });
  cases.push(["config.json not an object", w("arrayconfig"), [false, true]]);
  // A linked worktree (sibling and nested) of a repository that does not use memmem.
  const plainRepo = w("plainrepo");
  sh("git", ["init", "--quiet", "-b", "main", plainRepo], { env });
  sh("git", ["commit", "--quiet", "--allow-empty", "-m", "init"], { cwd: plainRepo, env });
  sh("git", ["worktree", "add", "--quiet", "-b", "wt1", w("plainrepo-wt")], { cwd: plainRepo, env });
  sh("git", ["worktree", "add", "--quiet", "-b", "wt2", path.join(plainRepo, ".claude", "worktrees", "x")], { cwd: plainRepo, env });
  cases.push(["sibling worktree of a non-memmem repo", w("plainrepo-wt"), [false, true]]);
  cases.push(["nested worktree of a non-memmem repo", path.join(plainRepo, ".claude", "worktrees", "x"), [false, true]]);

  const before = snapshot(path.join(root, "w"));
  const run1 = (dir, sub, tool, user, extraEnv = {}) => {
    const args = [sub, "--tool", tool, ...(user ? ["--user"] : [])];
    const transcript = tool === "codex" ? CODEX_FIXTURE : CLAUDE_FIXTURE;
    const event = { "session-start": "SessionStart", "session-end": "SessionEnd", checkpoint: "PreCompact" }[sub];
    const r = run(args, { env: { ...env, ...extraEnv }, cwd: dir, input: JSON.stringify({ session_id: "s-1", transcript_path: transcript, cwd: dir, hook_event_name: event }) });
    const label = `${args.join(" ")} in ${path.relative(root, dir)}`;
    assert.equal(r.code, 0, label);
    assert.equal(r.stdout, sub === "checkpoint" && tool === "codex" ? "{}\n" : "", label);
    assert.equal(r.stderr, "", label);
  };
  let n = 0;
  for (const [, dir, flags] of cases) for (const sub of HOOKS) for (const tool of TOOLS) for (const user of flags) { run1(dir, sub, tool, user); n++; }
  // MEMMEM_DISABLE=1 in projects whose mode matches.
  for (const [dir, user] of [[w("usermode"), true], [w("sharedmode"), false]]) for (const sub of HOOKS) for (const tool of TOOLS) { run1(dir, sub, tool, user, { MEMMEM_DISABLE: "1" }); n++; }
  assert.ok(n >= 90, `${n} runs`);
  assert.deepEqual(snapshot(path.join(root, "w")), before, "no project file created or changed");
  assert.deepEqual(snapshot(env.HOME), [], "the fake HOME stays empty");
  assert.ok(!fs.existsSync(env.MEMMEM_HOME), "no data root");
});

test("user-level hook command: guarded on POSIX, recognized by OURS and doctor's path check", () => {
  const bin = userHookCommand("session-start", "codex", { invocation: FAKE, platform: "linux" });
  assert.equal(bin, "[ -x '/home/u/.local/bin/memmem' ] || exit 0; '/home/u/.local/bin/memmem' session-start --tool codex --user");
  const src = userHookCommand("checkpoint", "claude-code", { invocation: { cmd: "/opt/node/bin/node", args: ["/a b/it's/bin/memmem.mjs"] }, platform: "linux" });
  assert.equal(src, "[ -x '/opt/node/bin/node' ] && [ -f '/a b/it'\\''s/bin/memmem.mjs' ] || exit 0; '/opt/node/bin/node' '/a b/it'\\''s/bin/memmem.mjs' checkpoint --tool claude-code --user");
  const win = userHookCommand("session-end", "codex", { invocation: { cmd: "C:\\Users\\a\\memmem.exe", args: [] }, platform: "win32" });
  assert.equal(win, "C:/Users/a/memmem.exe session-end --tool codex --user");
  for (const c of [bin, src, win]) assert.match(c, OURS, c);
  assert.deepEqual(commandPaths(bin), ["/home/u/.local/bin/memmem"]);
  assert.deepEqual(commandPaths(userHookCommand("checkpoint", "codex", { invocation: { cmd: "/opt/node", args: ["/opt/c/bin/memmem.mjs"] }, platform: "linux" })), ["/opt/node", "/opt/c/bin/memmem.mjs"]);
  // The guard: a missing binary is a silent exit 0 (Claude Code / Codex show nothing).
  const r = spawnSync("sh", ["-c", userHookCommand("session-start", "codex", { invocation: { cmd: "/nonexistent/memmem", args: [] }, platform: "linux" })], { encoding: "utf8", input: "{}" });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
});

// Codex stores a trust hash per hook definition and skips a changed hook in `codex exec`
// until the user reviews it again. Changing this snapshot forces every user to re-review
// the memmem hooks: change it only on purpose, and say so in the release notes.
test("Codex user-level hooks.json is byte-stable (snapshot)", () => {
  const root = tmpDir();
  const env = { HOME: path.join(root, "home"), CODEX_HOME: path.join(root, "home", ".codex"), PATH: "" };
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  installUser({ env, platform: "linux", invocation: FAKE });
  const B = "[ -x '/home/u/.local/bin/memmem' ] || exit 0; '/home/u/.local/bin/memmem'";
  const expected = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: `${B} session-start --tool codex --user`, timeout: 20, additionalContextLimit: 12000 }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: `${B} session-end --tool codex --user`, timeout: 3 }] }],
      Stop: [{ hooks: [{ type: "command", command: `${B} checkpoint --tool codex --user`, timeout: 5 }] }],
      PreCompact: [{ hooks: [{ type: "command", command: `${B} checkpoint --tool codex --user`, timeout: 10 }] }],
    },
  };
  assert.equal(fs.readFileSync(path.join(env.CODEX_HOME, "hooks.json"), "utf8"), JSON.stringify(expected, null, 2) + "\n");
  assert.ok(!JSON.stringify(userCodexEntries({ invocation: FAKE, platform: "linux" })).includes("statusMessage"));
});

test("installUser: present tools only, keeps foreign content and style, idempotent; uninstall --user restores byte-identical files", () => {
  const root = tmpDir();
  const home = path.join(root, "home");
  const env = { HOME: home, PATH: path.join(root, "empty") };
  const said = [];
  const say = (s) => said.push(s);
  // Nothing present: nothing written.
  fs.mkdirSync(home);
  installUser({ env, platform: "linux", invocation: FAKE, say });
  assert.deepEqual(snapshot(home), []);
  assert.match(said.join("\n"), /claude-code: skipped .*\n.*codex: skipped/);

  // Claude Code present with a user settings file (4-space indent, no final newline, foreign hooks).
  const claudeFile = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  const original = JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }], PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }] }, permissions: { allow: ["Bash(ls)"] } }, null, 4);
  fs.writeFileSync(claudeFile, original);
  // A same-named skill that is not ours is never overwritten.
  const foreignSkill = path.join(home, ".agents", "skills", "memmem-init", "SKILL.md");
  fs.mkdirSync(path.dirname(foreignSkill), { recursive: true });
  fs.writeFileSync(foreignSkill, "---\nname: memmem-init\n---\nsomeone else's skill\n");
  fs.mkdirSync(path.join(home, ".codex"));
  said.length = 0;
  const r1 = installUser({ env, platform: "linux", invocation: FAKE, say });
  assert.deepEqual([r1.claude.hooks, r1.claude.skill, r1.codex.hooks, r1.codex.skill], ["installed", "installed", "installed", "foreign"]);
  const s = fs.readFileSync(claudeFile, "utf8");
  assert.ok(s.startsWith('{\n    "model": "opus"') && !s.endsWith("\n"), "style kept");
  const cfg = JSON.parse(s);
  assert.deepEqual(Object.keys(cfg.hooks), ["Stop", "PreToolUse", "SessionStart", "SessionEnd"]);
  assert.equal(cfg.hooks.Stop[0].hooks[0].command, "notify-send done");
  assert.match(cfg.hooks.Stop[1].hooks[0].command, /checkpoint --tool claude-code --user$/);
  assert.equal(cfg.hooks.Stop[1].hooks[0].timeout, 5);
  assert.equal(cfg.hooks.SessionStart[0].hooks[0].timeout, 20);
  assert.ok(!("PreCompact" in cfg.hooks), "no PreCompact at user level for Claude Code");
  assert.deepEqual(cfg.permissions, { allow: ["Bash(ls)"] });
  const skill = fs.readFileSync(path.join(home, ".claude", "skills", "memmem-init", "SKILL.md"), "utf8");
  assert.equal(skill, USER_SKILLS.claudeInit.files["SKILL.md"]);
  assert.match(skill, /^---\n[\s\S]*\ndisable-model-invocation: true\n---\n/);
  assert.match(skill, /\n0\. First check that this project uses mem-mem/);
  assert.equal(fs.readFileSync(foreignSkill, "utf8"), "---\nname: memmem-init\n---\nsomeone else's skill\n");
  assert.ok(!fs.existsSync(path.join(home, ".agents", "skills", "memmem-init", "agents")));
  assert.match(said.join("\n"), /WARNING: .*memmem-init exists and is not ours; left untouched/);
  assert.match(said.join("\n"), /approve the memmem hooks on its review screen/);

  // Second run: nothing changes, and it says so.
  const snap = snapshot(home);
  said.length = 0;
  const r2 = installUser({ env, platform: "linux", invocation: FAKE, say });
  assert.deepEqual([r2.claude.hooks, r2.codex.hooks], ["unchanged", "unchanged"]);
  assert.deepEqual(snapshot(home), snap);
  assert.match(said.join("\n"), /user-level install unchanged/);
  assert.doesNotMatch(said.join("\n"), /review screen/);
  // An old hand-written PreCompact entry of ours is dropped on refresh.
  const withOld = JSON.parse(fs.readFileSync(claudeFile, "utf8"));
  withOld.hooks.PreCompact = [{ hooks: [{ type: "command", command: "/home/u/.local/bin/memmem checkpoint --tool claude-code", timeout: 10 }] }];
  fs.writeFileSync(claudeFile, JSON.stringify(withOld, null, 4));
  assert.equal(installUser({ env, platform: "linux", invocation: FAKE }).claude.hooks, "updated");
  assert.equal(fs.readFileSync(claudeFile, "utf8"), snap.find((l) => l.startsWith(".claude/settings.json=")).slice(".claude/settings.json=".length));

  // The Codex skill installs once the foreign one is gone.
  fs.rmSync(path.join(home, ".agents"), { recursive: true });
  assert.equal(installUser({ env, platform: "linux", invocation: FAKE }).codex.skill, "installed");
  assert.equal(fs.readFileSync(path.join(home, ".agents", "skills", "memmem-init", "agents", "openai.yaml"), "utf8"), "policy:\n  allow_implicit_invocation: false\n");
  const st = userInstallState({ env, platform: "linux" });
  assert.deepEqual([st.claude.missing, st.codex.missing, st.claude.skill, st.codex.skill], [[], [], "ok", "ok"]);
  assert.deepEqual(st.codex.badPaths, ["/home/u/.local/bin/memmem"], "the fake binary does not exist");

  // uninstall --user: Claude settings byte-identical, hooks.json we created removed, skills and empty parents removed.
  said.length = 0;
  assert.equal(uninstallUser({ env, say }), 0);
  assert.equal(fs.readFileSync(claudeFile, "utf8"), original);
  assert.ok(!fs.existsSync(path.join(home, ".codex", "hooks.json")));
  assert.ok(!fs.existsSync(path.join(home, ".claude", "skills")));
  assert.ok(!fs.existsSync(path.join(home, ".agents")));
  assert.deepEqual(snapshot(home), [".claude/", `.claude/settings.json=${original}`, ".codex/"]);
});

test("installUser refuses to clobber an invalid settings file; inline Codex hooks get a note", () => {
  const root = tmpDir();
  const home = path.join(root, "home");
  const env = { HOME: home, PATH: "" };
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{ nope");
  assert.throws(() => installUser({ env, platform: "linux", invocation: FAKE }));
  assert.equal(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"), "{ nope");
  const r = run(["install"], { env: { ...strictEnv(root), HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CODEX_HOME: path.join(home, ".codex") } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /memmem install: .*nothing changed/);

  assert.equal(hasInlineCodexHooks('model = "x"\n[hooks.state]\n\n[hooks.state."/h/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:1"\n'), false);
  assert.equal(hasInlineCodexHooks('[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\n'), true);
  assert.equal(hasInlineCodexHooks('[hooks]\nSessionStart = []\n'), true);
  fs.rmSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "say done"\n');
  const said = [];
  installUser({ env, platform: "linux", invocation: FAKE, say: (s) => said.push(s) });
  assert.match(said.join("\n"), /config\.toml also defines hooks inline; Codex warns/);
  assert.ok(fs.existsSync(path.join(home, ".codex", "hooks.json")), "hooks.json is still written");
  assert.doesNotMatch(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), /memmem/, "config.toml gets no hook definitions");
});

test("uninstall --user removes exactly the Codex trust records of our hooks from a realistic config.toml", () => {
  const root = tmpDir();
  const home = path.join(root, "home");
  const codex = path.join(home, ".codex");
  const env = { HOME: home, PATH: "" };
  fs.mkdirSync(codex, { recursive: true });
  const hooksFile = path.join(codex, "hooks.json");
  // A foreign user-level hook first (SessionStart group 0), then memmem's.
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/opt/sentinel.sh", timeout: 5 }] }] } }, null, 2) + "\n");
  const before = fs.readFileSync(hooksFile, "utf8");
  installUser({ env, platform: "linux", invocation: FAKE });
  const keys = codexTrustKeys(hooksFile, readJson(hooksFile));
  // Codex keys the records by the hooks.json path it was given; memmem removes both the given and the real form.
  const forms = [...new Set([hooksFile, real(hooksFile)])];
  assert.deepEqual(keys, ["session_start:1:0", "session_end:0:0", "stop:0:0", "pre_compact:0:0"].flatMap((k) => forms.map((f) => `${f}:${k}`)));
  const rec = (key, hash) => `[hooks.state."${key}"]\ntrusted_hash = "sha256:${hash}"\n`;
  const proj = path.join(root, "proj", "M2");
  const head = `model_reasoning_effort = "low"\n\n[sandbox_workspace_write]\nexclude_slash_tmp = true\n\n[projects."${proj}"]\ntrust_level = "trusted"\n\n[hooks.state]\n\n`;
  const foreign = [rec(`${hooksFile}:session_start:0:0`, "aa11"), rec(`${proj}/.codex/hooks.json:session_start:0:0`, "bb22")];
  const ours = keys.filter((k) => k.startsWith(`${hooksFile}:`)).map((k, i) => rec(k, `cc3${i}`));
  const toml = head + [foreign[0], ours[0], foreign[1], ours[1], ours[2], ours[3]].join("\n");
  fs.writeFileSync(path.join(codex, "config.toml"), toml);
  const said = [];
  assert.equal(uninstallUser({ env, say: (s) => said.push(s) }), 0);
  assert.equal(fs.readFileSync(path.join(codex, "config.toml"), "utf8"), head + foreign.join("\n"));
  assert.match(said.join("\n"), /removed 4 Codex trust record\(s\)/);
  assert.equal(fs.readFileSync(hooksFile, "utf8"), before, "the foreign hook stays, file byte-identical");

  // A record with anything but trusted_hash: leave the whole file and say so.
  const odd = rec(`${hooksFile}:stop:0:0`, "dd44").replace("\n", '\nenabled = false\n');
  const r = removeTrustRecords(head + odd, [`${hooksFile}:stop:0:0`]);
  assert.deepEqual([r.text, r.removed, r.unsure], [head + odd, 0, true]);
  assert.equal(removeTrustRecords("x = 1\n", keys).text, "x = 1\n");
});

/** A git repo that tracks the agent files a real client repository has. */
function trackedRepo(root, env) {
  const proj = path.join(root, "client-repo");
  sh("git", ["init", "--quiet", "-b", "main", proj], { env });
  const files = {
    ".claude/settings.json": JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo project" }] }] } }, null, 2) + "\n",
    ".codex/hooks.json": JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } }, null, 2) + "\n",
    ".agents/skills/their-skill/SKILL.md": "---\nname: their-skill\n---\nhi\n",
    "AGENTS.md": "# Their rules\n",
    ".gitignore": "node_modules/\n",
    "src/index.js": "console.log(1);\n",
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(proj, rel)), { recursive: true });
    fs.writeFileSync(path.join(proj, rel), text);
  }
  sh("git", ["add", "-A"], { cwd: proj, env });
  sh("git", ["commit", "--quiet", "-m", "client"], { cwd: proj, env });
  return { proj, files };
}

function userWorld() {
  const root = tmpDir();
  const env = strictEnv(root);
  fs.mkdirSync(path.join(env.HOME, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(env.HOME, ".codex"), { recursive: true });
  const claudeOriginal = '{\n  "theme": "dark"\n}\n';
  fs.writeFileSync(path.join(env.HOME, ".claude", "settings.json"), claudeOriginal);
  const memoryBare = makeBareRepo(path.join(root, "mem.git"), TEMPLATE, env);
  const transcriptsBare = makeBareRepo(path.join(root, "tr.git"), path.join(REPO_DIR, "templates", "transcripts-repo"), env);
  const { proj, files } = trackedRepo(root, env);
  const setup = (...a) => run(["setup", "--project", "acme", "--memory-repo", memoryBare, "--transcripts-repo", transcriptsBare, "--member", "alice", ...a], { env, cwd: proj });
  return { root, env, proj, files, memoryBare, transcriptsBare, setup, claudeOriginal };
}

const status = (w) => sh("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: w.proj, env: w.env });

test("setup (user mode): only .memmem/, hidden through info/exclude; tracked agent files and git status untouched; idempotent", () => {
  const w = userWorld();
  assert.equal(status(w), "");
  const r = w.setup();
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(status(w), "", "git status unchanged");
  for (const [rel, text] of Object.entries(w.files)) assert.equal(fs.readFileSync(path.join(w.proj, rel), "utf8"), text, rel);
  assert.deepEqual(fs.readdirSync(w.proj).sort(), [".agents", ".claude", ".codex", ".git", ".gitignore", ".memmem", "AGENTS.md", "src"]);
  assert.deepEqual(readJson(path.join(w.proj, ".memmem", "local.json")), { member: "alice", mode: "user", excluded: true });
  assert.ok(fs.existsSync(path.join(w.proj, ".memmem", "memory", "MEMORY.md")));
  assert.match(fs.readFileSync(path.join(w.proj, ".memmem", "guide", "remember.md"), "utf8"), /memmem remember - <<'EOF'/);
  assert.match(fs.readFileSync(path.join(w.proj, ".git", "info", "exclude"), "utf8"), /\n\.memmem\/\n$/);
  assert.ok(lsTree(w.transcriptsBare, w.env).includes("members/alice.json"), "member registered");
  // User level: Claude Code settings (3 events), Codex hooks.json (4 events), the skills.
  const claude = readJson(path.join(w.env.HOME, ".claude", "settings.json"));
  assert.equal(claude.theme, "dark");
  assert.deepEqual(Object.keys(claude.hooks), ["SessionStart", "SessionEnd", "Stop"]);
  assert.equal(claude.hooks.SessionStart[0].hooks[0].command, userHookCommand("session-start", "claude-code", { invocation: SELF }));
  assert.deepEqual(Object.keys(readJson(path.join(w.env.HOME, ".codex", "hooks.json")).hooks), ["SessionStart", "SessionEnd", "Stop", "PreCompact"]);
  assert.ok(fs.existsSync(path.join(w.env.HOME, ".claude", "skills", "memmem-init", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(w.env.HOME, ".agents", "skills", "memmem-init", "agents", "openai.yaml")));
  assert.match(r.stdout, /approve the memmem hooks on its review screen/);
  assert.match(r.stdout, /\/memmem-init \(Claude Code\) or \$memmem-init \(Codex\)/);
  assert.match(r.stdout, /every teammate runs the same `memmem setup/);
  assert.doesNotMatch(r.stdout, /next: commit/);

  const snap = [snapshot(path.join(w.proj, ".memmem")).filter((l) => !l.startsWith("memory/.git")), snapshot(w.env.HOME), fs.readFileSync(path.join(w.proj, ".git", "info", "exclude"), "utf8")];
  const again = w.setup();
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual([snapshot(path.join(w.proj, ".memmem")).filter((l) => !l.startsWith("memory/.git")), snapshot(w.env.HOME), fs.readFileSync(path.join(w.proj, ".git", "info", "exclude"), "utf8")], snap);
  assert.match(again.stdout, /user-level install unchanged/);
  assert.match(again.stdout, /remember guide unchanged/);
  // A plain `memmem setup` in a user-mode checkout refreshes the same way (not the shared teammate flow).
  const plain = run(["setup"], { env: w.env, cwd: w.proj });
  assert.equal(plain.code, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout, /warning: memmem hooks missing/);
  assert.equal(status(w), "");
  // A linked worktree needs no setup of its own (it uses the main checkout's .memmem/), and shares the exclude file.
  sh("git", ["worktree", "add", "--quiet", "-b", "wt", path.join(w.root, "wt")], { cwd: w.proj, env: w.env });
  const wt = run(["setup", "--project", "acme", "--memory-repo", w.memoryBare, "--transcripts-repo", w.transcriptsBare, "--member", "alice", "--no-clone"], { env: w.env, cwd: path.join(w.root, "wt") });
  assert.equal(wt.code, 0, wt.stderr);
  assert.match(wt.stdout, /already uses the memmem setup of its main checkout/);
  assert.ok(!fs.existsSync(path.join(w.root, "wt", ".memmem")));
  fs.mkdirSync(path.join(w.root, "wt", ".memmem", "outbox"), { recursive: true });
  fs.writeFileSync(path.join(w.root, "wt", ".memmem", "outbox", "n.md"), "x\n");
  assert.equal(fs.readFileSync(path.join(w.proj, ".git", "info", "exclude"), "utf8").split("\n").filter((l) => l === ".memmem/").length, 1);
  assert.equal(sh("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: path.join(w.root, "wt"), env: w.env }), "", "a worktree's .memmem/ is hidden too");
});

test("user mode: session-start --user injects the memory and the guide pointer (kept when the index is cut); session-end uploads", async () => {
  const w = userWorld();
  assert.equal(w.setup("--language", "ko").code, 0);
  const input = JSON.stringify({ session_id: "11111111-2222-4333-8444-555555555555", cwd: w.proj, hook_event_name: "SessionStart", source: "startup" });
  const guide = path.join(w.proj, ".memmem", "guide", "remember.md");
  const claude = run(["session-start", "--tool", "claude-code", "--user"], { env: w.env, input });
  assert.equal(claude.code, 0, claude.stderr);
  const ctx = JSON.parse(claude.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /^이 프로젝트\(acme\)/);
  assert.match(ctx, /## MEMORY\.md/);
  assert.ok(ctx.includes(`\`${guide}\`를 읽고 그대로 따르라`), "pointer in the memory language");
  assert.match(ctx, /\/memmem-init로 한다/);
  const codex = run(["session-start", "--tool", "codex", "--user"], { env: w.env, input });
  assert.ok(codex.stdout.includes(guide) && codex.stdout.includes("$memmem-init"));
  // The project-level form does nothing here (no double run next to project hooks).
  assert.equal(run(["session-start", "--tool", "claude-code"], { env: w.env, input }).stdout, "");
  // A long index cut to a tiny budget keeps the pointer (it is part of the never-truncated head).
  const big = path.join(w.proj, ".memmem", "memory", "decisions");
  fs.mkdirSync(big, { recursive: true });
  fs.writeFileSync(path.join(big, "MEMORY.md"), Array.from({ length: 400 }, (_, i) => `- [d${i}](d${i}.md): decision ${i}`).join("\n"));
  const cut = run(["session-start", "--tool", "codex", "--user"], { env: { ...w.env, MEMMEM_CONTEXT_MAX_CHARS: "3000", MEMMEM_PULL_TIMEOUT_MS: "1" }, input });
  assert.match(cut.stdout, /잘림/);
  assert.ok(cut.stdout.includes(guide));
  // Shared projects get no pointer (their skill and AGENTS.md block cover it).
  assert.doesNotMatch(intro({ project: "acme", memDir: "/m", language: "ko" }), /remember\.md|memmem-init/);

  // The installed command itself (guard included) runs the hook end to end: session-end uploads the transcript.
  const cmd = readJson(path.join(w.env.HOME, ".claude", "settings.json")).hooks.SessionEnd[0].hooks[0].command;
  // Absolute /bin/sh: the strict PATH holds only git's and node's folders (macOS keeps sh in /bin, git in /usr/bin).
  const end = spawnSync("/bin/sh", ["-c", cmd], { env: { ...w.env, MEMMEM_SYNC_DELAY_MS: "0" }, cwd: w.proj, encoding: "utf8", input: JSON.stringify({ session_id: "11111111-2222-4333-8444-555555555555", transcript_path: CLAUDE_FIXTURE, cwd: w.proj, hook_event_name: "SessionEnd" }) });
  assert.deepEqual([end.status, end.stdout, end.stderr], [0, "", ""]);
  await waitFor(() => lsTree(w.transcriptsBare, w.env).some((f) => /^trajectories\/.*\/alice\/claude-code\//.test(f)), { timeoutMs: 30_000 });
  assert.equal(status(w), "");
});

test("uninstall in a user-mode project removes .memmem/ and the exclude line only; --user removes the user level", () => {
  const w = userWorld();
  const exclude = path.join(w.proj, ".git", "info", "exclude");
  const excludeBefore = fs.readFileSync(exclude, "utf8");
  assert.equal(w.setup().code, 0);
  const u = run(["uninstall"], { env: w.env, cwd: w.proj });
  assert.equal(u.code, 0, u.stderr);
  assert.ok(!fs.existsSync(path.join(w.proj, ".memmem")));
  assert.equal(fs.readFileSync(exclude, "utf8"), excludeBefore);
  for (const [rel, text] of Object.entries(w.files)) assert.equal(fs.readFileSync(path.join(w.proj, rel), "utf8"), text, rel);
  assert.equal(status(w), "");
  assert.ok(fs.existsSync(path.join(w.env.MEMMEM_HOME, "acme", "transcripts", ".git")), "data folder kept without --purge");
  assert.match(u.stdout, /memmem uninstall --user/);
  const uu = run(["uninstall", "--user"], { env: w.env, cwd: w.root });
  assert.equal(uu.code, 0, uu.stderr);
  assert.equal(fs.readFileSync(path.join(w.env.HOME, ".claude", "settings.json"), "utf8"), w.claudeOriginal, "byte-identical");
  assert.deepEqual(snapshot(w.env.HOME), [".claude/", `.claude/settings.json=${w.claudeOriginal}`, ".codex/"]);

  // --purge removes the data folder; an outbox note keeps .memmem/.
  assert.equal(w.setup().code, 0);
  fs.mkdirSync(path.join(w.proj, ".memmem", "outbox"));
  fs.writeFileSync(path.join(w.proj, ".memmem", "outbox", "2026-11-11-x.md"), "note\n");
  const k = run(["uninstall", "--purge"], { env: w.env, cwd: w.proj });
  assert.equal(k.code, 0, k.stderr);
  assert.match(k.stdout, /kept .*\.memmem: queued note\(s\) are not uploaded yet \(1 in .*\.memmem\/outbox\)/);
  assert.ok(fs.existsSync(path.join(w.proj, ".memmem", "outbox", "2026-11-11-x.md")));
  assert.ok(!fs.existsSync(path.join(w.env.MEMMEM_HOME, "acme")), "data folder purged");
});

test("doctor and status in a user-mode project report the mode and the user-level install", () => {
  const w = userWorld();
  assert.equal(w.setup().code, 0);
  const okRunner = () => ({ ok: true, stdout: "" });
  const list = doctorChecks({ cwd: w.proj, runner: okRunner, env: w.env });
  const get = (n) => list.find((c) => c.name === n);
  assert.equal(get("mode").detail.startsWith("user"), true);
  for (const n of ["claude-code hooks (user)", "codex hooks (user)", "claude-code skill (user)", "codex skill (user)", "git ignore"]) assert.equal(get(n)?.status, "ok", n);
  assert.equal(get("codex review").status, "info");
  assert.equal(get("AGENTS.md"), undefined, "no project-level checks in user mode");
  assert.deepEqual(list.filter((c) => c.status === "fail"), []);
  // The binary the hook commands name is gone: fail with the path.
  const f = path.join(w.env.HOME, ".codex", "hooks.json");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replaceAll(SELF.cmd, "/gone/memmem"));
  const bad = doctorChecks({ cwd: w.proj, runner: okRunner, env: w.env }).find((c) => c.name === "codex hooks (user)");
  assert.equal(bad.status, "fail");
  assert.match(bad.detail, /\/gone\/memmem/);
  const s = run(["status"], { env: w.env, cwd: w.proj });
  assert.equal(s.code, 0, s.stderr);
  assert.match(s.stdout, /\nmode: user; user-level hooks: claude-code ok, codex binary missing/);
});

test("remember under a read-only data folder: outbox, then sync and the next remember upload it once", { skip: process.getuid?.() === 0 && "root ignores file modes" }, () => {
  const w = userWorld();
  assert.equal(w.setup().code, 0);
  const data = path.join(w.env.MEMMEM_HOME, "acme");
  const inbox = () => lsTree(w.transcriptsBare, w.env).filter((f) => f.startsWith("inbox/alice/"));
  const outbox = path.join(w.proj, ".memmem", "outbox");
  fs.chmodSync(data, 0o555);
  try {
    const r = run(["remember", "-"], { env: w.env, cwd: w.proj, input: "We deploy on Tuesdays\n" });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^queued .*\.memmem\/outbox\/\d{4}-\d\d-\d\d-we-deploy-on-tuesdays\.md: the data folder is read-only here \(sandbox\); it uploads at the next sync\n$/);
    const r2 = run(["remember", "We deploy on Tuesdays", "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789"], { env: w.env, cwd: w.proj });
    assert.equal(r2.code, 0, r2.stderr);
    assert.match(r2.stderr, /redacted \d+ secret-like/);
  } finally { fs.chmodSync(data, 0o755); }
  assert.equal(fs.readdirSync(outbox).length, 2);
  assert.ok(!fs.readdirSync(outbox).some((n) => fs.readFileSync(path.join(outbox, n), "utf8").includes("ghp_abcdef")), "redacted before it is written");
  assert.deepEqual(inbox(), []);
  assert.equal(status(w), "", "the outbox is hidden too");

  // sync (what the hooks run outside the sandbox) uploads them and empties the outbox.
  const s = run(["sync", "--tool", "claude-code", "--transcript", CLAUDE_FIXTURE, "--session", "s-1", "--cwd", w.proj], { env: w.env, cwd: w.proj });
  assert.equal(s.code, 0, s.stderr);
  assert.equal(inbox().length, 2);
  assert.ok(!fs.existsSync(outbox));
  // Again: nothing to do, nothing duplicated.
  run(["sync", "--tool", "claude-code", "--transcript", CLAUDE_FIXTURE, "--session", "s-1", "--cwd", w.proj], { env: w.env, cwd: w.proj });
  assert.equal(inbox().length, 2);

  // A note already copied into the clone whose outbox file survived (crash after the commit):
  // the next successful remember uploads only the new note.
  const clone = path.join(data, "transcripts", "inbox", "alice");
  const already = fs.readdirSync(clone)[0];
  fs.mkdirSync(outbox);
  fs.copyFileSync(path.join(clone, already), path.join(outbox, already));
  fs.writeFileSync(path.join(outbox, "2026-01-01-queued-earlier.md"), "---\nmember: alice\nproject: acme\ncreated: 2026-01-01T00:00:00.000Z\nsource: manual\n---\n\nqueued earlier\n");
  const r3 = run(["remember", "Third note"], { env: w.env, cwd: w.proj });
  assert.equal(r3.code, 0, r3.stderr);
  const files = inbox();
  assert.equal(files.length, 4, files.join("\n"));
  assert.ok(files.includes("inbox/alice/2026-01-01-queued-earlier.md"));
  assert.ok(!fs.existsSync(outbox));
});

test("mainCheckout / findConfig: linked worktrees use the main checkout's .memmem; submodules and bare-repo worktrees do not", () => {
  const root = tmpDir();
  const env = strictEnv(root);
  const main = path.join(root, "main");
  sh("git", ["init", "--quiet", "-b", "main", main], { env });
  sh("git", ["commit", "--quiet", "--allow-empty", "-m", "init"], { cwd: main, env });
  writeConfig(main, { project: "acme" }, { member: "alice", mode: "user" });
  const sib = path.join(root, "sib");
  sh("git", ["worktree", "add", "--quiet", "-b", "sib", sib], { cwd: main, env });
  const nested = path.join(main, ".claude", "worktrees", "x");
  sh("git", ["worktree", "add", "--quiet", "-b", "x", nested], { cwd: main, env });
  fs.mkdirSync(path.join(sib, "src", "deep"), { recursive: true });
  assert.equal(mainCheckout(main), null, "a main checkout has no main checkout");
  assert.equal(mainCheckout(sib), real(main), "the path git recorded");
  assert.equal(mainCheckout(nested), real(main));
  for (const [from, checkout] of [[sib, sib], [nested, nested], [path.join(sib, "src", "deep"), sib]]) {
    const f = findConfig(from);
    assert.deepEqual([f.dir, f.checkout, f.config.project], [real(main), checkout, "acme"], from);
  }
  assert.equal(findConfig(main).checkout, undefined, "set only for a worktree");
  assert.deepEqual(readLocal(sib), { member: "alice", mode: "user" }, "local.json falls back to the main checkout");
  // A worktree's own config wins.
  writeConfig(nested, { project: "own" });
  assert.deepEqual([findConfig(nested).dir, findConfig(nested).config.project, findConfig(nested).checkout], [nested, "own", undefined]);
  // A submodule (gitdir without commondir): null.
  const subSrc = path.join(root, "subsrc");
  sh("git", ["init", "--quiet", "-b", "main", subSrc], { env });
  sh("git", ["commit", "--quiet", "--allow-empty", "-m", "s"], { cwd: subSrc, env });
  sh("git", ["-c", "protocol.file.allow=always", "submodule", "--quiet", "add", subSrc, "vendor/sub"], { cwd: main, env });
  assert.ok(fs.statSync(path.join(main, "vendor", "sub", ".git")).isFile());
  assert.equal(mainCheckout(path.join(main, "vendor", "sub")), null);
  assert.equal(findConfig(path.join(main, "vendor", "sub")), null);
  // A worktree of a bare repository: no main checkout.
  const bare = makeBareRepo(path.join(root, "b.git"), path.join(REPO_DIR, "templates", "transcripts-repo"), env);
  const bw = path.join(root, "bw");
  sh("git", ["--git-dir", bare, "worktree", "add", "--quiet", bw, "main"], { env });
  assert.equal(mainCheckout(bw), null);
  assert.equal(findConfig(bw), null);
});

/** userWorld + user-mode setup + a sibling linked worktree. */
function worktreeWorld() {
  const w = userWorld();
  assert.equal(w.setup().code, 0);
  const wt = path.join(w.root, "wt");
  sh("git", ["worktree", "add", "--quiet", "-b", "wt", wt], { cwd: w.proj, env: w.env });
  return { ...w, wt, wtStatus: () => sh("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: wt, env: w.env }) };
}

test("user mode in a linked worktree: hooks act with the main checkout's setup; project-level forms stay silent", async () => {
  const w = worktreeWorld();
  const sid = "22222222-2222-4333-8444-555555555555";
  const input = (ev, extra = {}) => JSON.stringify({ session_id: sid, cwd: w.wt, hook_event_name: ev, ...extra });
  const guide = path.join(real(w.proj), ".memmem", "guide", "remember.md");
  const s = run(["session-start", "--tool", "codex", "--user"], { env: w.env, cwd: w.wt, input: input("SessionStart") });
  assert.equal(s.code, 0, s.stderr);
  assert.match(s.stdout, /## MEMORY\.md/);
  assert.ok(s.stdout.includes(`\`${guide}\``), "the pointer names the main checkout's guide");
  assert.ok(s.stdout.includes(path.join(real(w.proj), ".memmem", "memory")), "the main checkout's memory clone");
  for (const sub of ["session-start", "session-end", "checkpoint"]) {
    const r = run([sub, "--tool", "claude-code"], { env: w.env, cwd: w.wt, input: input("PreCompact", { transcript_path: CLAUDE_FIXTURE }) });
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""], `${sub} without --user`);
  }
  const cp = run(["checkpoint", "--tool", "claude-code", "--user"], { env: { ...w.env, MEMMEM_SYNC_DELAY_MS: "0" }, cwd: w.wt, input: input("PreCompact", { transcript_path: CLAUDE_FIXTURE }) });
  assert.deepEqual([cp.code, cp.stdout, cp.stderr], [0, "", ""]);
  const end = run(["session-end", "--tool", "claude-code", "--user"], { env: { ...w.env, MEMMEM_SYNC_DELAY_MS: "0" }, cwd: w.wt, input: input("SessionEnd", { transcript_path: CLAUDE_FIXTURE }) });
  assert.deepEqual([end.code, end.stdout, end.stderr], [0, "", ""]);
  const log = path.join(w.env.MEMMEM_HOME, "acme", "logs", "sync.log");
  await waitFor(() => /\[checkpoint:PreCompact\] detached/.test(fs.readFileSync(log, "utf8")) && /\[session-end\] detached/.test(fs.readFileSync(log, "utf8")));
  await waitFor(() => lsTree(w.transcriptsBare, w.env).some((f) => f.includes(`/alice/claude-code/`) && f.endsWith(`_${sid}.json`)), { timeoutMs: 30_000 });
  assert.equal(w.wtStatus(), "");
  assert.ok(!fs.existsSync(path.join(w.wt, ".memmem")), "nothing created in the worktree");

  // setup inside the worktree: one line, nothing created; status and doctor name the main checkout.
  const su = run(["setup", "--project", "acme", "--memory-repo", w.memoryBare, "--transcripts-repo", w.transcriptsBare, "--member", "alice"], { env: w.env, cwd: w.wt });
  assert.equal(su.code, 0, su.stderr);
  assert.equal(su.stdout, `this worktree already uses the memmem setup of its main checkout ${real(w.proj)}; nothing to do here\n`);
  assert.ok(!fs.existsSync(path.join(w.wt, ".memmem")));
  const st = run(["status"], { env: w.env, cwd: w.wt });
  assert.match(st.stdout, new RegExp(`\nlinked git worktree ${reEscape(real(w.wt))}: using the main checkout ${reEscape(real(w.proj))}\n`));
  const doc = doctorChecks({ cwd: w.wt, runner: () => ({ ok: true, stdout: "" }), env: w.env }).find((c) => c.name === "worktree");
  assert.equal(doc.status, "info");
  assert.match(doc.detail, /is a linked git worktree; it uses the main checkout /);
});

test("shared mode in a linked worktree: the committed config, the member from the main checkout's local.json", async () => {
  const w = userWorld();
  assert.equal(w.setup("--shared", "--no-safety-net").code, 0);
  sh("git", ["add", "-A"], { cwd: w.proj, env: w.env });
  sh("git", ["commit", "--quiet", "-m", "memmem"], { cwd: w.proj, env: w.env });
  const wt = path.join(w.root, "wt");
  sh("git", ["worktree", "add", "--quiet", "-b", "wt", wt], { cwd: w.proj, env: w.env });
  assert.ok(fs.existsSync(path.join(wt, ".memmem", "config.json")) && !fs.existsSync(path.join(wt, ".memmem", "local.json")));
  const sid = "33333333-2222-4333-8444-555555555555";
  const s = run(["session-start", "--tool", "claude-code"], { env: w.env, cwd: wt, input: JSON.stringify({ session_id: sid, cwd: wt, hook_event_name: "SessionStart" }) });
  assert.match(JSON.parse(s.stdout).hookSpecificOutput.additionalContext, /^This project \(acme\)/);
  assert.equal(run(["session-start", "--tool", "claude-code", "--user"], { env: w.env, cwd: wt, input: "{}" }).stdout, "", "no double run");
  run(["session-end", "--tool", "claude-code"], { env: { ...w.env, MEMMEM_SYNC_DELAY_MS: "0" }, cwd: wt, input: JSON.stringify({ session_id: sid, transcript_path: CLAUDE_FIXTURE, cwd: wt, hook_event_name: "SessionEnd" }) });
  await waitFor(() => lsTree(w.transcriptsBare, w.env).some((f) => /\/alice\/claude-code\//.test(f) && f.endsWith(`_${sid}.json`)), { timeoutMs: 30_000 });
});

test("remember from a linked worktree under a read-only data folder: the worktree's outbox, hidden, uploaded once, then removed", { skip: process.getuid?.() === 0 && "root ignores file modes" }, () => {
  const w = worktreeWorld();
  const data = path.join(w.env.MEMMEM_HOME, "acme");
  const inbox = () => lsTree(w.transcriptsBare, w.env).filter((f) => f.startsWith("inbox/alice/"));
  fs.chmodSync(data, 0o555);
  try {
    const r = run(["remember", "Worktree note"], { env: w.env, cwd: w.wt });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.startsWith(`queued ${path.join(real(w.wt), ".memmem", "outbox")}`), r.stdout);
  } finally { fs.chmodSync(data, 0o755); }
  assert.ok(!fs.existsSync(path.join(w.proj, ".memmem", "outbox")), "not in the main checkout");
  assert.equal(w.wtStatus(), "", "hidden by the shared info/exclude");
  // uninstall from the main checkout keeps .memmem/ while a worktree holds a note.
  const u = run(["uninstall"], { env: w.env, cwd: w.proj });
  assert.equal(u.code, 0, u.stderr);
  assert.match(u.stdout, new RegExp(`queued note\\(s\\) are not uploaded yet \\(1 in ${reEscape(path.join(real(w.wt), ".memmem", "outbox"))}\\)`));
  assert.ok(fs.existsSync(path.join(w.proj, ".memmem", "config.json")));
  const sync = () => run(["sync", "--tool", "claude-code", "--transcript", CLAUDE_FIXTURE, "--session", "s-w", "--cwd", w.wt], { env: w.env, cwd: w.wt });
  assert.equal(sync().code, 0);
  assert.deepEqual(inbox().length, 1);
  assert.ok(!fs.existsSync(path.join(w.wt, ".memmem")), "the worktree's empty .memmem/ is removed");
  assert.ok(fs.existsSync(path.join(w.proj, ".memmem", "config.json")), "the main checkout's is not");
  sync();
  assert.equal(inbox().length, 1, "uploaded once");
  // Now uninstall goes through.
  const u2 = run(["uninstall"], { env: w.env, cwd: w.wt });
  assert.equal(u2.code, 0, u2.stderr);
  assert.match(u2.stdout, /is a linked worktree; removing the setup of its main checkout/);
  assert.ok(!fs.existsSync(path.join(w.proj, ".memmem")));
  assert.equal(status(w), "");
});


test("uninstall through a symlinked project path does not count the main checkout as its own linked worktree", () => {
  const w = worktreeWorld();
  const link = path.join(w.root, "alias");
  fs.symlinkSync(w.proj, link);
  fs.mkdirSync(path.join(w.proj, ".memmem", "outbox"));
  fs.writeFileSync(path.join(w.proj, ".memmem", "outbox", "2026-11-11-x.md"), "note\n");
  const u = run(["uninstall", "--dir", link], { env: w.env, cwd: w.root });
  assert.equal(u.code, 0, u.stderr);
  assert.match(u.stdout, new RegExp(`queued note\\(s\\) are not uploaded yet \\(1 in ${reEscape(path.join(link, ".memmem", "outbox"))}\\); `), "listed once, not again under its real path");
  fs.rmSync(path.join(w.proj, ".memmem", "outbox"), { recursive: true });
  const u2 = run(["uninstall", "--dir", link], { env: w.env, cwd: w.root });
  assert.equal(u2.code, 0, u2.stderr);
  assert.ok(!fs.existsSync(path.join(w.proj, ".memmem")));
  assert.equal(status(w), "");
});
