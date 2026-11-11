// Hook, skill, and AGENTS.md installation helpers shared by `setup`, `uninstall`,
// and `doctor` (project level, shared mode; the user level is in user.mjs).
import fs from "node:fs";
import path from "node:path";
import { AGENTS_SNIPPET as SNIPPET_TEXT, SKILLS } from "./assets.generated.mjs";

export const SNIPPET_BEGIN = "<!-- memmem:begin (managed by `memmem setup`; `memmem uninstall` removes it) -->";
export const SNIPPET_END = "<!-- memmem:end -->";
/** Our hook commands: `memmem`, `memmem.mjs`, `memmem-<os>-<arch>[.exe]`, quoted or not, then a hook subcommand. */
export const OURS = /memmem(?:-[A-Za-z0-9_-]+)?(?:\.mjs|\.exe)?["']?\s+(?:session-(?:start|end)|checkpoint)\b/;
export const HOOK_EVENTS = ["SessionStart", "SessionEnd", "Stop", "PreCompact"];

export function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw); // throws on invalid JSON: never clobber a file we cannot parse
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = JSON.stringify(obj, null, 2) + "\n";
  const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (prev === next) return false;
  fs.writeFileSync(file, next);
  return true;
}

const isOurs = (h) => Boolean(h && typeof h.command === "string" && OURS.test(h.command));

/** Drop our previous handlers from an event's matcher groups, keep everything else. */
function withoutOurs(groups) {
  if (!Array.isArray(groups)) return [];
  const out = [];
  for (const g of groups) {
    if (!g || !Array.isArray(g.hooks)) { out.push(g); continue; }
    const hooks = g.hooks.filter((h) => !isOurs(h));
    if (hooks.length) out.push({ ...g, hooks });
  }
  return out;
}

/** Merge `entries` ({Event: group}) into `config.hooks`. */
export function mergeHooks(config, entries) {
  const next = { ...config, hooks: { ...(config.hooks || {}) } };
  for (const [event, group] of Object.entries(entries)) {
    next.hooks[event] = [...withoutOurs(next.hooks[event]), group];
  }
  return next;
}

/** mergeHooks, and also drop our handlers from events not in `entries` (an event left empty is removed). */
export function setOurHooks(config, entries) {
  const next = mergeHooks(config, entries);
  for (const event of Object.keys(next.hooks)) {
    if (event in entries || !Array.isArray(next.hooks[event])) continue;
    const kept = withoutOurs(next.hooks[event]);
    if (kept.length) next.hooks[event] = kept; else delete next.hooks[event];
  }
  return next;
}

/** Remove every memmem handler; drop events (and `hooks`) that end up empty. */
export function removeOurHooks(config) {
  if (!config.hooks || typeof config.hooks !== "object") return config;
  const hooks = {};
  for (const [event, groups] of Object.entries(config.hooks)) {
    const kept = withoutOurs(groups);
    if (kept.length) hooks[event] = kept;
  }
  const next = { ...config };
  if (Object.keys(hooks).length) next.hooks = hooks; else delete next.hooks;
  return next;
}

/** Positions of our handlers: [{event, group, handler}] (indices into config.hooks[event] and its group's hooks). */
export function ourHookPositions(config) {
  const out = [];
  for (const [event, groups] of Object.entries(config?.hooks || {})) {
    (Array.isArray(groups) ? groups : []).forEach((g, gi) => {
      (Array.isArray(g?.hooks) ? g.hooks : []).forEach((h, hi) => { if (isOurs(h)) out.push({ event, group: gi, handler: hi }); });
    });
  }
  return out;
}

/** Our handlers per event in a settings/hooks object: {Event: [command, ...]}. */
export function ourHooks(config) {
  const out = {};
  for (const [event, groups] of Object.entries(config?.hooks || {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) if (isOurs(h)) (out[event] ||= []).push(h.command);
    }
  }
  return out;
}

export function claudeEntries(bin, { fallback = false } = {}) {
  const f = fallback ? " --fallback" : "";
  return {
    SessionStart: { hooks: [{ type: "command", command: `${bin} session-start --tool claude-code${f}`, timeout: 20 }] },
    SessionEnd: { hooks: [{ type: "command", command: `${bin} session-end --tool claude-code${f}` }] },
    Stop: { hooks: [{ type: "command", command: `${bin} checkpoint --tool claude-code${f}`, timeout: 5 }] },
    PreCompact: { hooks: [{ type: "command", command: `${bin} checkpoint --tool claude-code${f}`, timeout: 10 }] },
  };
}

// Codex caps SessionStart additional context at ~2,500 tokens by default and shows the
// model only a head-and-tail preview beyond that. `additionalContextLimit` raises the cap
// (0 = unlimited). 12000 tokens covers the 24,000-char default budget even for Korean text.
export const DEFAULT_CODEX_CONTEXT_TOKENS = 12_000;
export const CODEX_CONTEXT_TOKENS_ENV = "MEMMEM_CODEX_CONTEXT_TOKENS";

/** `MEMMEM_CODEX_CONTEXT_TOKENS` as a non-negative integer (0 = unlimited), or null when set but invalid. */
export function codexContextTokensFromEnv(env = process.env) {
  const raw = env[CODEX_CONTEXT_TOKENS_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_CODEX_CONTEXT_TOKENS;
  return /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
}

export function codexEntries(bin, { contextTokens = DEFAULT_CODEX_CONTEXT_TOKENS } = {}) {
  return {
    SessionStart: { hooks: [{ type: "command", command: `${bin} session-start --tool codex`, statusMessage: "Loading team memory", timeout: 20, additionalContextLimit: contextTokens }] },
    SessionEnd: { hooks: [{ type: "command", command: `${bin} session-end --tool codex`, timeout: 3 }] },
    Stop: { hooks: [{ type: "command", command: `${bin} checkpoint --tool codex`, timeout: 5 }] },
    PreCompact: { hooks: [{ type: "command", command: `${bin} checkpoint --tool codex`, timeout: 10 }] },
  };
}

export function codexContextTokens(say, env = process.env) {
  const t = codexContextTokensFromEnv(env);
  if (t !== null) return t;
  say(`WARNING: ${CODEX_CONTEXT_TOKENS_ENV} must be a non-negative integer (0 = unlimited); using ${DEFAULT_CODEX_CONTEXT_TOKENS}.`);
  return DEFAULT_CODEX_CONTEXT_TOKENS;
}

/** Project-scoped hook files. */
export function hookFiles(projectDir) {
  return {
    claudeShared: path.join(projectDir, ".claude", "settings.json"),
    claudeLocal: path.join(projectDir, ".claude", "settings.local.json"),
    codex: path.join(projectDir, ".codex", "hooks.json"),
  };
}

/**
 * Shared mode: write the four hooks for Claude Code (`.claude/settings.json`) and
 * Codex (`.codex/hooks.json`). Returns { claudeFile, codexFile, codexChanged }.
 */
export function installProjectHooks(projectDir, { bin = "memmem", say = () => {} } = {}) {
  const f = hookFiles(projectDir);
  const claudeFile = f.claudeShared;
  const c = writeJson(claudeFile, mergeHooks(readJson(claudeFile), claudeEntries(bin)));
  say(`claude-code hooks ${c ? "updated" : "unchanged"}: ${claudeFile}`);
  const x = writeJson(f.codex, mergeHooks(readJson(f.codex), codexEntries(bin, { contextTokens: codexContextTokens(say) })));
  say(`codex hooks ${x ? "updated" : "unchanged"}: ${f.codex}`);
  return { claudeFile, codexFile: f.codex, codexChanged: x };
}

/**
 * PATH safety net: the same four Claude Code hooks with an absolute command and
 * `--fallback` in `.claude/settings.local.json` (see hooks.mjs
 * fallbackShouldSkip). Codex is skipped: it reads hooks only from
 * `.codex/hooks.json` / `config.toml` per layer and has no local override file.
 */
export function writeSafetyNet(projectDir, command, { say = () => {} } = {}) {
  const file = hookFiles(projectDir).claudeLocal;
  const changed = writeJson(file, mergeHooks(readJson(file), claudeEntries(command, { fallback: true })));
  say(`PATH safety net ${changed ? "written" : "unchanged"}: ${file} (${command})`);
  return { file, changed };
}

/**
 * Split a hook command into its executable (and script, for `node x.mjs`) paths.
 * A user-level command's `[ -x '<bin>' ] || exit 0; ` guard is skipped.
 */
export function commandPaths(command) {
  command = String(command).replace(/^\[ -x .*?\|\| exit 0;\s*/, "");
  const toks = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(command))) toks.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3]));
  const out = [toks[0]];
  if (toks[1] && /\.m?js$/.test(toks[1])) out.push(toks[1]);
  return out.filter(Boolean);
}

const isOurSkill = (text) => /memmem/.test(text);

/** Install the embedded skills into the project. Returns [{dest, state: installed|updated|unchanged|foreign}]. */
export function installSkills(projectDir, { say = () => {}, keys = Object.keys(SKILLS) } = {}) {
  const res = [];
  for (const key of keys) {
    const { dest: rel, text } = SKILLS[key];
    const dest = path.join(projectDir, rel);
    let state = "installed";
    if (fs.existsSync(dest)) {
      const cur = fs.readFileSync(dest, "utf8");
      if (cur === text) state = "unchanged";
      else if (!isOurSkill(cur)) state = "foreign";
      else state = "updated";
    }
    if (state === "installed" || state === "updated") {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, text);
    }
    say(state === "foreign" ? `WARNING: ${dest} exists and is not ours; left untouched` : `skill ${state}: ${dest}`);
    res.push({ key, dest, state });
  }
  return res;
}

/** Skill state without writing: ok | stale | missing | foreign. */
export function skillStatus(projectDir) {
  return Object.entries(SKILLS).map(([key, { dest: rel, text }]) => {
    const dest = path.join(projectDir, rel);
    if (!fs.existsSync(dest)) return { key, dest, state: "missing" };
    const cur = fs.readFileSync(dest, "utf8");
    return { key, dest, state: cur === text ? "ok" : isOurSkill(cur) ? "stale" : "foreign" };
  });
}

export function snippetBlock() {
  return `${SNIPPET_BEGIN}\n${SNIPPET_TEXT.trimEnd()}\n${SNIPPET_END}\n`;
}

const blockRe = () => new RegExp(`${escapeRe(SNIPPET_BEGIN)}[\\s\\S]*?${escapeRe(SNIPPET_END)}\\n?`);
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * Append the managed snippet block to `<project>/AGENTS.md`, or refresh an
 * existing block. A hand-pasted (unmarked) copy counts as present.
 * Returns "added" | "updated" | "unchanged" | "present-unmarked".
 */
export function ensureAgentsSnippet(projectDir, { say = () => {} } = {}) {
  const file = path.join(projectDir, "AGENTS.md");
  const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const block = snippetBlock();
  let next, state;
  if (blockRe().test(cur)) {
    next = cur.replace(blockRe(), block);
    state = next === cur ? "unchanged" : "updated";
  } else if (cur.includes("## Team memory (mem-mem)")) {
    state = "present-unmarked";
    next = cur;
  } else {
    const sep = !cur ? "" : cur.endsWith("\n\n") ? "" : cur.endsWith("\n") ? "\n" : "\n\n";
    next = `${cur}${sep}${block}`;
    state = "added";
  }
  if (next !== cur) fs.writeFileSync(file, next);
  say(state === "present-unmarked" ? `AGENTS.md already has a mem-mem section (not managed): ${file}` : `AGENTS.md snippet ${state}: ${file}`);
  return state;
}

/** Text without our managed block (or an exact unmarked copy of the snippet). */
export function removeAgentsSnippet(text) {
  let out = text.replace(blockRe(), "");
  if (out === text && text.includes(SNIPPET_TEXT.trimEnd())) out = text.replace(SNIPPET_TEXT.trimEnd(), "");
  return out.replace(/\n{3,}$/, "\n\n").replace(/^\s+$/, "");
}
