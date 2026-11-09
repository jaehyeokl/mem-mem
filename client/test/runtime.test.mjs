import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { syncSpawnArgs } from "../lib/hooks.mjs";
import { isCompiled, MEMMEM_BIN, selfCommand, selfInvocation, VERSION } from "../lib/runtime.mjs";
import { resolveOnPath, shellQuote, stripCredentials } from "../lib/util.mjs";
import { BIN, CLIENT_DIR, run, tmpDir } from "./helpers.mjs";

test("compiled detection: define flag or bun's embedded file system", () => {
  assert.equal(isCompiled({ moduleUrl: "file:///opt/c/lib/runtime.mjs", defined: false }), false);
  assert.equal(isCompiled({ moduleUrl: "file:///$bunfs/root/memmem-linux-x64", defined: false }), true);
  assert.equal(isCompiled({ moduleUrl: "file:///B:/~BUN/root/memmem.exe", defined: false }), true);
  assert.equal(isCompiled({ moduleUrl: "file:///x", defined: true }), true);
  assert.equal(isCompiled(), false, "tests run from source");
});

test("detached sync argv: binary re-runs itself, source runs node + script", () => {
  const job = { tool: "codex", cwd: "/w/acme", transcript: "/t/r.jsonl", session: "s1", delayMs: 100 };
  assert.deepEqual(syncSpawnArgs(job, selfInvocation({ compiled: true, execPath: "/home/a/.local/bin/memmem" })), {
    cmd: "/home/a/.local/bin/memmem", args: ["sync", "--tool", "codex", "--cwd", "/w/acme", "--delay-ms", "100", "--transcript", "/t/r.jsonl", "--session", "s1"],
  });
  assert.deepEqual(syncSpawnArgs({ ...job, transcript: "", session: "" }, selfInvocation({ compiled: false, execPath: "/usr/bin/node", script: "/c/bin/memmem.mjs" })), {
    cmd: "/usr/bin/node", args: ["/c/bin/memmem.mjs", "sync", "--tool", "codex", "--cwd", "/w/acme", "--delay-ms", "100"],
  });
  assert.equal(MEMMEM_BIN, BIN);
});

test("self command and quoting for hook command lines", () => {
  assert.equal(selfCommand({ compiled: true, execPath: "/home/a/.local/bin/memmem" }, "linux"), "/home/a/.local/bin/memmem");
  assert.equal(selfCommand({ compiled: false, execPath: "/usr/bin/node", script: "/my dir/memmem.mjs" }, "linux"), '/usr/bin/node "/my dir/memmem.mjs"');
  assert.equal(selfCommand({ compiled: true, execPath: "C:\\Users\\a b\\memmem.exe" }, "win32"), '"C:/Users/a b/memmem.exe"');
  assert.equal(shellQuote('/a/$x"y', "linux"), '"/a/\\$x\\"y"');
  assert.equal(stripCredentials("https://u:tok@github.com/o/r.git"), "https://github.com/o/r.git");
  assert.equal(stripCredentials("git@github.com:o/r.git"), "git@github.com:o/r.git");
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "memmem"), "#!/bin/sh\n", { mode: 0o644 });
  assert.equal(resolveOnPath("memmem", { env: { PATH: d } }), null, "not executable");
  fs.chmodSync(path.join(d, "memmem"), 0o755);
  assert.equal(resolveOnPath("memmem", { env: { PATH: `/nonexistent:${d}` } }), path.join(d, "memmem"));
});

test("--version prints the package version; embedded assets are up to date", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(CLIENT_DIR, "package.json"), "utf8"));
  assert.equal(VERSION, pkg.version);
  const r = run(["--version"]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `${pkg.version}\n`);
  const c = spawnSync(process.execPath, [path.join(CLIENT_DIR, "scripts", "embed-assets.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(c.status, 0, c.stderr);
  assert.match(run(["--help"]).stdout, /setup .*\n.*\n.*\n.*\n {2}init /);
});

test("<subcommand> --help / -h prints that subcommand's usage and exits 0 without running it", () => {
  const home = tmpDir();
  const env = { ...process.env, HOME: home, MEMMEM_HOME: path.join(home, "data") };
  for (const [args, re] of [
    [["setup", "--help"], /^usage: memmem setup --project <name>/],
    [["setup", "--hooks-only", "-h"], /^usage: memmem setup /],
    [["init", "--help"], /^usage: memmem init \[--depth/],
    [["status", "-h"], /^usage: memmem status /],
    [["doctor", "--help"], /^usage: memmem doctor/],
    [["uninstall", "--help"], /^usage: memmem uninstall/],
    [["remember", "--help"], /^usage: memmem remember/],
    [["session-start", "--help"], /^usage: memmem session-start/],
  ]) {
    const r = run(args, { env, cwd: home });
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stdout, re, args.join(" "));
    assert.equal(r.stderr, "", args.join(" "));
  }
  // Nothing was set up in the folder.
  assert.ok(!fs.existsSync(path.join(home, ".memmem")));
  assert.ok(!fs.existsSync(path.join(home, ".claude")));
});
