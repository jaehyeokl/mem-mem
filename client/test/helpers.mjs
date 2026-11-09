import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const CLIENT_DIR = path.resolve(TEST_DIR, "..");
export const REPO_DIR = path.resolve(CLIENT_DIR, "..");
export const BIN = path.join(CLIENT_DIR, "bin", "memmem.mjs");
export const FIXTURES = path.join(TEST_DIR, "fixtures");
// MEMMEM_TEST_BIN=/abs/dist/memmem-<os>-<arch> runs the CLI tests against a compiled binary.
export const TEST_BIN = process.env.MEMMEM_TEST_BIN ? path.resolve(process.env.MEMMEM_TEST_BIN) : null;
/** The hook command prefix `setup` writes for the PATH safety net in this test run. */
export const SELF_CMD = TEST_BIN || `${process.execPath} ${BIN}`;
export const CLAUDE_FIXTURE = path.join(FIXTURES, "claude-code-session.jsonl");
export const CODEX_FIXTURE = path.join(FIXTURES, "codex-rollout.jsonl");

const created = [];
process.on("exit", () => { for (const d of created) fs.rmSync(d, { recursive: true, force: true }); });

export function tmpDir(prefix = "memmem-test-") {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(d);
  return d;
}

/** Isolated environment: fake HOME so nothing touches the real ~/.claude, ~/.codex, or the memmem data root. */
export function isolatedEnv(home, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("MEMMEM_") || k.startsWith("GIT_") || k === "CODEX_HOME" || k.startsWith("CLAUDE")) continue;
    if (k === "XDG_DATA_HOME" || k === "LOCALAPPDATA") continue; // data root must fall back to $HOME/.local/share/memmem
    if (k.startsWith("GH_") || k === "GITHUB_TOKEN") continue; // gh must not see the developer's GitHub account
    env[k] = v;
  }
  return {
    ...env,
    HOME: home,
    CODEX_HOME: path.join(home, ".codex"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
    ...extra,
  };
}

export function run(args, { env, cwd, input } = {}) {
  const [cmd, pre] = TEST_BIN ? [TEST_BIN, []] : [process.execPath, [BIN]];
  const r = spawnSync(cmd, [...pre, ...args], { env, cwd, input: input ?? "", encoding: "utf8", timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** Create a bare repo with branch main, seeded with the contents of `srcDir` (optional). */
export function makeBareRepo(bareDir, srcDir, env) {
  sh("git", ["init", "--quiet", "--bare", "-b", "main", bareDir], { env });
  if (!srcDir) return bareDir;
  const work = tmpDir("memmem-seed-");
  sh("git", ["init", "--quiet", "-b", "main", work], { env });
  fs.cpSync(srcDir, work, { recursive: true });
  sh("git", ["add", "-A"], { cwd: work, env });
  sh("git", ["commit", "--quiet", "-m", "seed"], { cwd: work, env });
  sh("git", ["push", "--quiet", bareDir, "main"], { cwd: work, env });
  fs.rmSync(work, { recursive: true, force: true });
  return bareDir;
}

export function lsTree(bareDir, env) {
  return sh("git", ["-c", "core.quotePath=false", "--git-dir", bareDir, "ls-tree", "-r", "--name-only", "main"], { env }).split("\n").filter(Boolean);
}

export function showFile(bareDir, rel, env) {
  return sh("git", ["--git-dir", bareDir, "show", `main:${rel}`], { env });
}

export async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 200 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Fake project folder with .memmem/config.json pointing at local bare repos, and the member in .memmem/local.json. */
export function makeProject(root, { memoryBare, transcriptsBare, project = "acme", member = "alice", extra = {} }) {
  const dir = path.join(root, "work", project);
  fs.mkdirSync(path.join(dir, ".memmem"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".memmem", "config.json"), JSON.stringify({ project, memoryRepo: memoryBare, transcriptsRepo: transcriptsBare, ...extra }, null, 2));
  fs.writeFileSync(path.join(dir, ".memmem", "local.json"), JSON.stringify({ member }, null, 2));
  return dir;
}

/** Per-project data dir under the default data root of an isolatedEnv. */
export function dataDir(env, project = "acme") {
  return path.join(env.HOME, ".local", "share", "memmem", project);
}
