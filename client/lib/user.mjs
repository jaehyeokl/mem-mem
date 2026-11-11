// User mode: hooks and the memmem-init skill installed once per computer, at the
// user level (Claude Code settings, Codex hooks.json, ~/.agents/skills), so a
// project opts in only through its git-hidden .memmem/ folder. Used by `setup`
// (user mode), `install`, `uninstall --user`, `status`, and `doctor`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GUIDE_REMEMBER, USER_SKILLS } from "./assets.generated.mjs";
import { codexContextTokens, commandPaths, ourHookPositions, ourHooks, readJson, removeOurHooks, setOurHooks } from "./install.mjs";
import { selfInvocation } from "./runtime.mjs";
import { CONFIG_DIR, git, GUIDE_FILE, posixQuote, resolveOnPath, shellQuote } from "./util.mjs";

/** User-level locations: $CLAUDE_CONFIG_DIR or ~/.claude; $CODEX_HOME or ~/.codex; ~/.agents/skills. Injectable for tests. */
export function userPaths({ env = process.env, homedir } = {}) {
  const home = homedir || env.HOME || env.USERPROFILE || os.homedir();
  const claudeDir = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, ".claude");
  const codexDir = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, ".codex");
  return {
    home,
    claudeDir,
    claudeSettings: path.join(claudeDir, "settings.json"),
    claudeSkill: path.join(claudeDir, "skills", "memmem-init"),
    codexDir,
    codexHooks: path.join(codexDir, "hooks.json"),
    codexConfig: path.join(codexDir, "config.toml"),
    agentsSkill: path.join(home, ".agents", "skills", "memmem-init"),
  };
}

/** Which tools are on this computer: the config dir exists or the CLI is on PATH. */
export function toolsPresent(up, { env = process.env, platform = process.platform } = {}) {
  return {
    claude: fs.existsSync(up.claudeDir) || Boolean(resolveOnPath("claude", { env, platform })),
    codex: fs.existsSync(up.codexDir) || Boolean(resolveOnPath("codex", { env, platform })),
  };
}

/**
 * A user-level hook command. POSIX: `[ -x '<bin>' ] || exit 0; '<bin>' <sub> --tool <tool> --user`,
 * so a removed binary is a silent exit 0 in every project (from source, the node
 * binary and the script are both checked). Windows keeps the plain form (untested).
 */
export function userHookCommand(sub, tool, { invocation = selfInvocation(), platform = process.platform } = {}) {
  const argv = [invocation.cmd, ...invocation.args];
  const tail = `${sub} --tool ${tool} --user`;
  if (platform === "win32") return `${argv.map((p) => shellQuote(p, platform)).join(" ")} ${tail}`; // untested on Windows
  const q = argv.map(posixQuote);
  const guard = q.length > 1 ? `[ -x ${q[0]} ] && [ -f ${q[1]} ] || exit 0` : `[ -x ${q[0]} ] || exit 0`;
  return `${guard}; ${q.join(" ")} ${tail}`;
}

/** Claude Code user-level hooks. No PreCompact: Claude Code reports a completed PreCompact hook to the model in every project. */
export function userClaudeEntries(opts = {}) {
  const c = (sub) => userHookCommand(sub, "claude-code", opts);
  return {
    SessionStart: { hooks: [{ type: "command", command: c("session-start"), timeout: 20 }] },
    SessionEnd: { hooks: [{ type: "command", command: c("session-end") }] },
    Stop: { hooks: [{ type: "command", command: c("checkpoint"), timeout: 5 }] },
  };
}

// DO NOT CHANGE these definitions lightly: Codex stores a trust hash per hook
// definition and silently skips a new or changed hook in `codex exec` until the
// user reviews it interactively. Any change (a field, its order, a timeout)
// forces every user to review the memmem hooks again. Pinned by a snapshot test.
export function userCodexEntries({ contextTokens = 12_000, ...opts } = {}) {
  const c = (sub) => userHookCommand(sub, "codex", opts);
  return {
    SessionStart: { hooks: [{ type: "command", command: c("session-start"), timeout: 20, additionalContextLimit: contextTokens }] },
    SessionEnd: { hooks: [{ type: "command", command: c("session-end"), timeout: 3 }] },
    Stop: { hooks: [{ type: "command", command: c("checkpoint"), timeout: 5 }] },
    PreCompact: { hooks: [{ type: "command", command: c("checkpoint"), timeout: 10 }] },
  };
}

/** The indent and final newline of an existing JSON file, so a rewrite keeps its style. */
export function jsonStyle(text) {
  if (text === null || !text.trim()) return { indent: 2, newline: true };
  const m = text.match(/^[{[]\r?\n([ \t]+)\S/);
  return { indent: m ? m[1] : text.trim().includes("\n") ? 2 : 0, newline: text.endsWith("\n") };
}

/** Write `obj` in the file's own style; false when the text would not change. */
export function writeJsonStyled(file, obj) {
  const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  const st = jsonStyle(prev);
  const next = JSON.stringify(obj, null, st.indent) + (st.newline ? "\n" : "");
  if (prev === next) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return true;
}

// Stricter than the project-level check: a same-named skill always mentions "memmem".
const isOurSkillText = (t) => /memmem init --state/.test(t);

/** State of a user-level skill folder: ok | stale | missing | foreign. */
export function userSkillState(dir, key) {
  const files = USER_SKILLS[key].files;
  const main = path.join(dir, "SKILL.md");
  if (!fs.existsSync(main)) return "missing";
  if (!isOurSkillText(fs.readFileSync(main, "utf8"))) return "foreign";
  const same = Object.entries(files).every(([rel, text]) => { try { return fs.readFileSync(path.join(dir, rel), "utf8") === text; } catch { return false; } });
  return same ? "ok" : "stale";
}

function installSkillDir(dir, key) {
  const state = userSkillState(dir, key);
  if (state === "ok" || state === "foreign") return state === "ok" ? "unchanged" : "foreign";
  for (const [rel, text] of Object.entries(USER_SKILLS[key].files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (!fs.existsSync(f) || fs.readFileSync(f, "utf8") !== text) fs.writeFileSync(f, text);
  }
  return state === "missing" ? "installed" : "updated";
}

/**
 * True when config.toml defines hooks inline (a `hooks.<Event>` table, or keys
 * directly under `[hooks]`), not just `[hooks.state...]` trust records: Codex
 * then warns that it loads hooks from both files.
 */
export function hasInlineCodexHooks(toml) {
  let inHooks = false;
  for (const raw of String(toml || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const h = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?/);
    if (h) {
      const name = h[1];
      inHooks = name === "hooks";
      if (/^hooks\./.test(name) && !/^hooks\.state(\.|$)/.test(name)) return true;
      continue;
    }
    if (inHooks && !/^state\s*[=.]/.test(line)) return true;
    if (/^hooks\s*[=.]/.test(line) && !/^hooks\.state\b/.test(line)) return true;
  }
  return false;
}

/**
 * Install or refresh the user-level pieces for each tool on this computer:
 * hooks (Claude Code settings.json, Codex hooks.json) and the memmem-init skill.
 * Keeps everything else in those files. Returns { claude, codex } with
 * { present, hooks: installed|updated|unchanged, skill } per tool (null when skipped).
 */
export function installUser({ env = process.env, platform = process.platform, invocation = selfInvocation(), say = () => {}, homedir } = {}) {
  const up = userPaths({ env, homedir });
  const present = toolsPresent(up, { env, platform });
  const res = { claude: null, codex: null, paths: up };
  if (present.claude) {
    const cur = readJson(up.claudeSettings);
    const existed = fs.existsSync(up.claudeSettings);
    const changed = writeJsonStyled(up.claudeSettings, setOurHooks(cur, userClaudeEntries({ invocation, platform })));
    const hooks = !changed ? "unchanged" : existed && Object.keys(ourHooks(cur)).length ? "updated" : "installed";
    const skill = installSkillDir(up.claudeSkill, "claudeInit");
    say(`claude-code: user-level hooks ${hooks}: ${up.claudeSettings}`);
    say(skill === "foreign" ? `WARNING: ${up.claudeSkill} exists and is not ours; left untouched` : `claude-code: skill ${skill}: ${up.claudeSkill}`);
    res.claude = { hooks, skill };
  } else say(`claude-code: skipped (no ${up.claudeDir} and no \`claude\` on PATH)`);
  if (present.codex) {
    const cur = readJson(up.codexHooks);
    const existed = fs.existsSync(up.codexHooks);
    const changed = writeJsonStyled(up.codexHooks, setOurHooks(cur, userCodexEntries({ contextTokens: codexContextTokens(say, env), invocation, platform })));
    const hooks = !changed ? "unchanged" : existed && Object.keys(ourHooks(cur)).length ? "updated" : "installed";
    const skill = installSkillDir(up.agentsSkill, "agentsInit");
    say(`codex: user-level hooks ${hooks}: ${up.codexHooks}`);
    say(skill === "foreign" ? `WARNING: ${up.agentsSkill} exists and is not ours; left untouched` : `codex: skill ${skill}: ${up.agentsSkill}`);
    let toml = "";
    try { toml = fs.readFileSync(up.codexConfig, "utf8"); } catch { /* no config.toml */ }
    if (hasInlineCodexHooks(toml)) say(`note: ${up.codexConfig} also defines hooks inline; Codex warns that it loads hooks from both files. memmem uses ${up.codexHooks} only; move your inline hooks there to silence the warning.`);
    if (hooks !== "unchanged") say("codex: open Codex once and approve the memmem hooks on its review screen (once per computer; again only if the hook definitions change). Until then `codex exec` skips them silently.");
    res.codex = { hooks, skill };
  } else say(`codex: skipped (no ${up.codexDir} and no \`codex\` on PATH)`);
  if (!present.claude && !present.codex) say("note: neither Claude Code nor Codex was found; install one and run `memmem install`.");
  else if ([res.claude, res.codex].every((t) => !t || (t.hooks === "unchanged" && t.skill !== "installed" && t.skill !== "updated"))) say("user-level install unchanged");
  return res;
}

/** `memmem install`: install or refresh the user-level pieces only (no project). */
export function runInstall(args, { out = process.stdout, err = process.stderr, ...opts } = {}) {
  try { installUser({ ...opts, say: (s) => out.write(s + "\n") }); return 0; } catch (e) { err.write(`memmem install: ${e.message}; nothing changed in that file\n`); return 1; }
}

const snake = (event) => event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const tomlKey = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Codex trust-record keys of our handlers in hooks.json: `<abs hooks.json>:<event_snake>:<group>:<handler>`. */
export function codexTrustKeys(hooksFile, config) {
  const files = [path.resolve(hooksFile)];
  try { const real = fs.realpathSync(hooksFile); if (!files.includes(real)) files.push(real); } catch { /* gone */ }
  return ourHookPositions(config).flatMap((p) => files.map((f) => `${f}:${snake(p.event)}:${p.group}:${p.handler}`));
}

/**
 * Remove the `[hooks.state."<key>"]` tables for `keys` from config.toml text,
 * leaving every other byte alone. A table whose body is anything other than
 * `trusted_hash = "..."` lines (and blank lines) is not ours to judge: the text
 * is returned unchanged with `unsure` set. Returns { text, removed, unsure }.
 */
export function removeTrustRecords(text, keys) {
  const lines = String(text).split("\n");
  const want = new Set(keys.map((k) => `[hooks.state.${tomlKey(k)}]`));
  const drop = new Set();
  let removed = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!want.has(lines[i].replace(/\r$/, "").trim())) continue;
    let end = i + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
    let last = i;
    for (let j = i + 1; j < end; j++) {
      const l = lines[j].replace(/\r$/, "").trim();
      if (!l) continue;
      if (!/^trusted_hash\s*=\s*"[^"]*"$/.test(l)) return { text, removed: 0, unsure: true };
      last = j;
    }
    for (let j = i; j <= last; j++) drop.add(j);
    if (i > 0 && !lines[i - 1].replace(/\r$/, "").trim() && !drop.has(i - 1)) drop.add(i - 1);
    removed++;
  }
  if (!removed) return { text, removed: 0, unsure: false };
  return { text: lines.filter((_, i) => !drop.has(i)).join("\n"), removed, unsure: false };
}

/** Remove our hooks from a user-level JSON file; delete it when nothing else is left. Returns a message or null. */
function removeUserHooks(file) {
  if (!fs.existsSync(file)) return null;
  const cur = readJson(file);
  const next = removeOurHooks(cur);
  if (JSON.stringify(next) === JSON.stringify(cur)) return null;
  if (Object.keys(next).length === 0) { fs.rmSync(file); return `removed ${file} (only memmem hooks)`; }
  writeJsonStyled(file, next);
  return `removed memmem hooks from ${file}`;
}

/** Remove a skill folder of ours, then its parents up to `stop` while they are empty. */
function removeSkillDir(dir, stop, say) {
  const main = path.join(dir, "SKILL.md");
  if (!fs.existsSync(main)) return;
  if (!isOurSkillText(fs.readFileSync(main, "utf8"))) { say(`left ${dir} (not ours)`); return; }
  fs.rmSync(dir, { recursive: true, force: true });
  say(`removed ${dir}`);
  for (let d = path.dirname(dir); d.startsWith(stop) && d !== stop; d = path.dirname(d)) {
    try { fs.rmdirSync(d); } catch { break; }
  }
}

/**
 * `memmem uninstall --user`: remove our hooks from the user-level Claude Code
 * and Codex files, our user-level skills, and the Codex trust records of our
 * hooks (indices computed before the hooks are removed). Returns 0, or 1 when
 * a file could not be parsed (it is left untouched).
 */
export function uninstallUser({ env = process.env, say = () => {}, warn = () => {}, homedir } = {}) {
  const up = userPaths({ env, homedir });
  let rc = 0;
  try { const m = removeUserHooks(up.claudeSettings); if (m) say(m); } catch (e) { warn(`memmem uninstall: ${up.claudeSettings}: ${e.message}; left untouched`); rc = 1; }
  let keys = [];
  try {
    if (fs.existsSync(up.codexHooks)) keys = codexTrustKeys(up.codexHooks, readJson(up.codexHooks));
    const m = removeUserHooks(up.codexHooks);
    if (m) say(m);
  } catch (e) { warn(`memmem uninstall: ${up.codexHooks}: ${e.message}; left untouched`); rc = 1; keys = []; }
  if (keys.length && fs.existsSync(up.codexConfig)) {
    const cur = fs.readFileSync(up.codexConfig, "utf8");
    const r = removeTrustRecords(cur, keys);
    if (r.unsure) say(`note: ${up.codexConfig} has memmem hook trust records in a form memmem does not recognize; left untouched (they are harmless)`);
    else if (r.removed) { fs.writeFileSync(up.codexConfig, r.text); say(`removed ${r.removed} Codex trust record(s) of the memmem hooks from ${up.codexConfig}`); }
  }
  removeSkillDir(up.claudeSkill, up.claudeDir, say);
  removeSkillDir(up.agentsSkill, up.home, say);
  return rc;
}

/**
 * User-level install state for status/doctor: per tool { file, present,
 * events (ours found), missing, badPaths (paths in our commands that do not exist), skill }.
 */
export function userInstallState({ env = process.env, platform = process.platform, homedir } = {}) {
  const up = userPaths({ env, homedir });
  const present = toolsPresent(up, { env, platform });
  const one = (file, events, skillDir, key, isPresent) => {
    let ours = {};
    let error = null;
    try { ours = ourHooks(readJson(file)); } catch (e) { error = e.message; }
    const cmds = Object.values(ours).flat();
    const userCmds = cmds.filter((c) => / --user\b/.test(c));
    const badPaths = [...new Set(userCmds.flatMap(commandPaths))].filter((p) => !fs.existsSync(p));
    return { file, present: isPresent, error, events: events.filter((e) => ours[e]?.some((c) => / --user\b/.test(c))), missing: events.filter((e) => !ours[e]?.some((c) => / --user\b/.test(c))), badPaths, skill: userSkillState(skillDir, key), skillDir };
  };
  return {
    claude: one(up.claudeSettings, Object.keys(userClaudeEntries({ platform })), up.claudeSkill, "claudeInit", present.claude),
    codex: one(up.codexHooks, Object.keys(userCodexEntries({ platform })), up.agentsSkill, "agentsInit", present.codex),
  };
}

// ---- the project side of user mode: .memmem/guide/remember.md and info/exclude ----

/** Write `.memmem/guide/remember.md`. Returns installed | updated | unchanged. */
export function writeGuide(projectDir) {
  const file = path.join(projectDir, GUIDE_FILE);
  const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (cur === GUIDE_REMEMBER) return "unchanged";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, GUIDE_REMEMBER);
  return cur === null ? "installed" : "updated";
}

export const EXCLUDE_LINE = `${CONFIG_DIR}/`;

/** `<git common dir>/info/exclude` for `dir` (shared by every worktree), or null outside a work tree. */
export function excludeFile(dir) {
  const w = git(["rev-parse", "--is-inside-work-tree"], { cwd: dir });
  if (!w.ok || w.stdout !== "true") return null;
  const c = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir });
  return c.ok && c.stdout ? path.join(c.stdout, "info", "exclude") : null;
}

const ignored = (dir, rel) => git(["check-ignore", "-q", "--", rel], { cwd: dir }).status === 0;

/**
 * Hide `.memmem/` from git through info/exclude, unless git already ignores it.
 * Never touches .gitignore. Returns { added, file?, skipped? }.
 */
export function ensureExcluded(dir) {
  const file = excludeFile(dir);
  if (!file) return { added: false, skipped: "not a git repository" };
  if (ignored(dir, `${CONFIG_DIR}/config.json`) && ignored(dir, `${CONFIG_DIR}/local.json`)) return { added: false, file, skipped: "already ignored" };
  const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (cur.split(/\r?\n/).includes(EXCLUDE_LINE)) return { added: false, file, skipped: "already listed" };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}${EXCLUDE_LINE}\n`);
  return { added: true, file };
}

/** Remove the line ensureExcluded added (its last occurrence). Returns true when the file changed. */
export function removeExcluded(dir) {
  const file = excludeFile(dir);
  if (!file || !fs.existsSync(file)) return false;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const i = lines.lastIndexOf(EXCLUDE_LINE);
  if (i < 0) return false;
  lines.splice(i, 1);
  fs.writeFileSync(file, lines.join("\n"));
  return true;
}
