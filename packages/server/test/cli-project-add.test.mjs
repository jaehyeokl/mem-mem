import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync } from "node:fs";
import { join } from "node:path";
import { normalizeRepo, projectAdd, repoPlan, renderMemoryLayout, renderTranscriptsLayout, projectDoc } from "../dist/cli/project-add.js";
import { readProjectsFile, upsertProject } from "../dist/cli/projects-file.js";
import { isExampleDecision, listFiles, memoryTemplateDir, render, resolveTemplatesDir } from "../dist/cli/templates.js";
import { defaultRunner } from "../dist/cli/exec.js";
import { dispatch } from "../dist/cli.js";
import { fakeRunner, makeCtx, tempHome } from "./cli-helpers.mjs";
import { fakeMemfs, seededTranscriptsRepo, REPO_ROOT } from "./helpers.mjs";

test("repo names: owner/name, URLs, and the default plan", () => {
  assert.deepEqual(normalizeRepo("acme/mem-x"), { url: "https://github.com/acme/mem-x.git", slug: "acme/mem-x" });
  assert.deepEqual(normalizeRepo("https://github.com/acme/mem-x.git"), { url: "https://github.com/acme/mem-x.git", slug: "acme/mem-x" });
  assert.deepEqual(normalizeRepo("git@github.com:acme/mem-x.git"), { url: "git@github.com:acme/mem-x.git", slug: "acme/mem-x" });
  assert.equal(normalizeRepo("/srv/git/mem-x.git").slug, null);
  const plan = repoPlan("shop", "acme", { transcriptsRepo: "other/tr" });
  assert.equal(plan.mem.slug, "acme/mem-shop");
  assert.equal(plan.mem.given, false);
  assert.equal(plan.tr.url, "https://github.com/other/tr.git");
  assert.equal(plan.tr.given, true);
});

test("dry run prints every step and runs nothing", async () => {
  const home = tempHome();
  const calls = [];
  const ctx = makeCtx(home, { run: fakeRunner({}, calls) });
  const r = await projectAdd(ctx, { name: "demo-shop", owner: "example-org", model: "openai-codex/gpt-5.6-sol", summary: "Demo shop", dryRun: true });
  assert.deepEqual(calls, [], "dry run must not run commands");
  const text = ctx.out.text();
  for (const s of [
    "gh repo create example-org/mem-demo-shop --private",
    "gh repo create example-org/mem-demo-shop-transcripts --private",
    "git push -q https://github.com/example-org/mem-demo-shop-transcripts.git main:main",
    "letta --backend local agents create --name demo-shop",
    "letta --backend local model set openai-codex/gpt-5.6-sol --reasoning low --agent <agent-id>",
    "git config --local letta.memoryRepository.url https://github.com/example-org/mem-demo-shop.git",
    "git push -q https://github.com/example-org/mem-demo-shop.git main:main",
    "reflection.md (model: openai-codex/gpt-5.6-sol)",
    "(merged entry for demo-shop)",
    "would reload the running App Server",
  ]) {
    assert.ok(text.includes(s), `missing in dry-run output: ${s}\n---\n${text}`);
  }
  assert.equal(r.dryRun, true);
  assert.equal(r.entry.agentId, "<agent-id>");
  assert.equal(existsSync(join(home, "projects.json")), false, "dry run must not write projects.json");
});

test("dry run with given repo URLs needs no owner and creates no repos", async () => {
  const ctx = makeCtx(tempHome());
  await projectAdd(ctx, { name: "p1", memoryRepo: "acme/mem-p1", transcriptsRepo: "https://github.com/acme/mem-p1-transcripts.git", dryRun: true });
  const text = ctx.out.text();
  assert.ok(!text.includes("gh repo create"));
  assert.match(text, /using https:\/\/github.com\/acme\/mem-p1.git/);
});

test("project add refuses bad names and a missing provider", async () => {
  const ctx = makeCtx(tempHome());
  await assert.rejects(projectAdd(ctx, { name: "Bad Name", dryRun: true }), /project name must match/);
  await assert.rejects(projectAdd(ctx, { name: "ok", owner: "o" }), /no model provider connected/);
});

test("projects.json merge keeps createdAt and a paused flag; defaults come from the file", async () => {
  const file = { settings: { stepCount: 3 }, defaults: { model: "m/default" }, projects: [{ project: "a", agentId: "x", memoryRepo: "m", transcriptsRepo: "t", createdAt: "2026-01-01T00:00:00Z", enabled: false }] };
  const merged = upsertProject(file, { project: "a", agentId: "x", memoryRepo: "m2", transcriptsRepo: "t", model: "m/1" });
  assert.equal(merged.projects.length, 1);
  assert.equal(merged.projects[0].createdAt, "2026-01-01T00:00:00Z");
  assert.equal(merged.projects[0].enabled, false);
  assert.equal(merged.projects[0].memoryRepo, "m2");
  const added = upsertProject(merged, { project: "b", agentId: "y", memoryRepo: "m", transcriptsRepo: "t" }, new Date("2026-11-06T01:02:03.456Z"));
  assert.equal(added.projects[1].createdAt, "2026-11-06T01:02:03Z");
  const again = upsertProject(added, { project: "a", agentId: "x", memoryRepo: "m3", transcriptsRepo: "t" });
  assert.deepEqual(again.projects.map((p) => p.project), ["a", "b"], "an update keeps the entry's position");

  const home = tempHome();
  writeFileSync(join(home, "projects.json"), JSON.stringify(file));
  const ctx = makeCtx(home);
  const r = await projectAdd(ctx, { name: "b", owner: "o", dryRun: true });
  assert.equal(r.model, "m/default");
  assert.equal(readProjectsFile(ctx.paths).projects.length, 1);
});

test("template rendering is literal and skips the example decision", () => {
  assert.equal(render("{{A}} & {{A}} $& {{B}}", { A: "x$&y", B: "z" }), "x$&y & x$&y $& z");
  assert.equal(isExampleDecision("decisions/EXAMPLE-2026-01-01-example.md"), true);
  assert.equal(isExampleDecision("decisions/MEMORY.md"), false);
  for (const lang of ["en", "ko"]) {
    assert.match(readFileSync(new URL(`../../../templates/memory-repo/${lang}/MEMORY.md`, import.meta.url), "utf8"), /\{\{PROJECT_NAME\}\}/);
  }
});

const TEMPLATES = join(REPO_ROOT, "templates");
const frontmatterKeys = (text) => {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1].split("\n").map((l) => l.split(":")[0].trim()) : null;
};

test("memory templates: en and ko have the same files and placeholders; folder names and frontmatter keys are English", () => {
  const en = listFiles(join(TEMPLATES, "memory-repo", "en"));
  const ko = listFiles(join(TEMPLATES, "memory-repo", "ko"));
  assert.deepEqual(en, ko);
  assert.ok(en.includes("decisions/EXAMPLE-2026-01-01-example.md") && en.includes("people/MEMORY.md"));
  const placeholders = (lang, f) => [...readFileSync(join(TEMPLATES, "memory-repo", lang, f), "utf8").matchAll(/\{\{[A-Z_]+\}\}/g)].map((m) => m[0]).sort();
  for (const f of en) {
    assert.deepEqual([...new Set(placeholders("en", f))], [...new Set(placeholders("ko", f))], `placeholders differ in ${f}`);
    for (const lang of ["en", "ko"]) {
      const keys = frontmatterKeys(readFileSync(join(TEMPLATES, "memory-repo", lang, f), "utf8"));
      if (f.endsWith("MEMORY.md")) assert.equal(keys, null, `${lang}/${f} has no frontmatter`);
      else assert.deepEqual(keys, ["name", "description"], `${lang}/${f} frontmatter keys`);
    }
  }
  const ex = readFileSync(join(TEMPLATES, "memory-repo", "en", "decisions", "EXAMPLE-2026-01-01-example.md"), "utf8");
  for (const h of ["## Decision", "## Reason", "## Alternatives", "## Source sessions", "## Status"]) assert.ok(ex.includes(h), h);
  assert.match(readFileSync(join(TEMPLATES, "memory-repo", "en", "people", "MEMORY.md"), "utf8"), /preferred conversation language/);
  assert.match(readFileSync(join(TEMPLATES, "memory-repo", "ko", "people", "MEMORY.md"), "utf8"), /선호 대화 언어/);
  assert.doesNotMatch(readFileSync(join(TEMPLATES, "transcripts-repo", "README.md"), "utf8"), /[가-힣]/, "transcripts README is English");
  assert.doesNotMatch(readFileSync(join(TEMPLATES, "transcripts-repo", "RETENTION.md"), "utf8"), /[가-힣]/);
});

test("memoryTemplateDir: only memory-repo/<lang>; files directly under memory-repo/ are not a template", () => {
  assert.equal(memoryTemplateDir(TEMPLATES, "en"), join(TEMPLATES, "memory-repo", "en"));
  assert.equal(memoryTemplateDir(TEMPLATES, "ja"), null);
  const old = tempHome("memmem-tpl-");
  mkdirSync(join(old, "transcripts-repo"), { recursive: true });
  cpSync(join(TEMPLATES, "memory-repo", "ko"), join(old, "memory-repo"), { recursive: true });
  assert.equal(resolveTemplatesDir({ MEMMEM_TEMPLATES: old }), old);
  assert.equal(memoryTemplateDir(old, "ko"), null);
  assert.equal(memoryTemplateDir(old, "en"), null);
});

test("layouts: transcripts layout gets project.json; memory layout renders en or ko", () => {
  const dir = tempHome("memmem-layout-");
  const vars = { PROJECT_NAME: "shop", PROJECT_SUMMARY: "S", MEMORY_REPO: "o/mem-shop", TRANSCRIPTS_REPO: "o/mem-shop-transcripts" };
  const files = renderTranscriptsLayout(TEMPLATES, join(dir, "tr"), vars, projectDoc("shop", "ko", "2026-11-06T00:00:00Z"));
  assert.ok(files.includes("project.json") && files.includes("README.md"));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "tr", "project.json"), "utf8")), { project: "shop", language: "ko", layoutVersion: 1, createdAt: "2026-11-06T00:00:00Z" });
  renderMemoryLayout(TEMPLATES, "en", join(dir, "en"), vars);
  renderMemoryLayout(TEMPLATES, "ko", join(dir, "ko"), vars);
  assert.match(readFileSync(join(dir, "en", "MEMORY.md"), "utf8"), /^# shop team memory/);
  assert.match(readFileSync(join(dir, "ko", "MEMORY.md"), "utf8"), /^# shop 팀 메모리/);
  assert.ok(!existsSync(join(dir, "en", "decisions", "EXAMPLE-2026-01-01-example.md")));
});

test("project add --language: validated, shown in the dry run, recorded in the entry; an existing project keeps its language", async () => {
  const ctx = makeCtx(tempHome());
  const r = await projectAdd(ctx, { name: "p1", memoryRepo: "acme/mem-p1", transcriptsRepo: "acme/mem-p1-transcripts", dryRun: true });
  assert.equal(r.language, "en");
  assert.equal(r.entry.language, "en");
  assert.match(ctx.out.text(), /memory language\s+en \(English\)/);
  assert.match(ctx.out.text(), /memory-repo\/en/);
  const ko = await projectAdd(makeCtx(tempHome()), { name: "p1", memoryRepo: "acme/mem-p1", transcriptsRepo: "acme/mem-p1-transcripts", language: "ko", dryRun: true });
  assert.equal(ko.entry.language, "ko");
  await assert.rejects(projectAdd(makeCtx(tempHome()), { name: "p1", language: "fr", dryRun: true }), /--language must be one of en, ko/);
  const home = tempHome();
  writeFileSync(join(home, "projects.json"), JSON.stringify({ settings: {}, projects: [{ project: "p1", agentId: "a", memoryRepo: "m", transcriptsRepo: "t" }] }));
  await assert.rejects(projectAdd(makeCtx(home), { name: "p1", language: "ko", dryRun: true }), /already exists with memory language en/);
  assert.equal((await projectAdd(makeCtx(home), { name: "p1", dryRun: true })).language, "en");
});

/** A runner that fakes `letta` (agent list/create/model set; create makes a MemFS git repo) and runs git for real. */
function lettaFakeRunner(home, agentId = "agent-local-lang") {
  return async (cmd, args, opts) => {
    if (cmd !== "letta") return defaultRunner(cmd, args, opts);
    const a = args.filter((x) => x !== "--backend" && x !== "local");
    if (a[0] === "agents" && a[1] === "list") return { code: 0, stdout: "[]", stderr: "" };
    if (a[0] === "agents" && a[1] === "create") {
      fakeMemfs(join(home, "letta", "lc-local-backend", "memfs", agentId, "memory"));
      return { code: 0, stdout: JSON.stringify({ id: agentId }), stderr: "" };
    }
    if (a[0] === "model" && a[1] === "set") return { code: 0, stdout: "", stderr: "" };
    return { code: 127, stdout: "", stderr: "letta: unexpected" };
  };
}

async function addForReal(language) {
  const home = tempHome();
  const tr = join(home, "tr.git");
  const mem = join(home, "mem.git");
  for (const b of [tr, mem]) execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", b]);
  const ctx = makeCtx(home, { run: lettaFakeRunner(home), env: { LETTA_CONFIG_DIR: join(home, "letta") } });
  const r = await projectAdd(ctx, { name: "shop", memoryRepo: mem, transcriptsRepo: tr, summary: "A shop", language, noReload: true, skipProviderCheck: true });
  const show = (bare, path) => execFileSync("git", ["--git-dir", bare, "show", `main:${path}`], { encoding: "utf8" });
  return { r, ctx, show: (path) => show(tr, path), mem: (path) => show(mem, path) };
}

test("project add (no dry run): en by default writes project.json and the English memory; --language ko the Korean one", async () => {
  const en = await addForReal(undefined);
  const doc = JSON.parse(en.show("project.json"));
  assert.equal(doc.project, "shop");
  assert.equal(doc.language, "en");
  assert.equal(doc.layoutVersion, 1);
  assert.match(doc.createdAt, /^\d{4}-\d\d-\d\dT/);
  assert.match(en.show("README.md"), /^# shop transcripts/);
  assert.match(en.mem("MEMORY.md"), /^# shop team memory/);
  assert.match(en.mem("project.md"), /A shop/);
  const entry = readProjectsFile(en.ctx.paths).projects[0];
  assert.equal(entry.language, "en");
  assert.equal(entry.createdAt, doc.createdAt);
  assert.match(en.ctx.out.text(), /setup reads the memory language, en/);

  const ko = await addForReal("ko");
  assert.equal(JSON.parse(ko.show("project.json")).language, "ko");
  assert.match(ko.mem("MEMORY.md"), /^# shop 팀 메모리/);
  assert.match(ko.mem("decisions/MEMORY.md"), /프로젝트 결정 기록/);
  assert.equal(readProjectsFile(ko.ctx.paths).projects[0].language, "ko");
});

test("project set-language: projects.json and the transcripts repo's project.json; idempotent; list/show print it", async () => {
  const home = tempHome();
  const { bare } = seededTranscriptsRepo(home);
  writeFileSync(join(home, "projects.json"), JSON.stringify({ settings: {}, projects: [{ project: "demo-shop", agentId: "a", memoryRepo: "m", transcriptsRepo: bare, createdAt: "2026-11-01T00:00:00Z" }] }));
  const run = async (name, ...pos) => {
    const ctx = makeCtx(home, { run: defaultRunner });
    const code = await dispatch(ctx, name, {}, pos);
    return { code, text: ctx.out.text(), ctx };
  };
  const a = await run("project set-language", "demo-shop", "ko");
  assert.equal(a.code, 0, a.text);
  assert.equal(readProjectsFile(a.ctx.paths).projects[0].language, "ko");
  const show = () => JSON.parse(execFileSync("git", ["--git-dir", bare, "show", "main:project.json"], { encoding: "utf8" }));
  assert.deepEqual(show(), { project: "demo-shop", language: "ko", layoutVersion: 1, createdAt: "2026-11-01T00:00:00Z" });
  assert.match(a.text, /existing memory text is not translated/);
  const commits = () => execFileSync("git", ["--git-dir", bare, "rev-list", "--count", "main"], { encoding: "utf8" }).trim();
  const n = commits();
  const b = await run("project set-language", "demo-shop", "ko");
  assert.equal(b.code, 0);
  assert.match(b.text, /already uses ko/);
  assert.equal(commits(), n, "no new commit when nothing changed");
  const c = await run("project set-language", "demo-shop", "en");
  assert.equal(show().language, "en");
  assert.equal(show().createdAt, "2026-11-01T00:00:00Z");
  assert.match(c.text, /ko -> en/);
  await assert.rejects(run("project set-language", "demo-shop", "fr"), /--language must be one of/);
  assert.match((await run("project list")).text, /LANG[\s\S]*demo-shop\s+enabled\s+en/);
  assert.match((await run("project show", "demo-shop")).text, /memory language en \(English\)/);
});
