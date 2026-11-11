// Shared helpers: argument parsing, paths, config discovery, logging, git.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Project side (inside the project folder; the model reads the memory clone):
//   <project>/.memmem/config.json   committed by the team
//   <project>/.memmem/memory/       memory repo clone (git-ignored)
//   <project>/.memmem/local.json    per checkout: member, mode ("user" = user-level hooks)
// Data side (per user, per project; the model never needs it): see dataRoot().
export const CONFIG_DIR = ".memmem";
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const LOCAL_FILE = path.join(CONFIG_DIR, "local.json");
// GUIDE_FILE (user mode): how to save a note; the session-start context points here.
// OUTBOX_DIR: notes `memmem remember` could not commit because the data folder was
// read-only (a sandbox); `sync` and the next `remember` move them to the transcripts repo.
export const GUIDE_FILE = path.join(CONFIG_DIR, "guide", "remember.md");
export const OUTBOX_DIR = path.join(CONFIG_DIR, "outbox");
export const TOOLS = ["claude-code", "codex"];
// Repo layout version (config.json, trajectory meta, bootstrap/request.json).
// The client reads layouts LAYOUT_VERSION - 1 .. LAYOUT_VERSION + 1.
export const LAYOUT_VERSION = 1;
export const LANGUAGES = ["en", "ko"];

/** The transcripts repo's project facts, written by `memmem-server project add` / `project set-language`. */
export const PROJECT_FILE = "project.json";
export const LANGUAGE_NAMES = { en: "English", ko: "Korean" };

/**
 * The transcripts clone's project.json: the upstream copy (after `git fetch`
 * when `fetch`), else the working tree's; null without a clone or the file.
 */
export function readProjectInfo(transcriptsDir, { fetch = false, timeout = 15_000 } = {}) {
  if (!transcriptsDir || !fs.existsSync(path.join(transcriptsDir, ".git"))) return null;
  if (fetch) git(["fetch", "--quiet", "origin"], { cwd: transcriptsDir, timeout });
  const r = git(["show", `@{upstream}:${PROJECT_FILE}`], { cwd: transcriptsDir, timeout });
  let raw = r.ok ? r.stdout : null;
  if (raw === null) { try { raw = fs.readFileSync(path.join(transcriptsDir, PROJECT_FILE), "utf8"); } catch { return null; } }
  try { const d = JSON.parse(raw); return d && typeof d === "object" && !Array.isArray(d) ? d : null; } catch { return null; }
}

/** The project's memory language from project.json when valid, else null. */
export function serverLanguageOf(info) {
  return LANGUAGES.includes(info?.language) ? info.language : null;
}

/** `config.language` when valid, else "en". */
export function languageOf(config) {
  return LANGUAGES.includes(config?.language) ? config.language : "en";
}

/** Minimal flag parser: --key value, --key=value, --bool. Positional args go to `_`. */
export function parseArgs(argv, { booleans = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = (eq === -1 ? a.slice(2) : a.slice(2, eq)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (eq !== -1) out[key] = a.slice(eq + 1);
      else if (booleans.includes(key) || i + 1 >= argv.length || argv[i + 1].startsWith("--")) out[key] = true;
      else out[key] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

/**
 * Per-user data root (transcripts clone, logs, checkpoint state, lock):
 * $MEMMEM_HOME > $XDG_DATA_HOME/memmem (absolute paths only, per the XDG spec)
 * > %LOCALAPPDATA%\memmem on Windows > ~/.local/share/memmem.
 * `env`, `platform`, and `homedir` are injectable for tests.
 */
export function dataRoot({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  const P = platform === "win32" ? path.win32 : path.posix;
  if (env.MEMMEM_HOME) return env.MEMMEM_HOME;
  if (env.XDG_DATA_HOME && P.isAbsolute(env.XDG_DATA_HOME)) return P.join(env.XDG_DATA_HOME, "memmem");
  if (platform === "win32") return P.join(env.LOCALAPPDATA || P.join(homedir, "AppData", "Local"), "memmem");
  return P.join(homedir, ".local", "share", "memmem");
}

/** Path-safe slug for project/member/session names. */
export function safeName(s, fallback = "unknown") {
  const v = String(s ?? "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "");
  return v || fallback;
}

/**
 * Walk up from `start` to the nearest folder with `.memmem/config.json`, stopping
 * at the first folder that contains `.git` (file or directory: a repository or
 * worktree root) after checking it, so a nested unrelated repository never picks
 * up the enclosing project's config. Returns { path, dir, config }, or null.
 * Throws on invalid JSON (callers that must stay silent catch it).
 */
export function findConfig(start) {
  let dir = path.resolve(start || process.cwd());
  for (;;) {
    const p = path.join(dir, CONFIG_FILE);
    if (fs.existsSync(p)) {
      const config = JSON.parse(fs.readFileSync(p, "utf8"));
      return { path: p, dir, config };
    }
    if (fs.existsSync(path.join(dir, ".git"))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Mode of this checkout from .memmem/local.json: "user" (user-level hooks) or "shared" (absent; project-level hooks). */
export function modeOf(local) {
  return local?.mode === "user" ? "user" : "shared";
}

/** Per-user, git-ignored `<project>/.memmem/local.json` ({member}); {} when absent or invalid. */
export function readLocal(projectDir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(projectDir, LOCAL_FILE), "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
}

/** `<project>/.memmem/local.json` as an object ({} when absent); throws when it is unreadable or not a JSON object. */
export function readLocalStrict(projectDir) {
  const file = path.join(projectDir, LOCAL_FILE);
  if (!fs.existsSync(file)) return {};
  const v = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${file}: not a JSON object`);
  return v;
}

/** Member name: $MEMMEM_MEMBER > .memmem/local.json; "" when neither has one. */
export function memberOf(projectDir, env = process.env) {
  return env.MEMMEM_MEMBER || readLocal(projectDir).member || "";
}

/** Memory clone location: config.memoryDir (relative to the project folder, or absolute) or <project>/.memmem/memory. */
export function memoryDirOf(config, projectDir) {
  return config.memoryDir ? path.resolve(projectDir, config.memoryDir) : path.join(projectDir, CONFIG_DIR, "memory");
}

/**
 * Resolve per-project local paths. `projectDir` is the folder holding
 * `.memmem/`. Member can be overridden locally by MEMMEM_MEMBER.
 */
export function projectPaths(config, projectDir, opts) {
  const project = safeName(config.project);
  const root = path.join(dataRoot(opts), project);
  return {
    project,
    member: safeName(memberOf(projectDir)),
    projectDir,
    memory: memoryDirOf(config, projectDir),
    root,
    transcripts: path.join(root, "transcripts"),
    logs: path.join(root, "logs"),
    checkpoints: path.join(root, "checkpoints"),
    lock: path.join(root, "transcripts.lock"),
  };
}

/** "org/repo" shorthand -> GitHub HTTPS URL; anything else (URL, path) is used as-is. */
export function repoUrl(spec) {
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(spec) && !fs.existsSync(spec)) {
    return `https://github.com/${spec.replace(/\.git$/, "")}.git`;
  }
  return spec;
}

export function log(paths, scope, msg) {
  try {
    fs.mkdirSync(paths.logs, { recursive: true });
    fs.appendFileSync(path.join(paths.logs, "sync.log"), `${new Date().toISOString()} [${scope}] ${msg}\n`);
  } catch { /* logging must never break a hook */ }
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run git without ever prompting for credentials. */
export function git(args, { cwd, timeout = 60_000, identity } = {}) {
  const pre = identity ? ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`] : [];
  const r = spawnSync("git", [...pre, ...args], {
    cwd,
    timeout,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: process.env.GIT_ASKPASS || "" },
  });
  return {
    ok: r.status === 0 && !r.error,
    status: r.status,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim() || (r.error ? String(r.error.message) : ""),
  };
}

/** Clone `url` into `dir` unless it is already a git checkout. */
export function ensureClone(url, dir, { timeout = 120_000 } = {}) {
  if (fs.existsSync(path.join(dir, ".git"))) {
    const cur = git(["remote", "get-url", "origin"], { cwd: dir });
    if (cur.ok && cur.stdout !== url) git(["remote", "set-url", "origin", url], { cwd: dir });
    return { ok: true, cloned: false };
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = git(["clone", "--quiet", url, dir], { timeout });
  return { ok: r.ok, cloned: r.ok, error: r.stderr };
}

/** Strip user:password@ from an URL so credentials never end up in a pushed file. */
export function stripCredentials(url) {
  return String(url || "").replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, "$1");
}

/**
 * Absolute path of `cmd` on PATH (PATHEXT on Windows), or null. `env` and
 * `platform` are injectable for tests.
 */
export function resolveOnPath(cmd, { env = process.env, platform = process.platform } = {}) {
  const P = platform === "win32" ? path.win32 : path.posix;
  const exts = platform === "win32" ? ["", ...(env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean).map((e) => e.toLowerCase())] : [""];
  for (const d of (env.PATH || env.Path || "").split(platform === "win32" ? ";" : ":")) {
    if (!d) continue;
    for (const e of exts) {
      const f = P.join(d, cmd + e);
      try {
        const st = fs.statSync(f);
        if (!st.isFile()) continue;
        if (platform !== "win32") fs.accessSync(f, fs.constants.X_OK);
        return f;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

/** Single-quote `s` for a POSIX shell (always quoted, so the text is stable). */
export function posixQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/** Quote a path for a hook command line (run by sh/bash; Git Bash on Windows). */
export function shellQuote(p, platform = process.platform) {
  const v = platform === "win32" ? String(p).replace(/\\/g, "/") : String(p);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(v)) return v;
  return `"${v.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** Read the whole hook payload from stdin (empty object when stdin is a TTY or empty). */
export function readStdinJson() {
  if (process.stdin.isTTY) return {};
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch { return {}; }
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

/** Which CLI fired the hook: --tool flag > MEMMEM_TOOL env > payload heuristics > claude-code. */
export function detectTool(flag, payload = {}) {
  const norm = (t) => (t === "claude" ? "claude-code" : t);
  for (const t of [flag, process.env.MEMMEM_TOOL]) {
    if (typeof t === "string" && TOOLS.includes(norm(t))) return norm(t);
  }
  const tp = String(payload.transcript_path || "");
  if (/[\\/]\.codex[\\/]|rollout-[^\\/]*\.jsonl/.test(tp)) return "codex";
  if (/[\\/]\.claude[\\/]/.test(tp) || "permission_mode" in payload) return "claude-code";
  if (typeof payload.model === "string" && /^(gpt|o\d|codex)/i.test(payload.model)) return "codex";
  return "claude-code";
}

/** Simple cross-process lock using mkdir; stale locks (>10 min) are broken. */
export function withLock(lockDir, fn, { waitMs = 120_000 } = {}) {
  const start = Date.now();
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  for (;;) {
    try { fs.mkdirSync(lockDir); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > 10 * 60_000) { fs.rmSync(lockDir, { recursive: true, force: true }); continue; }
      } catch { continue; }
      if (Date.now() - start > waitMs) throw new Error(`lock busy: ${lockDir}`);
      sleepSync(250);
    }
  }
  try { return fn(); } finally { fs.rmSync(lockDir, { recursive: true, force: true }); }
}

/** GitHub login rules: 1-39 chars, alphanumerics and single inner hyphens. */
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
export const isGithubLogin = (s) => typeof s === "string" && GITHUB_LOGIN.test(s);

/**
 * Commit identity for transcripts-repo commits: `<handle> <handle@users.noreply.github.com>`
 * so GitHub attributes the commit to the member's account. Without a valid
 * handle: the user's own git identity, or a mem-mem placeholder when none is configured.
 */
export function commitIdentity(cwd, member) {
  // "unknown" is projectPaths' placeholder for "no member", not a GitHub account.
  if (isGithubLogin(member) && member !== "unknown") return { name: member, email: `${member}@users.noreply.github.com` };
  const email = git(["config", "user.email"], { cwd });
  if (email.ok && email.stdout) return undefined;
  const name = safeName(member, "memmem");
  return { name, email: `${name}@users.noreply.mem-mem` };
}

/** Run an external command without prompts. Injectable (doctor, setup) so tests need no network. */
export function defaultRunner(cmd, args, { timeout = 15_000, cwd } = {}) {
  const r = spawnSync(cmd, args, { cwd, timeout, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" } });
  return { ok: r.status === 0 && !r.error, status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() || (r.error ? String(r.error.message) : "") };
}

/** GitHub's numeric account id (a positive integer, or its digits as a string), else null. */
export function githubIdOf(v) {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * The signed-in GitHub user via `gh api user`: { login, name, id? } (id: the numeric account id) or null when gh
 * is not on PATH (checked only for the default runner), not signed in, or fails.
 */
export function ghUser({ runner = defaultRunner, env = process.env, platform = process.platform } = {}) {
  if (runner === defaultRunner && !resolveOnPath("gh", { env, platform })) return null;
  let r;
  try { r = runner("gh", ["api", "user", "--jq", "{login: .login, name: .name, id: .id}"], { timeout: 15_000 }); } catch { return null; }
  if (!r?.ok || !r.stdout) return null;
  try {
    const v = JSON.parse(r.stdout);
    if (!isGithubLogin(v?.login)) return null;
    const out = { login: v.login, name: typeof v.name === "string" && v.name.trim() ? v.name.trim() : null };
    const id = githubIdOf(v.id);
    if (id !== null) out.id = id;
    return out;
  } catch {
    const login = r.stdout.trim();
    return isGithubLogin(login) ? { login, name: null } : null;
  }
}

/** Merge `patch` into `<project>/.memmem/local.json` (per user, git-ignored). Returns true when the file changed. */
export function writeLocal(projectDir, patch) {
  const cur = readLocal(projectDir);
  const next = { ...cur, ...patch };
  if (JSON.stringify(next) === JSON.stringify(cur)) return false;
  const file = path.join(projectDir, LOCAL_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return true;
}

/**
 * Stage `relPaths`, commit if anything changed, then push with retries
 * (pull --rebase on reject). Also pushes commits left over from earlier failures.
 */
export function commitAndPush(repoDir, relPaths, message, { member, attempts = 4 } = {}) {
  const identity = commitIdentity(repoDir, member);
  const add = git(["add", "-A", "--", ...relPaths], { cwd: repoDir });
  if (!add.ok) return { ok: false, error: `git add: ${add.stderr}` };
  const staged = git(["diff", "--cached", "--quiet"], { cwd: repoDir });
  let committed = false;
  if (!staged.ok) {
    const c = git(["commit", "--quiet", "--no-verify", "-m", message], { cwd: repoDir, identity });
    if (!c.ok) return { ok: false, error: `git commit: ${c.stderr}` };
    committed = true;
  }
  const branch = git(["symbolic-ref", "--short", "HEAD"], { cwd: repoDir }).stdout || "main";
  let last = "";
  for (let i = 0; i < attempts; i++) {
    const p = git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], { cwd: repoDir, timeout: 60_000 });
    if (p.ok) return { ok: true, committed, pushed: true, attempts: i + 1 };
    last = p.stderr;
    git(["pull", "--quiet", "--rebase", "origin", branch], { cwd: repoDir, timeout: 60_000, identity });
    sleepSync(500 * (i + 1));
  }
  return { ok: false, committed, pushed: false, error: `git push: ${last}` };
}

/** Bring a clone up to date before writing (ignore failures, e.g. empty remote). */
export function preparePull(repoDir, member) {
  const branch = git(["symbolic-ref", "--short", "HEAD"], { cwd: repoDir }).stdout || "main";
  const identity = commitIdentity(repoDir, member || "memmem");
  return git(["pull", "--quiet", "--rebase", "--autostash", "origin", branch], { cwd: repoDir, timeout: 60_000, identity });
}
