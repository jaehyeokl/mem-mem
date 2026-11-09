// Test helpers: temporary git repos seeded from templates/transcripts-repo.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const TEMPLATE = join(REPO_ROOT, "templates", "transcripts-repo");

const ID = ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false"];

export function sh(cwd, ...args) {
  return execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
}

export function tempDir(prefix = "memmem-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Bare repo (default branch main) seeded with the transcripts template; returns {bare, work}. */
export function seededTranscriptsRepo(root) {
  const bare = join(root, "transcripts.git");
  const work = join(root, "seed");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", bare]);
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", work]);
  cpSync(TEMPLATE, work, { recursive: true });
  sh(work, "add", "-A");
  sh(work, "commit", "--quiet", "-m", "init from template");
  sh(work, "remote", "add", "origin", bare);
  sh(work, "push", "--quiet", "origin", "main");
  return { bare, work };
}

export function writeAndPush(work, files, message = "add files") {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(work, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  sh(work, "add", "-A");
  sh(work, "commit", "--quiet", "-m", message);
  sh(work, "pull", "--quiet", "--rebase", "origin", "main");
  sh(work, "push", "--quiet", "origin", "main");
  return sh(work, "rev-parse", "HEAD");
}

/** A git repo standing in for a MemFS checkout (branch main, one commit). */
export function fakeMemfs(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", dir]);
  writeFileSync(join(dir, "MEMORY.md"), "# Memory\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "--quiet", "-m", "chore: initialize local memory");
  return sh(dir, "rev-parse", "HEAD");
}
