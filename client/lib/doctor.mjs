// `memmem doctor`: check everything a working install needs. Each check is
// { name, status: ok|warn|fail|info, detail }. External commands go through an
// injectable runner so tests need no network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandPaths, hookFiles, HOOK_EVENTS, ourHooks, readJson, skillStatus, SNIPPET_BEGIN } from "./install.mjs";
import { runtimeDescription, VERSION } from "./runtime.mjs";
import { CONFIG_FILE, defaultRunner, findConfig, ghUser, LANGUAGES, languageOf, LAYOUT_VERSION, memberOf, projectPaths, readProjectInfo, repoUrl, resolveOnPath, serverLanguageOf } from "./util.mjs";

export { defaultRunner };

function check(list, name, status, detail) { list.push({ name, status, detail }); }

function hookCheck(list, label, file, { required }) {
  let cfg;
  try { cfg = readJson(file); } catch (e) { check(list, label, "fail", `${file}: invalid JSON (${e.message})`); return null; }
  const ours = ourHooks(cfg);
  const missing = HOOK_EVENTS.filter((e) => !ours[e]);
  if (!fs.existsSync(file) || missing.length === HOOK_EVENTS.length) {
    if (required) check(list, label, "warn", `no memmem hooks in ${file}`);
    return null;
  }
  check(list, label, missing.length ? "warn" : "ok", missing.length ? `${file}: missing ${missing.join(", ")}` : file);
  return ours;
}

/** Run all checks. Returns the list; `opts` are injectable for tests. */
export function doctorChecks({ cwd = process.cwd(), runner = defaultRunner, env = process.env, platform = process.platform } = {}) {
  const list = [];
  check(list, "memmem", "ok", `${VERSION} (${runtimeDescription()})`);
  const gv = runner("git", ["--version"]);
  check(list, "git", gv.ok ? "ok" : "fail", gv.ok ? gv.stdout : `git not found: ${gv.stderr}`);
  const onPath = resolveOnPath("memmem", { env, platform });
  check(list, "PATH", onPath ? "ok" : "warn", onPath ? `memmem -> ${onPath}` : "memmem is not on PATH: shared hooks (`memmem ...`) fail; Claude Code falls back to the .claude/settings.local.json safety net, Codex has none");

  let found = null;
  try { found = findConfig(cwd); } catch (e) { check(list, "config", "fail", `${CONFIG_FILE}: invalid JSON (${e.message})`); return list; }
  if (!found) { check(list, "config", "fail", `no ${CONFIG_FILE} in ${cwd} or its parents (run \`memmem setup\`)`); return list; }
  const { config, dir } = found;
  const miss = ["project", "memoryRepo", "transcriptsRepo"].filter((k) => typeof config[k] !== "string" || !config[k]);
  if (miss.length) check(list, "config", "fail", `${found.path}: missing ${miss.join(", ")}`);
  else check(list, "config", "ok", found.path);
  const lv = config.layoutVersion;
  if (lv === undefined) check(list, "layoutVersion", "warn", `not set (treated as 1); \`memmem setup\` adds it`);
  else if (!Number.isInteger(lv) || Math.abs(lv - LAYOUT_VERSION) > 1) check(list, "layoutVersion", "fail", `${lv} is outside what this memmem reads (${LAYOUT_VERSION - 1}..${LAYOUT_VERSION + 1}); update memmem`);
  else check(list, "layoutVersion", lv === LAYOUT_VERSION ? "ok" : "warn", lv === LAYOUT_VERSION ? String(lv) : `${lv} (this memmem writes ${LAYOUT_VERSION})`);
  if (config.language !== undefined && !LANGUAGES.includes(config.language)) check(list, "language", "warn", `unknown language ${JSON.stringify(config.language)}; using en`);
  else check(list, "language", "ok", config.language || "en (default)");
  const member = memberOf(dir, env);
  check(list, "member", member ? "ok" : "fail", member || "no member (run `memmem setup`; the member is your GitHub login)");
  // The member handle is the GitHub login; flag a mismatch with the signed-in gh user.
  if (member && resolveOnPath("gh", { env, platform })) {
    const gh = ghUser({ runner, env, platform });
    if (gh && gh.login !== member) check(list, "github login", "warn", `member ${member} != gh login ${gh.login} (run \`memmem setup --member ${gh.login} --alias ${member}\`)`);
    else if (gh) check(list, "github login", "ok", `member ${member} = gh login`);
  }
  if (miss.length) return list;

  // Credentials: a helper (gh or other) or a successful ls-remote is enough.
  const trUrl = repoUrl(config.transcriptsRepo);
  const helper = /^https?:\/\//.test(trUrl)
    ? runner("git", ["config", "--get-urlmatch", "credential.helper", trUrl], { cwd: dir })
    : runner("git", ["config", "--get-all", "credential.helper"], { cwd: dir });
  check(list, "credential helper", helper.ok && helper.stdout ? "ok" : "info", helper.ok && helper.stdout ? helper.stdout.split("\n").join(", ") : "none configured (fine for SSH or local repos; for GitHub HTTPS run `gh auth setup-git`)");
  for (const [label, spec] of [["memory repo", config.memoryRepo], ["transcripts repo", config.transcriptsRepo]]) {
    const url = repoUrl(spec);
    const r = runner("git", ["ls-remote", "--heads", url], { cwd: dir, timeout: 15_000 });
    check(list, label, r.ok ? "ok" : "fail", r.ok ? `${url} reachable` : `${url}: ${r.stderr.split("\n")[0] || "ls-remote failed"}`);
  }
  const paths = projectPaths(config, dir, { env, platform, homedir: env.HOME || os.homedir() });
  check(list, "memory clone", fs.existsSync(path.join(paths.memory, ".git")) ? "ok" : "warn", fs.existsSync(path.join(paths.memory, ".git")) ? paths.memory : `${paths.memory} missing (cloned at the next session start, or run \`memmem setup\`)`);
  check(list, "transcripts clone", fs.existsSync(path.join(paths.transcripts, ".git")) ? "ok" : "info", fs.existsSync(path.join(paths.transcripts, ".git")) ? paths.transcripts : `${paths.transcripts} missing (cloned by the first sync)`);
  // The memory language is the server's (transcripts repo project.json); config.language should match it.
  const serverLang = serverLanguageOf(readProjectInfo(paths.transcripts));
  if (serverLang && serverLang !== languageOf(config)) {
    check(list, "memory language", "warn", `memory language is ${serverLang} on the server; local config says ${languageOf(config)} (\`memmem setup --language ${serverLang}\`, then commit ${CONFIG_FILE})`);
  } else if (serverLang) check(list, "memory language", "ok", `${serverLang} (matches the transcripts repo's project.json)`);
  if (member) {
    const reg = path.join(paths.transcripts, "members", `${paths.member}.json`);
    if (fs.existsSync(reg)) check(list, "member registration", "ok", `members/${paths.member}.json`);
    else check(list, "member registration", "info", `no members/${paths.member}.json in the transcripts repo (run \`memmem setup\` to register)`);
  }
  try {
    fs.mkdirSync(paths.root, { recursive: true });
    const probe = path.join(paths.root, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, "x");
    fs.rmSync(probe);
    check(list, "data dir", "ok", `${paths.root} writable`);
  } catch (e) { check(list, "data dir", "fail", `${paths.root}: ${e.message}`); }

  const f = hookFiles(dir);
  const shared = hookCheck(list, "claude hooks (shared)", f.claudeShared, { required: false });
  let local = null;
  try { local = ourHooks(readJson(f.claudeLocal)); } catch (e) { check(list, "claude hooks (local)", "fail", `${f.claudeLocal}: invalid JSON (${e.message})`); }
  if (local && Object.keys(local).length) {
    const cmds = Object.values(local).flat();
    const bad = [...new Set(cmds.flatMap(commandPaths))].filter((p) => !p.includes("/") && !p.includes("\\") ? !resolveOnPath(p, { env, platform }) : !fs.existsSync(p));
    const fallbackOnly = cmds.every((c) => / --fallback\b/.test(c));
    if (bad.length) check(list, "claude hooks (local)", "fail", `${f.claudeLocal} points at missing ${bad.join(", ")}; run \`memmem setup\` again`);
    else check(list, "claude hooks (local)", "ok", `${f.claudeLocal} (${fallbackOnly ? "PATH safety net" : "local hooks"})`);
  } else if (!shared) check(list, "claude hooks", "warn", `no memmem hooks in ${f.claudeShared} or ${f.claudeLocal} (run \`memmem setup --hooks-only\`)`);
  hookCheck(list, "codex hooks", f.codex, { required: true });

  for (const s of skillStatus(dir)) {
    const rel = path.relative(dir, s.dest);
    if (s.state === "ok") check(list, "skill", "ok", rel);
    else check(list, "skill", "warn", `${rel}: ${s.state === "stale" ? "out of date" : s.state === "foreign" ? "not ours" : "missing"} (\`memmem setup --hooks-only\` refreshes it)`);
  }
  const agents = path.join(dir, "AGENTS.md");
  const at = fs.existsSync(agents) ? fs.readFileSync(agents, "utf8") : "";
  check(list, "AGENTS.md", at.includes(SNIPPET_BEGIN) || at.includes("## Team memory (mem-mem)") ? "ok" : "warn", at ? agents : `${agents} has no mem-mem section`);
  check(list, "codex trust", "info", "Codex runs project hooks only after you trust them (and again after any change): open Codex here and use /hooks");
  return list;
}

export function renderChecks(list) {
  const tag = { ok: "ok  ", warn: "WARN", fail: "FAIL", info: "info" };
  return list.map((c) => `${tag[c.status]}  ${c.name}: ${c.detail}`).join("\n") + "\n";
}

export function runDoctor(args, { out = process.stdout, ...opts } = {}) {
  const list = doctorChecks({ cwd: args.cwd || process.cwd(), ...opts });
  out.write(args.json ? JSON.stringify(list) + "\n" : renderChecks(list));
  return list.some((c) => c.status === "fail") ? 1 : 0;
}
