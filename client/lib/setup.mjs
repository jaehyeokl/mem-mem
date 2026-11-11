// `memmem setup`: write <project>/.memmem/config.json, clone both repos, register
// the member. Two modes:
//  - user (the default): user-level hooks and the memmem-init skill (user.mjs);
//    the project gets only .memmem/ (config, local.json with mode "user", the
//    remember guide), hidden through the repository's info/exclude. Nothing is
//    committed, so every teammate runs the same full command.
//  - shared (--shared, and every project that already has a committed
//    .memmem/config.json without a user-mode record): project-scoped hooks,
//    skills, the AGENTS.md snippet, the .gitignore lines, and the PATH safety
//    net, committed by the first member. A teammate's plain `memmem setup` only
//    records the member, clones, verifies, and writes the safety net.
import fs from "node:fs";
import path from "node:path";
import { ensureAgentsSnippet, hookFiles, installProjectHooks, installSkills, ourHooks, readJson, skillStatus, writeSafetyNet } from "./install.mjs";
import { createPrompter } from "./prompt.mjs";
import { selfCommand } from "./runtime.mjs";
import { ensureExcluded, installUser, writeGuide } from "./user.mjs";
import {
  commitAndPush, CONFIG_DIR, CONFIG_FILE, defaultRunner, ensureClone, findConfig, ghUser, git, githubIdOf, GUIDE_FILE, isGithubLogin, LANGUAGES, LAYOUT_VERSION, LOCAL_FILE,
  languageOf, modeOf, preparePull, projectPaths, readLocal, readProjectInfo, repoUrl, resolveOnPath, safeName, serverLanguageOf, withLock, writeLocal,
} from "./util.mjs";

export const USAGE = `usage: memmem setup --project <name> --memory-repo <org/repo|url|path> --transcripts-repo <org/repo|url|path> [--member <github-login>]
                    [--language en|ko] [--shared] [--hooks-only] [--no-gitignore] [--memory-dir <path>] [--yes] [--dir <project>] [--no-clone]
                    [--alias <old-handle>] [--no-email]
       memmem setup [--member <github-login>]      (shared mode, teammate: the project already has a committed .memmem/config.json)
Default (user mode): hooks and the memmem-init skill once per computer (user level); the project gets
only a git-hidden .memmem/ folder and nothing is committed, so every teammate runs the full command.
--shared: 0.1.0 behavior (project-level hooks, skills, AGENTS.md, .gitignore; the first member commits them).
--local: deprecated alias of the default.
The member handle is your GitHub login: --member > \`gh api user\` > a prompt.
The memory language comes from the transcripts repo's project.json (set on the server); --language overrides it.`;

export const SETUP_BOOLEANS = ["local", "shared", "hooksOnly", "noGitignore", "yes", "noClone", "noSafetyNet", "noEmail"];
const MEMBER_RULE = "member must be a GitHub login (letters, digits, single inner hyphens, at most 39 characters)";
export const GITIGNORE_LINES = [`${CONFIG_DIR}/*`, `!${CONFIG_DIR}/config.json`];
const CONFIG_FLAGS = ["project", "memoryRepo", "transcriptsRepo", "language", "memoryDir"];

/**
 * Make sure git ignores `.memmem/memory` but not `.memmem/config.json`, by
 * appending GITIGNORE_LINES to `<dir>/.gitignore`. Skipped outside a git work
 * tree. No edit when git already ignores `.memmem/memory` (any pattern) or the
 * lines are already there. Returns { edited, file?, skipped?, notes[] }.
 */
export function ensureGitignore(dir, { memoryDir } = {}) {
  const notes = [];
  if (!inWorkTree(dir)) return { edited: false, skipped: "not a git repository", notes };
  const file = path.join(dir, ".gitignore");
  let edited = false;
  if (!isIgnored(dir, `${CONFIG_DIR}/memory/x`)) edited = appendLines(file, GITIGNORE_LINES);
  if (isIgnored(dir, `${CONFIG_DIR}/config.json`)) {
    notes.push(`note: git ignores ${CONFIG_DIR}/config.json; add '!${CONFIG_DIR}/config.json' to .gitignore so teammates get it`);
  }
  // A --memory-dir clone elsewhere inside the project is not covered by .memmem/*.
  if (memoryDir) {
    const rel = path.relative(dir, memoryDir);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && !isIgnored(dir, `${rel.split(path.sep).join("/")}/x`)) {
      notes.push(`note: ${rel} is inside the project but not git-ignored; add it to .gitignore`);
    }
  }
  return { edited, file, notes };
}

/** Append `.claude/settings.local.json` to .gitignore unless git already ignores it (globally or locally). */
export function ensureLocalSettingsIgnored(dir) {
  const rel = ".claude/settings.local.json";
  if (!inWorkTree(dir) || isIgnored(dir, rel)) return false;
  return appendLines(path.join(dir, ".gitignore"), [rel]);
}

function inWorkTree(dir) {
  const r = git(["rev-parse", "--is-inside-work-tree"], { cwd: dir });
  return r.ok && r.stdout === "true";
}
function isIgnored(dir, rel) { return git(["check-ignore", "-q", "--", rel], { cwd: dir }).status === 0; }
function appendLines(file, lines) {
  const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const add = lines.filter((l) => !have.has(l));
  if (!add.length) return false;
  const sep = cur && !cur.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(file, `${cur}${sep}${add.join("\n")}\n`);
  return true;
}

function readExisting(dir) {
  const f = path.join(dir, CONFIG_FILE);
  if (!fs.existsSync(f)) return null;
  return { file: f, config: JSON.parse(fs.readFileSync(f, "utf8")) };
}

/** Default memory repo from the project's GitHub remote: <owner>/mem-<project>. */
function defaultMemoryRepo(dir, project) {
  const r = git(["remote", "get-url", "origin"], { cwd: dir });
  const m = r.ok && r.stdout.match(/github\.com[:/]([A-Za-z0-9_.-]+)\//);
  return m ? `${m[1]}/mem-${project}` : "";
}

/**
 * The member handle is the GitHub login: --member > `gh api user` > the handle
 * already in .memmem/local.json > a prompt (empty or malformed answers are
 * asked again, three times at most). git user.name and the OS user are never
 * used. Returns { member, gh } or { error } (member undefined when nothing was found).
 */
export async function resolveMember(dir, args, { prompter, runner = defaultRunner, say = () => {} } = {}) {
  if (args.member !== undefined) {
    if (!isGithubLogin(args.member)) return { error: MEMBER_RULE };
    const gh = ghUser({ runner });
    if (gh && gh.login !== args.member) say(`note: --member ${args.member} differs from your gh login ${gh.login}`);
    return { member: args.member, gh };
  }
  const gh = ghUser({ runner });
  if (gh) { say(`member ${gh.login} (GitHub login from gh)`); return { member: gh.login, gh }; }
  const cur = readLocal(dir).member;
  if (isGithubLogin(cur)) return { member: cur, gh: null };
  if (!prompter) return { member: undefined, gh: null };
  for (let i = 0; i < 3; i++) {
    const a = String(await prompter.ask("Your GitHub login (the member handle in transcript paths)", "")).trim();
    if (isGithubLogin(a)) return { member: a, gh: null };
    say(a ? `"${a}" is not a GitHub login` : "a GitHub login is required");
  }
  return { error: MEMBER_RULE };
}

/** Record the handle in .memmem/local.json; a different previous handle becomes an alias. */
function writeLocalMember(dir, member) {
  const prev = readLocal(dir).member;
  const changed = writeLocal(dir, { member });
  return { changed, previous: prev && prev !== member ? prev : null };
}

function gitConfig(dir, key) {
  const r = git(["config", key], { cwd: dir });
  return r.ok ? r.stdout : "";
}

/**
 * Pure: merge this machine's facts into members/<handle>.json. Same handle =
 * same person (GitHub logins are unique), so gitAuthors and aliases are unions;
 * joinedAt is kept; noEmail drops every email. githubId (the numeric GitHub
 * account id) is kept when present, else set from `githubId` when given.
 */
export function mergeMemberRecord(existing, { handle, displayName, author, aliases = [], githubId, noEmail = false, now = new Date() }) {
  const cur = existing && typeof existing === "object" ? existing : {};
  const authors = [...(Array.isArray(cur.gitAuthors) ? cur.gitAuthors : []), ...(author && (author.name || author.email) ? [author] : [])]
    .map((a) => {
      const o = {};
      if (a?.name) o.name = String(a.name);
      if (a?.email && !noEmail) o.email = String(a.email);
      return o;
    })
    .filter((a) => a.name || a.email);
  const seen = new Set();
  const gitAuthors = authors.filter((a) => { const k = `${a.name ?? ""}\0${a.email ?? ""}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const al = [...new Set([...(Array.isArray(cur.aliases) ? cur.aliases : []), ...aliases])].filter((a) => a && a !== handle);
  const gid = githubIdOf(cur.githubId) ?? githubIdOf(githubId);
  return {
    ...cur,
    handle,
    displayName: displayName || cur.displayName || handle,
    gitAuthors,
    joinedAt: cur.joinedAt || now.toISOString(),
    ...(gid !== null ? { githubId: gid } : {}),
    aliases: al,
  };
}

/**
 * Other members/*.json files registered with the same GitHub account id under
 * a different handle: the login was renamed, and those handles are aliases.
 * Files are never deleted (they are the author of past records).
 */
export function renamedHandles(membersDir, handle, githubId) {
  const id = githubIdOf(githubId);
  if (id === null) return [];
  let names = [];
  try { names = fs.readdirSync(membersDir).filter((n) => n.endsWith(".json")).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(membersDir, n), "utf8")); } catch { continue; }
    const h = typeof doc?.handle === "string" && doc.handle ? doc.handle : n.slice(0, -5);
    if (h !== handle && githubIdOf(doc?.githubId) === id && safeName(h, "") === h && !out.includes(h)) out.push(h);
  }
  return out;
}

/**
 * Write and push members/<handle>.json in the transcripts clone (no secrets).
 * Returns 0, or 1 when the push failed.
 */
function registerMember(config, dir, handle, { gh, args, previous, say, warn }) {
  const paths = projectPaths(config, dir);
  if (!fs.existsSync(path.join(paths.transcripts, ".git"))) { say(`members/${handle}.json: not written (no transcripts clone; run \`memmem setup\` without --no-clone)`); return 0; }
  if (args.alias !== undefined && (typeof args.alias !== "string" || safeName(args.alias, "") !== args.alias)) { warn("memmem setup: --alias must match [A-Za-z0-9._-]+"); return 2; }
  const aliases = [previous && safeName(previous, "") === previous ? previous : null, args.alias ?? null].filter(Boolean);
  return withLock(paths.lock, () => {
    preparePull(paths.transcripts, handle);
    const rel = path.posix.join("members", `${handle}.json`);
    const file = path.join(paths.transcripts, rel);
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* new member */ }
    const author = { name: gitConfig(dir, "user.name"), email: gitConfig(dir, "user.email") };
    // The account id only when gh is signed in as this handle (a hand-typed handle leaves it absent).
    const githubId = gh?.login === handle ? gh.id : undefined;
    const renamed = renamedHandles(path.join(paths.transcripts, "members"), handle, githubIdOf(existing?.githubId) ?? githubId);
    const known = new Set(Array.isArray(existing?.aliases) ? existing.aliases : []);
    for (const old of renamed) if (!known.has(old)) say(`previous handle ${old} (same GitHub account) kept as an alias`);
    const next = mergeMemberRecord(existing, { handle, displayName: gh?.login === handle ? gh.name : null, author, aliases: [...aliases, ...renamed], githubId, noEmail: Boolean(args.noEmail) });
    const text = JSON.stringify(next, null, 2) + "\n";
    if (existing && JSON.stringify(existing, null, 2) + "\n" === text) return 0;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    const res = commitAndPush(paths.transcripts, [rel], `member: ${handle}${existing ? " (update)" : ""}`, { member: handle });
    if (!res.ok) { warn(`memmem setup: ${rel} saved in ${paths.transcripts} but push failed: ${res.error}`); return 1; }
    say(`${existing ? "updated" : "registered"} ${rel} in the transcripts repo${next.aliases.length ? ` (aliases: ${next.aliases.join(", ")})` : ""}`);
    return 0;
  });
}

function cloneBoth(config, dir, say, warn) {
  const paths = projectPaths(config, dir);
  let rc = 0;
  for (const [label, spec, target] of [["memory", config.memoryRepo, paths.memory], ["transcripts", config.transcriptsRepo, paths.transcripts]]) {
    const r = ensureClone(repoUrl(spec), target);
    if (r.ok) say(`${label}: ${target}${r.cloned ? " (cloned)" : " (exists)"}`);
    else { warn(`${label}: clone of ${repoUrl(spec)} failed: ${r.error}`); rc = 1; }
  }
  return rc;
}

/** Shared mode: hooks + skills + snippet + safety net. Shared by full setup and --hooks-only. */
function installIntegrations(dir, args, { say, self }) {
  const h = installProjectHooks(dir, { bin: args.bin || "memmem", say });
  installSkills(dir, { say });
  ensureAgentsSnippet(dir, { say });
  if (!args.noSafetyNet) {
    writeSafetyNet(dir, self, { say });
    if (!args.noGitignore && ensureLocalSettingsIgnored(dir)) say(`added .claude/settings.local.json to ${path.join(dir, ".gitignore")}`);
  }
  return h;
}

function codexNotes(say, changed) {
  say(`codex: project hooks run only after you trust them${changed ? " (changed hooks need trusting again)" : ""}: open Codex in this folder and use /hooks.`);
  say("codex: initialize the team memory with $memmem-init; Claude Code: /memmem-init (or run `memmem init`).");
}

function pathNote(say, mode = "shared") {
  if (resolveOnPath("memmem")) return;
  if (mode === "user") say("note: `memmem` is not on PATH here; the hooks use its absolute path, but the remember guide and the memmem-init skill run `memmem` by name.");
  else say("note: `memmem` is not on PATH here; the shared hooks fail until it is, and the safety net in .claude/settings.local.json covers Claude Code meanwhile. Codex needs memmem on PATH.");
}

/** user | shared: --shared > --local (deprecated alias of user) > an existing config without a user-mode record (shared) > user. */
export function setupMode(args, existing, local) {
  if (args.shared) return "shared";
  if (args.local) return "user";
  if (existing && modeOf(local) !== "user") return "shared";
  return "user";
}

/** User mode, project side: local.json mode, the remember guide, info/exclude. */
function userProject(dir, { say, memoryDir }) {
  if (writeLocal(dir, { mode: "user" })) say(`mode user: ${path.join(dir, LOCAL_FILE)}`);
  const g = writeGuide(dir);
  say(`remember guide ${g}: ${path.join(dir, GUIDE_FILE)}`);
  const x = ensureExcluded(dir);
  if (x.added) {
    writeLocal(dir, { excluded: true });
    say(`added ${CONFIG_DIR}/ to ${x.file} (not committed; .gitignore untouched)`);
  } else if (x.skipped === "not a git repository") say(`note: ${dir} is not a git repository; nothing to hide ${CONFIG_DIR}/ from`);
  // A --memory-dir clone elsewhere inside the project is not covered by .memmem/.
  const rel = memoryDir ? path.relative(dir, memoryDir) : "";
  if (x.file && rel && !rel.startsWith("..") && !path.isAbsolute(rel) && !rel.startsWith(CONFIG_DIR + path.sep) && !isIgnored(dir, `${rel.split(path.sep).join("/")}/x`)) {
    say(`note: ${rel} is inside the project but not git-ignored; add it to ${x.file}`);
  }
}

function userNextSteps(say, u) {
  if (u.codex) say("next (once per computer): open Codex and approve the memmem hooks on its review screen; again only if the hook definitions ever change. Until then `codex exec` skips them.");
  say("next: initialize the team memory with /memmem-init (Claude Code) or $memmem-init (Codex), or `memmem init`.");
  say("nothing in this project is committed: every teammate runs the same `memmem setup --project ... --memory-repo ... --transcripts-repo ...` command.");
}

/** Teammate mode: record member, clone, verify, safety net. */
async function teammate(dir, existing, args, { say, warn, prompter, self, runner }) {
  const config = existing.config;
  const m = await resolveMember(dir, args, { prompter, runner, say });
  if (m.error) { warn(`memmem setup: ${m.error}`); return 2; }
  if (!m.member) { warn(`memmem setup: missing --member (your GitHub login; gh is not available or not signed in)\n${USAGE}`); return 2; }
  const lm = writeLocalMember(dir, m.member);
  if (lm.changed) say(`member ${m.member}: ${path.join(dir, LOCAL_FILE)} (not committed)${lm.previous ? `; previous handle ${lm.previous} kept as an alias` : ""}`);
  let rc = args.noClone ? 0 : cloneBoth(config, dir, say, warn);
  if (!args.noClone) rc = Math.max(rc, registerMember(config, dir, m.member, { gh: m.gh, args, previous: lm.previous, say, warn }));
  const serverLang = serverLanguageOf(readProjectInfo(projectPaths(config, dir).transcripts));
  if (serverLang && serverLang !== languageOf(config)) {
    say(`warning: memory language is ${serverLang} on the server; ${CONFIG_FILE} says ${languageOf(config)} (\`memmem setup --language ${serverLang}\` updates it; commit the file)`);
  }
  // Verify what the first member committed.
  const f = hookFiles(dir);
  const claudeOk = [f.claudeShared, f.claudeLocal].some((file) => { try { return Object.keys(ourHooks(readJson(file))).length >= 4; } catch { return false; } });
  let codexOk = false;
  try { codexOk = Object.keys(ourHooks(readJson(f.codex))).length >= 4; } catch { /* invalid */ }
  if (!claudeOk || !codexOk) say(`warning: memmem hooks missing in ${!claudeOk ? ".claude/settings.json" : ""}${!claudeOk && !codexOk ? " and " : ""}${!codexOk ? ".codex/hooks.json" : ""}; run \`memmem setup --hooks-only\` (and commit)`);
  const stale = skillStatus(dir).filter((s) => s.state !== "ok");
  if (stale.length) say(`warning: skills ${stale.map((s) => `${path.relative(dir, s.dest)} (${s.state})`).join(", ")}; \`memmem setup --hooks-only\` refreshes them`);
  if ((config.layoutVersion ?? 1) > LAYOUT_VERSION + 1) { warn(`memmem setup: this project uses layoutVersion ${config.layoutVersion}; update memmem`); rc = 1; }
  if (!args.noSafetyNet) {
    writeSafetyNet(dir, self, { say });
    if (!args.noGitignore && ensureLocalSettingsIgnored(dir)) say(`added .claude/settings.local.json to ${path.join(dir, ".gitignore")}`);
  }
  codexNotes(say, false);
  pathNote(say);
  return rc;
}

export async function runSetup(args, { out = process.stdout, err = process.stderr, prompter, self = selfCommand(), runner = defaultRunner, user = {} } = {}) {
  const say = (s) => out.write(s + "\n");
  const warn = (s) => err.write(s + "\n");
  const dir = path.resolve(args.dir || process.cwd());
  let existing;
  try { existing = readExisting(dir); } catch (e) { warn(`memmem setup: ${CONFIG_FILE} is not valid JSON: ${e.message}`); return 1; }
  // A linked worktree of a user-mode project already uses its main checkout's .memmem/: nothing to set up here.
  if (!existing) {
    let f = null;
    try { f = findConfig(dir); } catch { /* invalid config elsewhere: not this case */ }
    if (f?.checkout && modeOf(readLocal(f.dir)) === "user") { say(`this worktree already uses the memmem setup of its main checkout ${f.dir}; nothing to do here`); return 0; }
  }
  if (args.local && args.shared) { warn("memmem setup: --local and --shared cannot be combined"); return 2; }
  if (args.local) warn("memmem setup: --local is deprecated; user mode (the default) does the same: per-computer hooks, nothing committed in the project.");
  const mode = setupMode(args, existing, readLocal(dir));
  // `user`: options for installUser (tests inject env/invocation).
  const userInstall = () => installUser({ ...user, say });
  if (args.hooksOnly) {
    if (mode === "user" && (args.local || modeOf(readLocal(dir)) === "user")) {
      try { userInstall(); return 0; } catch (e) { warn(`memmem setup: ${e.message}`); return 1; }
    }
    try {
      const h = installIntegrations(dir, args, { say, self });
      codexNotes(say, h.codexChanged);
      pathNote(say);
      return 0;
    } catch (e) { warn(`memmem setup: ${e.message}`); return 1; }
  }
  const ownPrompter = prompter === undefined;
  prompter = ownPrompter ? createPrompter({ yes: args.yes }) : prompter;
  try {
    if (mode === "shared" && existing && !CONFIG_FLAGS.some((k) => args[k] !== undefined)) {
      return await teammate(dir, existing, args, { say, warn, prompter, self, runner });
    }
    return await full(dir, existing, args, { say, warn, prompter, self, runner, mode, userInstall });
  } catch (e) {
    warn(`memmem setup: ${e.message}`);
    return 1;
  } finally {
    if (ownPrompter) prompter?.close();
  }
}

async function full(dir, existing, args, { say, warn, prompter, self, runner, mode = "shared", userInstall }) {
  const prev = existing?.config || {};
  const pick = async (key, question, def) => {
    if (args[key] !== undefined) return args[key];
    if (prev[key] !== undefined) return prev[key];
    if (prompter) return prompter.ask(question, def);
    return args.yes && def ? def : undefined;
  };
  const project = await pick("project", "Project name", safeName(path.basename(dir), ""));
  const memoryRepo = await pick("memoryRepo", "Memory repo (org/repo, URL, or path)", project ? defaultMemoryRepo(dir, project) : "");
  const transcriptsRepo = await pick("transcriptsRepo", "Transcripts repo", memoryRepo ? `${String(memoryRepo).replace(/\.git$/, "")}-transcripts` : "");
  const m = await resolveMember(dir, args, { prompter, runner, say });
  if (m.error) { warn(`memmem setup: ${m.error}`); return 2; }
  const member = m.member;
  let config = { ...prev, project, memoryRepo, transcriptsRepo, layoutVersion: LAYOUT_VERSION };
  const missing = ["project", "memoryRepo", "transcriptsRepo"].filter((k) => typeof config[k] !== "string" || !config[k]);
  if (typeof member !== "string" || !member) missing.push("member");
  if (missing.length) { warn(`memmem setup: missing ${missing.join(", ")}\n${USAGE}`); return 2; }
  if (safeName(project) !== project) { warn("memmem setup: project must match [A-Za-z0-9._-]+"); return 2; }
  const badLanguage = () => { warn(`memmem setup: --language must be one of ${LANGUAGES.join(", ")}`); return 2; };
  if (args.language !== undefined && !LANGUAGES.includes(args.language)) return badLanguage();
  // The memory language is the server's (transcripts repo project.json): clone the transcripts repo first to read it.
  const doClone = !(args.clone === false || args.noClone);
  let serverLang = null;
  if (doClone) {
    const c = ensureClone(repoUrl(transcriptsRepo), projectPaths(config, dir).transcripts);
    if (c.ok) serverLang = serverLanguageOf(readProjectInfo(projectPaths(config, dir).transcripts, { fetch: !c.cloned }));
  }
  let language;
  if (args.language !== undefined) {
    language = args.language;
    if (serverLang && language !== serverLang) warn(`memmem setup: warning: --language ${language} differs from the project's memory language ${serverLang} (transcripts repo project.json); \`memmem doctor\` reports the mismatch`);
  } else if (serverLang) {
    language = serverLang;
    say(`language ${serverLang} (the project's memory language, from the transcripts repo's project.json)`);
    if (prev.language && prev.language !== serverLang) say(`note: ${CONFIG_FILE} said ${prev.language}; now ${serverLang}`);
  } else {
    language = await pick("language", "Language the team memory is written in (en|ko)", "en") ?? "en";
  }
  if (!LANGUAGES.includes(language)) return badLanguage();
  // User mode: the per-computer pieces first, so a project never has .memmem/ without working hooks.
  const u = mode === "user" ? userInstall() : null;
  config = { ...prev, project, memoryRepo, transcriptsRepo, language, layoutVersion: LAYOUT_VERSION };
  const memoryDir = args.memoryDir ?? prev.memoryDir;
  if (memoryDir !== undefined) {
    if (typeof memoryDir !== "string" || !memoryDir) { warn(`memmem setup: --memory-dir needs a path\n${USAGE}`); return 2; }
    config.memoryDir = memoryDir;
  }
  const file = path.join(dir, CONFIG_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  say(`wrote ${file}`);
  const lm = writeLocalMember(dir, member);
  if (lm.changed) say(`member ${member}: ${path.join(dir, LOCAL_FILE)} (not committed)${lm.previous ? `; previous handle ${lm.previous} kept as an alias` : ""}`);
  const paths = projectPaths(config, dir);
  if (mode === "user") userProject(dir, { say, memoryDir: config.memoryDir ? paths.memory : undefined });
  else if (modeOf(readLocal(dir)) === "user") writeLocal(dir, { mode: undefined, excluded: undefined });
  if (mode === "shared" && !args.noGitignore && args.gitignore !== false) {
    const g = ensureGitignore(dir, { memoryDir: config.memoryDir ? paths.memory : undefined });
    if (g.edited) say(`added ${GITIGNORE_LINES.join(" and ")} to ${g.file}`);
    for (const n of g.notes) say(n);
  }
  let rc = 0;
  if (doClone) {
    rc = cloneBoth(config, dir, say, warn);
    rc = Math.max(rc, registerMember(config, dir, member, { gh: m.gh, args, previous: lm.previous, say, warn }));
  }
  if (mode === "user") {
    userNextSteps(say, u);
    pathNote(say, "user");
    return rc;
  }
  const h = installIntegrations(dir, args, { say, self });
  const commit = [".memmem/config.json", ".gitignore", ".claude/settings.json", ".claude/skills", ".agents/skills", ".codex/hooks.json", "AGENTS.md"];
  say(`next: commit ${commit.join(" ")}; teammates then run \`memmem setup\` (member = their GitHub login)`);
  codexNotes(say, h.codexChanged);
  pathNote(say);
  return rc;
}
