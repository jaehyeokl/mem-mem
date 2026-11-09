// Thin git wrappers (execFile, no shell). Authentication is whatever the
// ambient git configuration provides (e.g. `gh auth setup-git`, a credential
// helper, or SSH keys). Errors are redacted before they are logged.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { redact } from "./log.js";

export class GitError extends Error {
  override name = "GitError";
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
    readonly code: number | string | null,
  ) {
    super(message);
  }
}

export interface GitOptions {
  cwd?: string;
  timeoutMs?: number;
}

/** Built per call: the CLI sets GIT_CONFIG_GLOBAL (server gitconfig) after modules load. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0", // never block on an interactive credential prompt
    GIT_ASKPASS: process.env.GIT_ASKPASS ?? "",
    LC_ALL: "C",
  };
}

const WORKER_IDENTITY = ["-c", "user.name=mem-mem worker", "-c", "user.email=memmem-server@localhost"];

export function git(args: string[], opts: GitOptions = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      args,
      { cwd: opts.cwd, env: gitEnv(), timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const shownArgs = args.map(redact).join(" ");
          const detail = redact(String(stderr || err.message).trim()).slice(0, 2000);
          const code = (err as NodeJS.ErrnoException & { code?: number | string }).code ?? null;
          reject(new GitError(`git ${shownArgs} failed: ${detail}`, args.map(redact), detail, code));
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

async function tryGit(args: string[], opts: GitOptions = {}): Promise<string | null> {
  try {
    return (await git(args, opts)).trim();
  } catch {
    return null;
  }
}

/** Default branch of `origin` as known by the clone ("main" when unknown). */
export async function originBranch(dir: string): Promise<string> {
  const ref = await tryGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: dir });
  if (ref && ref.startsWith("origin/")) return ref.slice("origin/".length);
  const ls = await tryGit(["ls-remote", "--symref", "origin", "HEAD"], { cwd: dir });
  const m = ls?.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
  return m?.[1] ?? "main";
}

/**
 * Clone the repo into `dir`, or bring an existing clone exactly to the
 * remote's default branch (fetch + hard reset). The worker never keeps local
 * commits between passes, so a hard reset is safe.
 */
export async function syncRepo(url: string, dir: string): Promise<{ head: string; branch: string }> {
  if (!existsSync(join(dir, ".git"))) {
    await mkdir(dirname(dir), { recursive: true });
    await git(["clone", "--quiet", "--no-tags", url, dir], { timeoutMs: 600_000 });
  } else {
    // Keep origin pointed at the configured URL (it may change in projects.json).
    await git(["remote", "set-url", "origin", url], { cwd: dir });
    await git(["fetch", "--quiet", "--prune", "--no-tags", "origin"], { cwd: dir, timeoutMs: 600_000 });
    await tryGit(["remote", "set-head", "origin", "--auto"], { cwd: dir });
  }
  const branch = await originBranch(dir);
  const hasRemoteBranch = await tryGit(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], { cwd: dir });
  if (!hasRemoteBranch) {
    throw new GitError(`remote has no branch '${branch}' (empty repository?)`, [], "", null);
  }
  await git(["checkout", "--quiet", "-B", branch, `refs/remotes/origin/${branch}`], { cwd: dir });
  await git(["reset", "--quiet", "--hard", `refs/remotes/origin/${branch}`], { cwd: dir });
  await git(["clean", "-fdq"], { cwd: dir });
  const head = (await git(["rev-parse", "HEAD"], { cwd: dir })).trim();
  return { head, branch };
}

export const INGEST_DIRS = ["trajectories", "inbox"] as const;

/** Paths the worker ingests: trajectories/**\/*.json and inbox/**\/*.md. */
export function isIngestPath(path: string): boolean {
  if (path.startsWith("trajectories/")) return path.endsWith(".json");
  if (path.startsWith("inbox/")) return path.endsWith(".md");
  return false;
}

function splitZ(out: string): string[] {
  return out.split("\0").filter((p) => p.length > 0);
}

export async function commitExists(dir: string, sha: string): Promise<boolean> {
  return (await tryGit(["cat-file", "-e", `${sha}^{commit}`], { cwd: dir })) !== null;
}

/** Files added or modified under trajectories/ and inbox/ between two commits. */
export async function changedIngestFiles(dir: string, from: string, to: string): Promise<string[]> {
  const out = await git(["diff", "--name-only", "--diff-filter=AM", "-z", from, to, "--", ...INGEST_DIRS], { cwd: dir });
  return splitZ(out).filter(isIngestPath).sort();
}

/** Every ingestable file at `rev` (used on first run or when the cursor is gone). */
export async function listIngestFiles(dir: string, rev = "HEAD"): Promise<string[]> {
  const out = await git(["ls-tree", "-r", "--name-only", "-z", rev, "--", ...INGEST_DIRS], { cwd: dir });
  return splitZ(out).filter(isIngestPath).sort();
}

/** Blob id of `path` at `rev`, or null when the path does not exist there. */
export async function blobId(dir: string, path: string, rev = "HEAD"): Promise<string | null> {
  return tryGit(["rev-parse", "--verify", "--quiet", `${rev}:${path}`], { cwd: dir });
}

/**
 * Append lines to `ingest/log.jsonl`, commit, and push to origin's default
 * branch. The caller syncs the clone first so this is a fast-forward push.
 */
export async function commitAndPushLog(
  dir: string,
  branch: string,
  lines: string[],
  message: string,
  logPath = "ingest/log.jsonl",
): Promise<string> {
  const abs = join(dir, logPath);
  await mkdir(dirname(abs), { recursive: true });
  await appendFile(abs, lines.map((l) => l.replace(/\n/g, " ")).join("\n") + "\n", "utf8");
  await git(["add", "--", logPath], { cwd: dir });
  await git([...WORKER_IDENTITY, "commit", "--quiet", "--no-verify", "-m", message], { cwd: dir });
  await git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], { cwd: dir, timeoutMs: 300_000 });
  return (await git(["rev-parse", "HEAD"], { cwd: dir })).trim();
}

export async function headOf(dir: string, ref = "HEAD"): Promise<string | null> {
  return tryGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: dir });
}

/**
 * Push the MemFS `main` branch to the memory repo. Letta's post-commit hook
 * does not fire for reflection merges (they are fast-forwards), so the worker
 * pushes explicitly. Never forces: a rejected push means the remote diverged
 * (e.g. a merged PR) and needs an operator.
 */
export async function pushMemory(memfsDir: string, memoryRepo: string): Promise<string> {
  const head = await headOf(memfsDir, "refs/heads/main");
  if (!head) throw new GitError(`MemFS has no main branch: ${memfsDir}`, [], "", null);
  await git(["push", "--quiet", memoryRepo, "refs/heads/main:refs/heads/main"], { cwd: memfsDir, timeoutMs: 300_000 });
  return head;
}

export function isNonFastForward(err: unknown): boolean {
  return err instanceof GitError && /non-fast-forward|fetch first|\[rejected\]/i.test(err.stderr);
}

/** Every file under bootstrap/ at `rev` (init requests, session copies, answers, status). */
export async function listBootstrapFiles(dir: string, rev = "HEAD"): Promise<string[]> {
  const out = await git(["ls-tree", "-r", "--name-only", "-z", rev, "--", "bootstrap"], { cwd: dir });
  return splitZ(out).sort();
}

/**
 * Sync the clone to the remote, let `mutate` write files (it returns the
 * repo-relative paths to stage), commit and push. A push rejected because the
 * remote moved (a client pushed meanwhile) is retried from a fresh sync, up to
 * `attempts` times. Returns the new head, or the synced head when nothing
 * changed.
 */
export async function commitFilesAndPush(
  url: string,
  dir: string,
  mutate: (dir: string) => Promise<string[]>,
  message: string,
  attempts = 3,
): Promise<string> {
  for (let i = 1; ; i++) {
    const { head, branch } = await syncRepo(url, dir);
    const paths = await mutate(dir);
    if (!paths.length) return head;
    await git(["add", "--", ...paths], { cwd: dir });
    const staged = await tryGit(["diff", "--cached", "--quiet"], { cwd: dir });
    if (staged !== null) return head; // exit 0: nothing staged
    await git([...WORKER_IDENTITY, "commit", "--quiet", "--no-verify", "-m", message], { cwd: dir });
    try {
      await git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], { cwd: dir, timeoutMs: 300_000 });
      return (await git(["rev-parse", "HEAD"], { cwd: dir })).trim();
    } catch (err) {
      if (i >= attempts || !isNonFastForward(err)) throw err;
    }
  }
}

/** `sha subject` of the commits in `from..to` (oldest first); every commit up to `to` when `from` is null. */
export async function commitsBetween(dir: string, from: string | null, to = "refs/heads/main"): Promise<{ sha: string; subject: string }[]> {
  const range = from ? `${from}..${to}` : to;
  const out = await tryGit(["log", "--reverse", "--format=%H%x09%s", range], { cwd: dir });
  if (!out) return [];
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const tab = l.indexOf("\t");
      return { sha: l.slice(0, tab), subject: l.slice(tab + 1) };
    });
}
