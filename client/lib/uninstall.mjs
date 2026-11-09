// `memmem uninstall [--purge] [--keep-config]`: remove memmem hooks from the
// project's Claude Code (shared and local) and Codex hook files, the skills,
// and the AGENTS.md block. Clones and .memmem/config.json stay unless --purge
// (with --purge, --keep-config still keeps config.json).
import fs from "node:fs";
import path from "node:path";
import { hookFiles, readJson, removeAgentsSnippet, removeOurHooks, writeJson } from "./install.mjs";
import { SKILLS } from "./assets.generated.mjs";
import { CONFIG_DIR, CONFIG_FILE, findConfig, git, LOCAL_FILE, projectPaths } from "./util.mjs";

export const UNINSTALL_BOOLEANS = ["purge", "keepConfig"];

export function runUninstall(args, { out = process.stdout, err = process.stderr } = {}) {
  const say = (s) => out.write(s + "\n");
  const found = findConfig(args.dir || args.cwd || process.cwd());
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
    if (fs.existsSync(path.join(paths.transcripts, ".git"))) {
      const ahead = git(["log", "--oneline", "@{u}..HEAD"], { cwd: paths.transcripts });
      if (!ahead.ok || ahead.stdout) { say(`kept ${paths.transcripts}: it may have unpushed commits (push them or delete it by hand)`); }
      else { fs.rmSync(paths.root, { recursive: true, force: true }); say(`removed ${paths.root}`); }
    } else if (fs.existsSync(paths.root)) { fs.rmSync(paths.root, { recursive: true, force: true }); say(`removed ${paths.root}`); }
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
