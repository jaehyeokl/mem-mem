import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { dataRoot, findConfig, projectPaths } from "../lib/util.mjs";
import { dataDir, isolatedEnv, makeBareRepo, makeProject, REPO_DIR, run, sh, tmpDir } from "./helpers.mjs";

const TEMPLATE = path.join(REPO_DIR, "templates", "memory-repo", "en");
const CFG = { project: "acme", memoryRepo: "o/m", transcriptsRepo: "o/t" };
const SETUP_CFG = { project: "acme", memoryRepo: "o/m", transcriptsRepo: "o/t", language: "en", layoutVersion: 1 };

function writeConfig(dir, config = CFG) {
  fs.mkdirSync(path.join(dir, ".memmem"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".memmem", "config.json"), JSON.stringify(config));
}

test("dataRoot: MEMMEM_HOME > XDG_DATA_HOME > Windows LOCALAPPDATA > ~/.local/share", () => {
  const home = "/home/alice";
  const d = (env, platform = "linux", homedir = home) => dataRoot({ env, platform, homedir });
  assert.equal(d({}), "/home/alice/.local/share/memmem");
  assert.equal(d({}, "darwin"), "/home/alice/.local/share/memmem");
  assert.equal(d({ XDG_DATA_HOME: "/xdg/data" }), "/xdg/data/memmem");
  assert.equal(d({ XDG_DATA_HOME: "relative/data" }), "/home/alice/.local/share/memmem", "relative XDG paths are ignored");
  assert.equal(d({ XDG_DATA_HOME: "" }), "/home/alice/.local/share/memmem");
  assert.equal(d({ MEMMEM_HOME: "/custom", XDG_DATA_HOME: "/xdg/data", LOCALAPPDATA: "C:\\L" }), "/custom");
  assert.equal(d({ MEMMEM_HOME: "C:\\custom" }, "win32", "C:\\Users\\alice"), "C:\\custom");
  assert.equal(d({ LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" }, "win32", "C:\\Users\\alice"), "C:\\Users\\alice\\AppData\\Local\\memmem");
  assert.equal(d({}, "win32", "C:\\Users\\alice"), "C:\\Users\\alice\\AppData\\Local\\memmem");
  assert.equal(d({ XDG_DATA_HOME: "D:\\xdg", LOCALAPPDATA: "C:\\L" }, "win32", "C:\\Users\\alice"), "D:\\xdg\\memmem");
  assert.equal(d({ LOCALAPPDATA: "C:\\L" }, "linux"), "/home/alice/.local/share/memmem", "LOCALAPPDATA only matters on Windows");
});

test("projectPaths: memory clone in the project, everything else under the data root", () => {
  const opts = { env: {}, platform: "linux", homedir: "/home/alice" };
  const p = projectPaths(CFG, "/work/app", opts);
  assert.equal(p.memory, "/work/app/.memmem/memory");
  assert.equal(p.root, "/home/alice/.local/share/memmem/acme");
  assert.equal(p.transcripts, "/home/alice/.local/share/memmem/acme/transcripts");
  assert.equal(p.logs, "/home/alice/.local/share/memmem/acme/logs");
  assert.equal(p.checkpoints, "/home/alice/.local/share/memmem/acme/checkpoints");
  assert.equal(p.lock, "/home/alice/.local/share/memmem/acme/transcripts.lock");
  assert.equal(projectPaths({ ...CFG, memoryDir: "vendor/mem" }, "/work/app", opts).memory, "/work/app/vendor/mem");
  assert.equal(projectPaths({ ...CFG, memoryDir: "/srv/mem-acme" }, "/work/app", opts).memory, "/srv/mem-acme");
  assert.equal(projectPaths(CFG, "/work/app", { ...opts, env: { MEMMEM_HOME: "/mm" } }).transcripts, "/mm/acme/transcripts");
});

test("findConfig: .memmem/config.json from a subfolder", () => {
  const root = tmpDir();
  const proj = path.join(root, "app");
  const sub = path.join(proj, "src", "deep");
  fs.mkdirSync(sub, { recursive: true });

  assert.equal(findConfig(sub), null);
  writeConfig(proj);
  const found = findConfig(sub);
  assert.equal(found.dir, proj);
  assert.equal(found.path, path.join(proj, ".memmem", "config.json"));
  assert.deepEqual(found.config, CFG);

  // A .memmem folder without config.json is not a project marker.
  const other = path.join(proj, "packages", "other");
  fs.mkdirSync(path.join(other, "x", ".memmem"), { recursive: true });
  assert.equal(findConfig(path.join(other, "x")).dir, proj, "falls through to the nearest real config");
});

function initEnv() {
  const root = tmpDir();
  const env = isolatedEnv(path.join(root, "home"));
  fs.mkdirSync(env.HOME);
  const proj = path.join(root, "app");
  fs.mkdirSync(proj);
  const init = (...extra) => run(["setup", "--project", "acme", "--memory-repo", "o/m", "--transcripts-repo", "o/t", "--member", "alice", "--no-clone", "--no-safety-net", ...extra], { env, cwd: proj });
  const gitignore = () => { try { return fs.readFileSync(path.join(proj, ".gitignore"), "utf8"); } catch { return null; } };
  return { root, env, proj, init, gitignore, git: (...a) => sh("git", a, { cwd: proj, env }) };
}

test("setup: .gitignore gets the two lines once, keeping existing content", () => {
  const t = initEnv();
  t.git("init", "--quiet", "-b", "main");
  fs.writeFileSync(path.join(t.proj, ".gitignore"), "node_modules/"); // no trailing newline
  const r1 = t.init();
  assert.equal(r1.code, 0, r1.stderr);
  assert.equal(t.gitignore(), "node_modules/\n.memmem/*\n!.memmem/config.json\n");
  const edits = r1.stdout.split("\n").filter((l) => l.includes(".gitignore") && !l.startsWith("next:"));
  assert.equal(edits.length, 1, r1.stdout);
  assert.match(edits[0], /^added \.memmem\/\* and !\.memmem\/config\.json to .*\.gitignore$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.proj, ".memmem", "config.json"), "utf8")), SETUP_CFG);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.proj, ".memmem", "local.json"), "utf8")), { member: "alice" });

  const r2 = t.init();
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(t.gitignore(), "node_modules/\n.memmem/*\n!.memmem/config.json\n", "idempotent");
  assert.ok(!/^added .*\.gitignore/m.test(r2.stdout), "no message when nothing changed");
  fs.mkdirSync(path.join(t.proj, ".memmem", "memory"));
  fs.writeFileSync(path.join(t.proj, ".memmem", "memory", "MEMORY.md"), "x\n");
  const status = t.git("status", "--porcelain", "-uall").split("\n");
  assert.ok(status.includes("?? .memmem/config.json") && status.includes("?? .gitignore"), status.join("\n"));
  assert.ok(!status.some((l) => l.includes(".memmem/memory") || l.includes(".memmem/local.json")), "clone and local.json are ignored");
});

test("setup: an existing pattern that already ignores the clone is respected", () => {
  for (const [pattern, warns] of [["/.memmem/memory/\n", false], [".memmem/\n", true], ["**/memory/\n", false]]) {
    const t = initEnv();
    t.git("init", "--quiet", "-b", "main");
    fs.writeFileSync(path.join(t.proj, ".gitignore"), pattern);
    const r = t.init();
    assert.equal(r.code, 0, r.stderr);
    assert.equal(t.gitignore(), pattern, `left ${JSON.stringify(pattern)} alone`);
    assert.equal(/git ignores \.memmem\/config\.json/.test(r.stdout), warns, r.stdout);
  }
  // A subfolder project of a repo whose root .gitignore already covers it.
  const t = initEnv();
  t.git("init", "--quiet", "-b", "main");
  fs.writeFileSync(path.join(t.proj, ".gitignore"), "sub/.memmem/memory/\n");
  const sub = path.join(t.proj, "sub");
  fs.mkdirSync(sub);
  const r = run(["setup", "--project", "acme", "--memory-repo", "o/m", "--transcripts-repo", "o/t", "--member", "alice", "--no-clone", "--no-safety-net", "--dir", sub], { env: t.env, cwd: t.proj });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(sub, ".gitignore")));
  assert.ok(fs.existsSync(path.join(sub, ".memmem", "config.json")));
});

test("setup: --no-gitignore and non-git folders leave .gitignore alone", () => {
  const a = initEnv();
  a.git("init", "--quiet", "-b", "main");
  const r1 = a.init("--no-gitignore");
  assert.equal(r1.code, 0, r1.stderr);
  assert.equal(a.gitignore(), null);
  assert.ok(fs.existsSync(path.join(a.proj, ".memmem", "config.json")));

  const b = initEnv(); // not a git repo (tmp dirs are outside any work tree)
  const r2 = b.init();
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(b.gitignore(), null);
  assert.ok(fs.existsSync(path.join(b.proj, ".memmem", "config.json")));
  assert.ok(!/^added .*\.gitignore/m.test(r2.stdout));
});

test("setup --memory-dir: stored as given, clone and intro use it", () => {
  const root = tmpDir();
  const env = isolatedEnv(path.join(root, "home"));
  fs.mkdirSync(env.HOME);
  const memoryBare = makeBareRepo(path.join(root, "memory.git"), TEMPLATE, env);
  const transcriptsBare = makeBareRepo(path.join(root, "transcripts.git"), null, env);
  const proj = path.join(root, "app");
  fs.mkdirSync(proj);
  sh("git", ["init", "--quiet", "-b", "main", proj], { env });
  const r = run(["setup", "--project", "acme", "--memory-repo", memoryBare, "--transcripts-repo", transcriptsBare, "--member", "alice", "--memory-dir", "vendor/team-memory"], { env, cwd: proj });
  assert.equal(r.code, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(proj, ".memmem", "config.json"), "utf8"));
  assert.equal(cfg.memoryDir, "vendor/team-memory");
  const clone = path.join(proj, "vendor", "team-memory");
  assert.ok(fs.existsSync(path.join(clone, "MEMORY.md")));
  assert.ok(!fs.existsSync(path.join(proj, ".memmem", "memory")));
  assert.match(r.stdout, /note: vendor\/team-memory is inside the project but not git-ignored/);
  assert.ok(fs.existsSync(path.join(dataDir(env), "transcripts")));

  const s = run(["session-start", "--tool", "codex"], { env, input: JSON.stringify({ session_id: "s", cwd: proj, hook_event_name: "SessionStart" }) });
  assert.equal(s.code, 0, s.stderr);
  assert.ok(s.stdout.split("\n")[0].includes(`\`${clone}\``), "intro names the --memory-dir clone");

  // Absolute override, via a hand-written config.
  const abs = path.join(root, "elsewhere", "mem");
  const proj2 = makeProject(root, { memoryBare, transcriptsBare, project: "acme2", extra: { memoryDir: abs } });
  const s2 = run(["session-start", "--tool", "codex"], { env, input: JSON.stringify({ session_id: "s", cwd: proj2 }) });
  assert.equal(s2.code, 0, s2.stderr);
  assert.ok(s2.stdout.includes(`\`${abs}\``));
  assert.ok(fs.existsSync(path.join(abs, "project.md")));
});

test("MEMMEM_HOME and XDG_DATA_HOME move the data side, not the memory clone", () => {
  const root = tmpDir();
  const base = isolatedEnv(path.join(root, "home"), { MEMMEM_SYNC_DELAY_MS: "60000" });
  fs.mkdirSync(base.HOME);
  const proj = makeProject(root, { memoryBare: path.join(root, "nope-m.git"), transcriptsBare: path.join(root, "nope-t.git") });
  const input = JSON.stringify({ session_id: "s-1", transcript_path: path.join(root, "s-1.jsonl"), cwd: proj, hook_event_name: "SessionEnd" });
  for (const [extra, expected] of [
    [{ XDG_DATA_HOME: path.join(root, "xdg") }, path.join(root, "xdg", "memmem", "acme")],
    [{ XDG_DATA_HOME: path.join(root, "xdg2"), MEMMEM_HOME: path.join(root, "mm") }, path.join(root, "mm", "acme")],
  ]) {
    const r = run(["session-end"], { env: { ...base, ...extra }, input });
    assert.equal(r.code, 0, r.stderr);
    assert.match(fs.readFileSync(path.join(expected, "logs", "sync.log"), "utf8"), /\[session-end\] detached sync pid=(\d+)/);
    const pid = Number(fs.readFileSync(path.join(expected, "logs", "sync.log"), "utf8").match(/pid=(\d+)/)[1]);
    try { process.kill(pid); } catch { /* already gone */ }
  }
  assert.ok(!fs.existsSync(path.join(base.HOME, ".local")));
});
