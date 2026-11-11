// `memmem uninstall [--purge] [--keep-config]`
//  - shared mode: remove memmem hooks from the project's Claude Code (shared and
//    local) and Codex hook files, the skills, and the AGENTS.md block. Clones and
//    .memmem/config.json stay unless --purge (with --purge, --keep-config still
//    keeps config.json).
//  - user mode: remove .memmem/ and the info/exclude line; the data folder stays
//    unless --purge. Nothing else in the project is touched.
// `memmem uninstall --user`: remove the user-level hooks, skills, and Codex trust records (user.mjs).
import fs from "node:fs";
import path from "node:path";
import { hookFiles, readJson, removeAgentsSnippet, removeOurHooks, writeJson } from "./install.mjs";
import { SKILLS } from "./assets.generated.mjs";
import { removeExcluded, uninstallUser } from "./user.mjs";
import { CONFIG_DIR, CONFIG_FILE, findConfig, git, LOCAL_FILE, modeOf, OUTBOX_DIR, projectPaths, readLocal } from "./util.mjs";

export const UNINSTALL_BOOLEANS = ["purge", "keepConfig", "user"];

/** Remove the data folder unless the transcripts clone may hold unpushed commits. */
function purgeData(paths, say) {
  if (fs.existsSync(path.join(paths.transcripts, ".git"))) {
    const ahead = git(["log", "--oneline", "@{u}..HEAD"], { cwd: paths.transcripts });
    if (!ahead.ok || ahead.stdout) { say(`kept ${paths.transcripts}: it may have unpushed commits (push them or delete it by hand)`); return; }
  } else if (!fs.existsSync(paths.root)) return;
  fs.rmSync(paths.root, { recursive: true, force: true });
  say(`removed ${paths.root}`);
}

/** Outbox notes not uploaded yet. */
function outboxNotes(dir) {
  try { return fs.readdirSync(path.join(dir, OUTBOX_DIR)).filter((n) => n.endsWith(".md")); } catch { return []; }
}

/** The repository's linked worktrees (not the main checkout), from `git worktree list --porcelain`. */
function linkedWorktrees(dir) {
  const r = git(["worktree", "list", "--porcelain"], { cwd: dir });
  if (!r.ok) return [];
  // git prints real paths; `dir` may reach the main checkout through a symlink.
  const realOf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const self = realOf(dir);
  const all = r.stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => path.resolve(l.slice(9)));
  return all.filter((w) => realOf(w) !== self);
}

/** User mode, project side: .memmem/ (unless the outbox holds notes) and our info/exclude line. */
function uninstallUserProject(found, args, say) {
  const dir = found.dir;
  const local = readLocal(dir);
  if (args.purge) {
    const paths = projectPaths(found.config, dir);
    purgeData(paths, say);
    if (!paths.memory.startsWith(path.join(dir, CONFIG_DIR) + path.sep)) { fs.rmSync(paths.memory, { recursive: true, force: true }); say(`removed ${paths.memory}`); }
  } else say("kept the data folder (transcripts clone, logs; use --purge to remove it)");
  // Notes queued in linked worktrees (their own .memmem/outbox/) count too.
  const worktrees = linkedWorktrees(dir);
  const pending = [dir, ...worktrees].map((d) => [d, outboxNotes(d).length]).filter(([, n]) => n);
  if (pending.length) {
    const where = pending.map(([d, n]) => `${n} in ${path.join(d, OUTBOX_DIR)}`).join(", ");
    say(`kept ${path.join(dir, CONFIG_DIR)}: queued note(s) are not uploaded yet (${where}); a session end or \`memmem remember\` outside the sandbox uploads them, then run uninstall again`);
    return 0;
  }
  if (found.checkout) say(`${found.checkout} is a linked worktree; removing the setup of its main checkout ${dir}`);
  fs.rmSync(path.join(dir, CONFIG_DIR), { recursive: true, force: true });
  say(`removed ${path.join(dir, CONFIG_DIR)}`);
  for (const w of worktrees) {
    try { fs.rmdirSync(path.join(w, OUTBOX_DIR)); } catch { /* absent or not empty */ }
    try { fs.rmdirSync(path.join(w, CONFIG_DIR)); } catch { /* absent or not empty */ }
  }
  if (local.excluded && removeExcluded(dir)) say(`removed ${CONFIG_DIR}/ from the repository's info/exclude`);
  say("the user-level hooks and skill stay for other projects (`memmem uninstall --user` removes them)");
  return 0;
}

export function runUninstall(args, { out = process.stdout, err = process.stderr, user = {} } = {}) {
  const say = (s) => out.write(s + "\n");
  if (args.user) return uninstallUser({ ...user, say, warn: (s) => err.write(s + "\n") });
  let found;
  try { found = findConfig(args.dir || args.cwd || process.cwd()); } catch (e) { err.write(`memmem uninstall: ${CONFIG_FILE}: ${e.message}\n`); return 1; }
  if (found && modeOf(readLocal(found.dir)) === "user") return uninstallUserProject(found, args, say);
  const dir = path.resolve(args.dir || found?.dir || process.cwd());
  let rc = 0;
  for (const file of Object.values(hookFiles(dir))) {
    if (!fs.existsSync(file)) continue;
    try {
      const cur = readJson(file);
      const next = removeOurHooks(cur);
      if (JSON.stringify(next) === JSON.stringify(cur)) continue;
      if (Object.keys(next).length === 0) { fs.rmSync(file); say(`removed ${file} (only memmem hooks)`); }
      else { writeJson(file, next); say(`removed memmem hooks from ${file}`); }
    } catch (e) { err.write(`memmem uninstall: ${file}: ${e.message}; left untouched\n`); rc = 1; }
  }
  for (const { dest } of Object.values(SKILLS)) {
    const file = path.join(dir, dest);
    if (!fs.existsSync(file)) continue;
    if (!/memmem/.test(fs.readFileSync(file, "utf8"))) { say(`left ${file} (not ours)`); continue; }
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    say(`removed ${path.dirname(file)}`);
  }
  const agents = path.join(dir, "AGENTS.md");
  if (fs.existsSync(agents)) {
    const cur = fs.readFileSync(agents, "utf8");
    const next = removeAgentsSnippet(cur);
    if (next !== cur) {
      if (next.trim()) fs.writeFileSync(agents, next); else fs.rmSync(agents);
      say(`removed the mem-mem section from ${agents}`);
    }
  }
  if (args.purge && found) {
    const paths = projectPaths(found.config, found.dir);
    // Never drop commits a failed push left in the transcripts clone.
    purgeData(paths, say);
    fs.rmSync(paths.memory, { recursive: true, force: true });
    say(`removed ${paths.memory}`);
    fs.rmSync(path.join(found.dir, LOCAL_FILE), { force: true });
    if (!args.keepConfig) {
      fs.rmSync(path.join(found.dir, CONFIG_FILE), { force: true });
      try { fs.rmdirSync(path.join(found.dir, CONFIG_DIR)); } catch { /* not empty */ }
      say(`removed ${path.join(found.dir, CONFIG_FILE)}`);
    }
  } else {
    say("kept .memmem/config.json and the clones (use --purge to remove them)");
  }
  say("the .gitignore lines were left in place");
  return rc;
}
