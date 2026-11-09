import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { SKILLS } from "../lib/assets.generated.mjs";
import { fallbackShouldSkip } from "../lib/hooks.mjs";
import { claudeEntries, commandPaths, ensureAgentsSnippet, OURS, removeAgentsSnippet, SNIPPET_BEGIN, writeSafetyNet } from "../lib/install.mjs";
import { scriptedPrompter } from "../lib/prompt.mjs";
import { doctorChecks } from "../lib/doctor.mjs";
import { mergeMemberRecord, resolveMember, runSetup } from "../lib/setup.mjs";
import { isolatedEnv, lsTree, makeBareRepo, REPO_DIR, run, SELF_CMD, sh, showFile, tmpDir } from "./helpers.mjs";

const noGh = () => ({ ok: false, stderr: "gh: not logged in" });
const ghAs = (login, name = null, calls, id) => (cmd, args) => { calls?.push([cmd, ...args].join(" ")); return cmd === "gh" ? { ok: true, stdout: JSON.stringify({ login, name, ...(id !== undefined ? { id } : {}) }) } : noGh(); };
const sink = () => ({ s: "", write(x) { this.s += x; } });

const TEMPLATE = path.join(REPO_DIR, "templates", "memory-repo", "en");
const SELF = SELF_CMD;
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const commands = (file, event) => readJson(file).hooks[event].flatMap((g) => g.hooks.map((h) => h.command));

function world({ git = true } = {}) {
  const root = tmpDir();
  const env = isolatedEnv(path.join(root, "home"));
  fs.mkdirSync(env.HOME);
  const memoryBare = makeBareRepo(path.join(root, "mem.git"), TEMPLATE, env);
  const transcriptsBare = makeBareRepo(path.join(root, "tr.git"), path.join(REPO_DIR, "templates", "transcripts-repo"), env);
  const proj = path.join(root, "app");
  fs.mkdirSync(proj);
  if (git) sh("git", ["init", "--quiet", "-b", "main", proj], { env });
  const setup = (...a) => run(["setup", ...a], { env, cwd: proj });
  const full = (...a) => setup("--project", "acme", "--memory-repo", memoryBare, "--transcripts-repo", transcriptsBare, "--member", "alice", ...a);
  return { root, env, proj, memoryBare, transcriptsBare, setup, full };
}

test("setup (first member): config, local member, clones, hooks, skills, AGENTS.md, safety net; idempotent", () => {
  const w = world();
  const r = w.full("--language", "ko");
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.deepEqual(readJson(path.join(w.proj, ".memmem", "config.json")), { project: "acme", memoryRepo: w.memoryBare, transcriptsRepo: w.transcriptsBare, language: "ko", layoutVersion: 1 });
  assert.deepEqual(readJson(path.join(w.proj, ".memmem", "local.json")), { member: "alice" });
  assert.ok(fs.existsSync(path.join(w.proj, ".memmem", "memory", "MEMORY.md")));
  const shared = path.join(w.proj, ".claude", "settings.json");
  assert.deepEqual(commands(shared, "SessionStart"), ["memmem session-start --tool claude-code"]);
  assert.deepEqual(commands(path.join(w.proj, ".codex", "hooks.json"), "Stop"), ["memmem checkpoint --tool codex"]);
  // PATH safety net: same four hooks, absolute command, --fallback, in settings.local.json.
  const local = path.join(w.proj, ".claude", "settings.local.json");
  for (const [ev, sub] of [["SessionStart", "session-start"], ["SessionEnd", "session-end"], ["Stop", "checkpoint"], ["PreCompact", "checkpoint"]]) {
    assert.deepEqual(commands(local, ev), [`${SELF} ${sub} --tool claude-code --fallback`]);
  }
  for (const s of Object.values(SKILLS)) assert.equal(fs.readFileSync(path.join(w.proj, s.dest), "utf8"), s.text);
  const agents = fs.readFileSync(path.join(w.proj, "AGENTS.md"), "utf8");
  assert.ok(agents.startsWith(SNIPPET_BEGIN) && agents.includes("$memmem-init"));
  assert.match(r.stdout, /next: commit .*\.claude\/settings\.json/);
  assert.match(r.stdout, /\$memmem-init/);

  const snapshot = () => ["AGENTS.md", ".claude/settings.json", ".claude/settings.local.json", ".codex/hooks.json", ".gitignore", ".memmem/config.json"]
    .map((f) => fs.readFileSync(path.join(w.proj, f), "utf8")).join("\0");
  const before = snapshot();
  const again = w.full("--language", "ko");
  assert.equal(again.code, 0, again.stderr);
  assert.equal(snapshot(), before, "second run changes nothing");
  assert.match(again.stdout, /claude-code hooks unchanged/);
  assert.match(again.stdout, /AGENTS\.md snippet unchanged/);
});

test("setup (teammate): only member, clones, verification, safety net", () => {
  const w = world();
  assert.equal(w.full().code, 0);
  // Simulate a fresh clone of the project on Bob's machine.
  const bob = path.join(w.root, "bob");
  fs.cpSync(w.proj, bob, { recursive: true, filter: (src) => !/\.memmem[\\/](memory|local\.json)|settings\.local\.json/.test(src) });
  const cfg = fs.readFileSync(path.join(bob, ".memmem", "config.json"), "utf8");
  const shared = fs.readFileSync(path.join(bob, ".claude", "settings.json"), "utf8");
  const bobEnv = isolatedEnv(path.join(w.root, "bobhome"));
  fs.mkdirSync(bobEnv.HOME);
  const r = run(["setup", "--member", "bob"], { env: bobEnv, cwd: bob });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(fs.readFileSync(path.join(bob, ".memmem", "config.json"), "utf8"), cfg, "shared config untouched");
  assert.equal(fs.readFileSync(path.join(bob, ".claude", "settings.json"), "utf8"), shared, "shared hooks untouched");
  assert.deepEqual(readJson(path.join(bob, ".memmem", "local.json")), { member: "bob" });
  assert.ok(fs.existsSync(path.join(bob, ".memmem", "memory", "MEMORY.md")), "memory cloned");
  assert.ok(fs.existsSync(path.join(bobEnv.HOME, ".local", "share", "memmem", "acme", "transcripts", ".git")), "transcripts cloned");
  assert.match(commands(path.join(bob, ".claude", "settings.local.json"), "SessionStart")[0], / --fallback$/);
  assert.ok(!/warning/.test(r.stdout), r.stdout);

  // Missing member without a TTY: exit 2.
  fs.rmSync(path.join(bob, ".memmem", "local.json"));
  const m = run(["setup", "--no-clone"], { env: bobEnv, cwd: bob });
  assert.equal(m.code, 2);
  assert.match(m.stderr, /missing --member/);
  // Stale skill and missing codex hooks are reported.
  fs.writeFileSync(path.join(bob, ".claude", "skills", "remember", "SKILL.md"), "old memmem remember skill\n");
  fs.rmSync(path.join(bob, ".codex", "hooks.json"));
  const v = run(["setup", "--member", "bob", "--no-clone"], { env: bobEnv, cwd: bob });
  assert.equal(v.code, 0, v.stderr);
  assert.match(v.stdout, /warning: memmem hooks missing in \.codex\/hooks\.json/);
  assert.match(v.stdout, /\.claude\/skills\/remember\/SKILL\.md \(stale\)/);
});

test("setup --local: hooks with the absolute command in settings.local.json only", () => {
  const w = world();
  const r = w.full("--local", "--no-clone");
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(w.proj, ".claude", "settings.json")));
  const local = path.join(w.proj, ".claude", "settings.local.json");
  assert.deepEqual(commands(local, "SessionStart"), [`${SELF} session-start --tool claude-code`], "one set, no --fallback");
  assert.doesNotMatch(r.stdout, /next: commit .*\.claude\/settings\.json/);
});

test("setup --hooks-only (and its `install` alias) needs no config", () => {
  for (const args of [["setup", "--hooks-only"], ["install"]]) {
    const w = world();
    const r = run(args, { env: w.env, cwd: w.proj });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!fs.existsSync(path.join(w.proj, ".memmem")), "no config written");
    assert.ok(fs.existsSync(path.join(w.proj, ".claude", "settings.json")));
    assert.ok(fs.existsSync(path.join(w.proj, ".codex", "hooks.json")));
    assert.ok(fs.existsSync(path.join(w.proj, ".agents", "skills", "memmem-init", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(w.proj, ".claude", "settings.local.json")));
  }
});

test("setup: missing values and bad language without a TTY", () => {
  const w = world();
  const r = w.setup("--project", "acme", "--no-clone");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /missing memoryRepo, transcriptsRepo, member/);
  const l = w.full("--language", "fr", "--no-clone");
  assert.equal(l.code, 2);
  assert.match(l.stderr, /--language must be one of en, ko/);
  // --yes derives the transcripts repo from the memory repo and uses language en.
  const y = w.setup("--yes", "--memory-repo", "org/mem-acme", "--member", "alice", "--no-clone");
  assert.equal(y.code, 0, y.stderr);
  const cfg = readJson(path.join(w.proj, ".memmem", "config.json"));
  assert.deepEqual([cfg.project, cfg.transcriptsRepo, cfg.language], ["app", "org/mem-acme-transcripts", "en"]);
});

test("setup: interactive prompts fill what flags leave out", async () => {
  const w = world();
  // The GitHub login prompt rejects an empty answer and a malformed one, then accepts.
  const p = scriptedPrompter(["acme", w.memoryBare, "", "", "not a login!", "carol", "ko"]);
  const out = sink();
  const rc = await runSetup({ dir: w.proj, noClone: true }, { out, err: out, prompter: p, self: "/opt/memmem", runner: noGh });
  assert.equal(rc, 0, out.s);
  assert.equal(p.asked.length, 7);
  assert.equal(p.asked.filter((q) => /GitHub login/.test(q)).length, 3);
  assert.match(out.s, /a GitHub login is required/);
  assert.match(out.s, /"not a login!" is not a GitHub login/);
  const cfg = readJson(path.join(w.proj, ".memmem", "config.json"));
  assert.equal(cfg.transcriptsRepo, `${w.memoryBare.replace(/\.git$/, "")}-transcripts`, "default accepted with an empty answer");
  assert.equal(cfg.language, "ko");
  assert.deepEqual(readJson(path.join(w.proj, ".memmem", "local.json")), { member: "carol" });
  assert.match(commands(path.join(w.proj, ".claude", "settings.local.json"), "Stop")[0], /^\/opt\/memmem checkpoint --tool claude-code --fallback$/);
});

test("PATH safety net: writer keeps other settings; --fallback copies stand down when memmem is on PATH", () => {
  const dir = tmpDir();
  const file = path.join(dir, ".claude", "settings.local.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }));
  writeSafetyNet(dir, '"/Users/a b/bin/memmem"');
  writeSafetyNet(dir, '"/Users/a b/bin/memmem"');
  const s = readJson(file);
  assert.deepEqual(s.permissions, { allow: ["Bash(ls)"] });
  assert.deepEqual(s.hooks.Stop.map((g) => g.hooks[0].command), ["say done", '"/Users/a b/bin/memmem" checkpoint --tool claude-code --fallback']);
  assert.deepEqual(commandPaths(s.hooks.Stop[1].hooks[0].command), ["/Users/a b/bin/memmem"]);
  assert.deepEqual(commandPaths("/usr/bin/node /opt/c/bin/memmem.mjs session-start"), ["/usr/bin/node", "/opt/c/bin/memmem.mjs"]);

  const bin = path.join(dir, "pathbin");
  fs.mkdirSync(bin);
  assert.equal(fallbackShouldSkip({ fallback: true }, { env: { PATH: bin } }), false, "no memmem on PATH: fallback runs");
  fs.writeFileSync(path.join(bin, "memmem"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(fallbackShouldSkip({ fallback: true }, { env: { PATH: bin } }), true);
  assert.equal(fallbackShouldSkip({}, { env: { PATH: bin } }), false, "the shared hook always runs");
});

test("fallback hook: silent when memmem is on PATH, does the work otherwise", () => {
  const w = world();
  assert.equal(w.full().code, 0);
  const bin = path.join(w.root, "pathbin");
  fs.mkdirSync(bin);
  const input = JSON.stringify({ session_id: "s", cwd: w.proj, hook_event_name: "SessionStart" });
  const without = run(["session-start", "--tool", "claude-code", "--fallback"], { env: { ...w.env, PATH: `${bin}:${path.dirname(sh("sh", ["-c", "command -v git"]))}` }, input });
  assert.equal(without.code, 0, without.stderr);
  assert.match(JSON.parse(without.stdout).hookSpecificOutput.additionalContext, /^This project \(acme\)/);
  fs.writeFileSync(path.join(bin, "memmem"), "#!/bin/sh\n", { mode: 0o755 });
  const withIt = run(["session-start", "--tool", "claude-code", "--fallback"], { env: { ...w.env, PATH: `${bin}:${process.env.PATH}` }, input });
  assert.equal(withIt.code, 0);
  assert.equal(withIt.stdout, "");
});

test("OURS also matches release binary names and fallback commands", () => {
  for (const c of ['"/home/a/.local/bin/memmem" session-start --tool claude-code --fallback', "/tmp/dist/memmem-linux-x64 checkpoint", '"C:/Users/a/memmem.exe" session-end', ...Object.values(claudeEntries("memmem", { fallback: true })).map((g) => g.hooks[0].command)]) assert.match(c, OURS, c);
  for (const c of ["memmem-linux-x64 sync", "memmemx session-start", "memmem status"]) assert.doesNotMatch(c, OURS, c);
});

test("AGENTS.md snippet: append, idempotent, refresh an old block, remove", () => {
  const dir = tmpDir();
  const file = path.join(dir, "AGENTS.md");
  fs.writeFileSync(file, "# Rules\n\nBe nice.\n");
  assert.equal(ensureAgentsSnippet(dir), "added");
  assert.equal(ensureAgentsSnippet(dir), "unchanged");
  const cur = fs.readFileSync(file, "utf8");
  assert.ok(cur.startsWith("# Rules\n\nBe nice.\n\n" + SNIPPET_BEGIN));
  fs.writeFileSync(file, cur.replace("$memmem-init", "$old-name"));
  assert.equal(ensureAgentsSnippet(dir), "updated");
  assert.equal(fs.readFileSync(file, "utf8"), cur);
  assert.equal(removeAgentsSnippet(cur), "# Rules\n\nBe nice.\n\n");
  const other = tmpDir();
  fs.writeFileSync(path.join(other, "AGENTS.md"), "## Team memory (mem-mem)\nhand pasted\n");
  assert.equal(ensureAgentsSnippet(other), "present-unmarked");
});

test("uninstall: removes hooks (keeping foreign ones), skills, AGENTS block; --purge removes clones and config", () => {
  const w = world();
  fs.mkdirSync(path.join(w.proj, ".claude"));
  fs.writeFileSync(path.join(w.proj, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }));
  fs.writeFileSync(path.join(w.proj, "AGENTS.md"), "# Rules\n");
  assert.equal(w.full().code, 0);
  const u = run(["uninstall"], { env: w.env, cwd: w.proj });
  assert.equal(u.code, 0, u.stderr);
  assert.deepEqual(readJson(path.join(w.proj, ".claude", "settings.json")), { hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } });
  assert.ok(!fs.existsSync(path.join(w.proj, ".claude", "settings.local.json")), "file with only our hooks is removed");
  assert.ok(!fs.existsSync(path.join(w.proj, ".codex", "hooks.json")));
  for (const s of Object.values(SKILLS)) assert.ok(!fs.existsSync(path.join(w.proj, path.dirname(s.dest))), s.dest);
  assert.equal(fs.readFileSync(path.join(w.proj, "AGENTS.md"), "utf8").trim(), "# Rules");
  assert.ok(fs.existsSync(path.join(w.proj, ".memmem", "config.json")), "config kept");
  assert.ok(fs.existsSync(path.join(w.proj, ".memmem", "memory", ".git")), "clone kept");

  const k = run(["uninstall", "--purge", "--keep-config"], { env: w.env, cwd: w.proj });
  assert.equal(k.code, 0, k.stderr);
  assert.ok(fs.existsSync(path.join(w.proj, ".memmem", "config.json")));
  assert.ok(!fs.existsSync(path.join(w.proj, ".memmem", "memory")));
  assert.ok(!fs.existsSync(path.join(w.env.HOME, ".local", "share", "memmem", "acme")), "data dir removed (nothing unpushed)");
  const p = run(["uninstall", "--purge"], { env: w.env, cwd: w.proj });
  assert.equal(p.code, 0, p.stderr);
  assert.ok(!fs.existsSync(path.join(w.proj, ".memmem")));
});

test("member handle: --member > gh login > existing local handle > prompt; never git user.name", async () => {
  const dir = tmpDir();
  sh("git", ["init", "--quiet", "-b", "main", dir]);
  sh("git", ["config", "user.name", "Some Name"], { cwd: dir });
  const calls = [];
  assert.deepEqual(await resolveMember(dir, { member: "alice" }, { runner: ghAs("alice", "Alice A", calls) }), { member: "alice", gh: { login: "alice", name: "Alice A" } });
  assert.deepEqual(calls, ["gh api user --jq {login: .login, name: .name, id: .id}"]);
  assert.deepEqual(await resolveMember(dir, {}, { runner: ghAs("dave", null, null, 42) }), { member: "dave", gh: { login: "dave", name: null, id: 42 } });
  const said = [];
  assert.equal((await resolveMember(dir, { member: "alice" }, { runner: ghAs("other"), say: (x) => said.push(x) })).member, "alice");
  assert.match(said.join("\n"), /--member alice differs from your gh login other/);
  assert.deepEqual(await resolveMember(dir, {}, { runner: ghAs("dave", "Dave D") }), { member: "dave", gh: { login: "dave", name: "Dave D" } });
  for (const bad of ["bad_name", "-x", "x-", "a--b", "a".repeat(40), "with space"]) {
    assert.match((await resolveMember(dir, { member: bad }, { runner: noGh })).error, /GitHub login/, bad);
  }
  assert.equal((await resolveMember(dir, { member: "a".repeat(39) }, { runner: noGh })).member, "a".repeat(39));
  // No gh, no prompt: nothing (git user.name is not a default).
  assert.deepEqual(await resolveMember(dir, {}, { runner: noGh }), { member: undefined, gh: null });
  // Three rejected answers: error.
  const p = scriptedPrompter(["", "x_y", "-"]);
  assert.match((await resolveMember(dir, {}, { runner: noGh, prompter: p })).error, /GitHub login/);
  // An existing valid handle in local.json is kept without asking.
  fs.mkdirSync(path.join(dir, ".memmem"));
  fs.writeFileSync(path.join(dir, ".memmem", "local.json"), JSON.stringify({ member: "erin" }));
  assert.equal((await resolveMember(dir, {}, { runner: noGh, prompter: scriptedPrompter([]) })).member, "erin");
});

test("members/<handle>.json: merge is a union of git authors and aliases; joinedAt kept; --no-email drops emails", () => {
  const now = new Date("2026-11-06T00:00:00Z");
  const a = mergeMemberRecord(null, { handle: "dave", displayName: null, author: { name: "dave", email: "d@example.invalid" }, now });
  assert.deepEqual(a, { handle: "dave", displayName: "dave", gitAuthors: [{ name: "dave", email: "d@example.invalid" }], joinedAt: now.toISOString(), aliases: [] });
  const b = mergeMemberRecord(a, { handle: "dave", displayName: "Dave D", author: { name: "Dave D", email: "d@work.invalid" }, aliases: ["dave-old", "dave"], now: new Date() });
  assert.equal(b.joinedAt, now.toISOString());
  assert.equal(b.displayName, "Dave D");
  assert.deepEqual(b.gitAuthors, [{ name: "dave", email: "d@example.invalid" }, { name: "Dave D", email: "d@work.invalid" }]);
  assert.deepEqual(b.aliases, ["dave-old"]);
  assert.deepEqual(mergeMemberRecord(b, { handle: "dave", author: { name: "dave", email: "d@example.invalid" } }), b, "same machine again: unchanged");
  const c = mergeMemberRecord(b, { handle: "dave", author: { name: "dave", email: "x@y.invalid" }, noEmail: true });
  assert.deepEqual(c.gitAuthors, [{ name: "dave" }, { name: "Dave D" }]);
  assert.equal(mergeMemberRecord(b, { handle: "dave", author: { name: "", email: "" } }).gitAuthors.length, 2, "no git identity: nothing added");
});

test("setup registers members/<handle>.json (gh login, display name, git author) and a second machine merges into it", async () => {
  const w = world();
  // In-process runSetup: keep its data root (transcripts clone) inside the test dir.
  const prevHome = process.env.MEMMEM_HOME;
  process.env.MEMMEM_HOME = path.join(w.root, "data1");
  try {
  sh("git", ["config", "user.name", "dave"], { cwd: w.proj, env: w.env });
  sh("git", ["config", "user.email", "dave@example.invalid"], { cwd: w.proj, env: w.env });
  const out = sink();
  const rc = await runSetup({ dir: w.proj, project: "acme", memoryRepo: w.memoryBare, transcriptsRepo: w.transcriptsBare }, { out, err: out, prompter: null, self: "/opt/memmem", runner: ghAs("dave", "Dave D") });
  assert.equal(rc, 0, out.s);
  assert.match(out.s, /member dave \(GitHub login from gh\)/);
  assert.match(out.s, /registered members\/dave\.json/);
  assert.deepEqual(readJson(path.join(w.proj, ".memmem", "local.json")), { member: "dave" });
  const rec = JSON.parse(showFile(w.transcriptsBare, "members/dave.json", w.env));
  assert.equal(rec.handle, "dave");
  assert.equal(rec.displayName, "Dave D");
  assert.deepEqual(rec.gitAuthors, [{ name: "dave", email: "dave@example.invalid" }]);
  assert.deepEqual(rec.aliases, []);
  assert.equal(sh("git", ["--git-dir", w.transcriptsBare, "log", "-1", "--format=%an <%ae>", "main"], { env: w.env }), "dave <dave@users.noreply.github.com>");
  // Re-run: nothing new to commit.
  const head = sh("git", ["--git-dir", w.transcriptsBare, "rev-parse", "main"], { env: w.env });
  assert.equal(await runSetup({ dir: w.proj }, { out, err: out, prompter: null, self: "/opt/memmem", runner: ghAs("dave", "Dave D") }), 0, out.s);
  assert.equal(sh("git", ["--git-dir", w.transcriptsBare, "rev-parse", "main"], { env: w.env }), head);

  // Second machine (teammate mode), old local handle "dave-old", another git identity, --alias.
  const laptop = path.join(w.root, "laptop");
  fs.cpSync(w.proj, laptop, { recursive: true, filter: (src) => !/\.memmem[\\/](memory|local\.json)/.test(src) });
  fs.writeFileSync(path.join(laptop, ".memmem", "local.json"), JSON.stringify({ member: "dave-old" }));
  sh("git", ["config", "user.name", "Dave Laptop"], { cwd: laptop, env: w.env });
  sh("git", ["config", "user.email", "dave@laptop.invalid"], { cwd: laptop, env: w.env });
  process.env.MEMMEM_HOME = path.join(w.root, "data2");
  const o2 = sink();
  assert.equal(await runSetup({ dir: laptop, alias: "dk" }, { out: o2, err: o2, prompter: null, self: "/opt/memmem", runner: ghAs("dave", "Dave D") }), 0, o2.s);
  assert.match(o2.s, /previous handle dave-old kept as an alias/);
  assert.match(o2.s, /updated members\/dave\.json .*aliases: dave-old, dk/);
  const merged = JSON.parse(showFile(w.transcriptsBare, "members/dave.json", w.env));
  assert.equal(merged.joinedAt, rec.joinedAt);
  assert.deepEqual(merged.gitAuthors, [{ name: "dave", email: "dave@example.invalid" }, { name: "Dave Laptop", email: "dave@laptop.invalid" }]);
  assert.deepEqual(merged.aliases, ["dave-old", "dk"]);
  assert.ok(lsTree(w.transcriptsBare, w.env).includes("members/dave.json"));
  } finally { if (prevHome === undefined) delete process.env.MEMMEM_HOME; else process.env.MEMMEM_HOME = prevHome; }
});

test("setup CLI: gh on PATH supplies the handle; --no-email; a bad --member is rejected", () => {
  const w = world();
  const stub = path.join(w.root, "ghstub");
  fs.mkdirSync(stub);
  fs.writeFileSync(path.join(stub, "gh"), `#!/bin/sh\necho '{"login":"erin","name":null}'\n`, { mode: 0o755 });
  const env = { ...w.env, PATH: `${stub}:${process.env.PATH}` };
  sh("git", ["config", "user.name", "erin"], { cwd: w.proj, env });
  sh("git", ["config", "user.email", "erin@example.invalid"], { cwd: w.proj, env });
  const bad = run(["setup", "--project", "acme", "--memory-repo", w.memoryBare, "--transcripts-repo", w.transcriptsBare, "--member", "bad_name", "--no-clone"], { env, cwd: w.proj });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /member must be a GitHub login/);
  const r = run(["setup", "--project", "acme", "--memory-repo", w.memoryBare, "--transcripts-repo", w.transcriptsBare, "--no-email"], { env, cwd: w.proj });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.deepEqual(readJson(path.join(w.proj, ".memmem", "local.json")), { member: "erin" });
  const rec = JSON.parse(showFile(w.transcriptsBare, "members/erin.json", env));
  assert.deepEqual([rec.displayName, rec.gitAuthors], ["erin", [{ name: "erin" }]]);
});

test("setup records githubId from gh; a members file with the same githubId under another handle becomes an alias (kept)", async () => {
  const w = world();
  const prevHome = process.env.MEMMEM_HOME;
  process.env.MEMMEM_HOME = path.join(w.root, "data1");
  try {
    // An older registration under the OS user name, same GitHub account (id 42), and an unrelated member.
    const seed = path.join(w.root, "seed");
    sh("git", ["clone", "--quiet", w.transcriptsBare, seed], { env: w.env });
    fs.mkdirSync(path.join(seed, "members"), { recursive: true });
    fs.writeFileSync(path.join(seed, "members", "alice-old.json"), JSON.stringify({ handle: "alice-old", displayName: "alice-old", gitAuthors: [], joinedAt: "2026-11-01T00:00:00.000Z", githubId: 42, aliases: [] }));
    fs.writeFileSync(path.join(seed, "members", "minji.json"), JSON.stringify({ handle: "minji", gitAuthors: [], joinedAt: "2026-11-01T00:00:00.000Z", githubId: 7, aliases: [] }));
    sh("git", ["add", "-A"], { cwd: seed, env: w.env });
    sh("git", ["commit", "--quiet", "-m", "old members"], { cwd: seed, env: w.env });
    sh("git", ["push", "--quiet", "origin", "HEAD:main"], { cwd: seed, env: w.env });

    const out = sink();
    const rc = await runSetup({ dir: w.proj, project: "acme", memoryRepo: w.memoryBare, transcriptsRepo: w.transcriptsBare, member: "alice" }, { out, err: out, prompter: null, self: "/opt/memmem", runner: ghAs("alice", "J", null, 42) });
    assert.equal(rc, 0, out.s);
    assert.match(out.s, /previous handle alice-old \(same GitHub account\) kept as an alias/);
    assert.doesNotMatch(out.s, /previous handle minji/);
    const rec = JSON.parse(showFile(w.transcriptsBare, "members/alice.json", w.env));
    assert.equal(rec.githubId, 42);
    assert.deepEqual(rec.aliases, ["alice-old"]);
    assert.ok(lsTree(w.transcriptsBare, w.env).includes("members/alice-old.json"), "the old file is kept");
    // Again: nothing new, no message, no commit.
    const head = sh("git", ["--git-dir", w.transcriptsBare, "rev-parse", "main"], { env: w.env });
    const o2 = sink();
    assert.equal(await runSetup({ dir: w.proj }, { out: o2, err: o2, prompter: null, self: "/opt/memmem", runner: ghAs("alice", "J", null, 42) }), 0, o2.s);
    assert.doesNotMatch(o2.s, /same GitHub account/);
    assert.equal(sh("git", ["--git-dir", w.transcriptsBare, "rev-parse", "main"], { env: w.env }), head);
    // A hand-typed handle without gh leaves githubId absent (and finds no rename).
    const o3 = sink();
    assert.equal(await runSetup({ dir: w.proj, member: "erin" }, { out: o3, err: o3, prompter: null, self: "/opt/memmem", runner: noGh }), 0, o3.s);
    const erin = JSON.parse(showFile(w.transcriptsBare, "members/erin.json", w.env));
    assert.equal("githubId" in erin, false);
    // --member that differs from the gh login: gh's id is not recorded for it.
    const o4 = sink();
    assert.equal(await runSetup({ dir: w.proj, member: "other" }, { out: o4, err: o4, prompter: null, self: "/opt/memmem", runner: ghAs("alice", "J", null, 42) }), 0, o4.s);
    assert.equal("githubId" in JSON.parse(showFile(w.transcriptsBare, "members/other.json", w.env)), false);
  } finally { if (prevHome === undefined) delete process.env.MEMMEM_HOME; else process.env.MEMMEM_HOME = prevHome; }
});

/** Push `project.json` (as memmem-server project add / set-language writes it) to the transcripts repo. */
function pushProjectJson(w, language) {
  const work = tmpDir("memmem-pj-");
  sh("git", ["clone", "--quiet", w.transcriptsBare, work], { env: w.env });
  fs.writeFileSync(path.join(work, "project.json"), JSON.stringify({ project: "acme", language, layoutVersion: 1, createdAt: "2026-11-06T00:00:00Z" }, null, 2) + "\n");
  sh("git", ["add", "project.json"], { cwd: work, env: w.env });
  sh("git", ["commit", "--quiet", "-m", `memory language ${language}`], { cwd: work, env: w.env });
  sh("git", ["push", "--quiet", "origin", "main"], { cwd: work, env: w.env });
}

test("setup: memory language from the transcripts repo's project.json; --language overrides with a warning; doctor and teammates see the mismatch", () => {
  const w = world();
  pushProjectJson(w, "ko");
  const cfgFile = path.join(w.proj, ".memmem", "config.json");
  const r = w.full();
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(readJson(cfgFile).language, "ko", "no prompt, no flag: the server's language");
  assert.match(r.stdout, /language ko \(the project's memory language, from the transcripts repo's project\.json\)/);
  const doctor = () => doctorChecks({ cwd: w.proj, runner: () => ({ ok: true, stdout: "", stderr: "" }), env: w.env }).find((c) => c.name === "memory language");
  assert.equal(doctor().status, "ok");

  const o = w.full("--language", "en");
  assert.equal(o.code, 0, o.stderr);
  assert.match(o.stderr, /warning: --language en differs from the project's memory language ko/);
  assert.equal(readJson(cfgFile).language, "en");
  const d = doctor();
  assert.equal(d.status, "warn");
  assert.match(d.detail, /^memory language is ko on the server; local config says en/);

  // A teammate's clone of the project (config says en) is warned at setup.
  const bob = path.join(w.root, "bob");
  fs.cpSync(w.proj, bob, { recursive: true, filter: (src) => !/\.memmem[\\/](memory|local\.json)|settings\.local\.json/.test(src) });
  const bobEnv = isolatedEnv(path.join(w.root, "bobhome"));
  fs.mkdirSync(bobEnv.HOME);
  const t = run(["setup", "--member", "bob"], { env: bobEnv, cwd: bob });
  assert.equal(t.code, 0, t.stderr + t.stdout);
  assert.match(t.stdout, /warning: memory language is ko on the server; \.memmem\/config\.json says en/);

  // Back to the server's language: setup without --language picks it up again.
  const back = w.full();
  assert.equal(back.code, 0, back.stderr);
  assert.equal(readJson(cfgFile).language, "ko");
  assert.match(back.stdout, /note: \.memmem\/config\.json said en; now ko/);
  assert.equal(doctor().status, "ok");
});
