import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { doctorChecks, failed, toolChecks } from "../dist/cli/checks.js";
import { fakeRunner, makeCtx, tempHome } from "./cli-helpers.mjs";

const AGENT = "agent-local-11111111-2222-3333-4444-555555555555";

const healthyTools = {
  "letta --version": { stdout: "0.34.41 (Letta Code)\n" },
  "git --version": { stdout: "git version 2.43.0\n" },
  "gh --version": { stdout: "gh version 2.103.0 (2026-10-21)\n" },
  "zstd --version": { stdout: "*** Zstandard CLI v1.5.5 ***\n" },
};

test("tool checks: missing letta and old node fail with the install command; gh/zstd are optional", async () => {
  const ctx = makeCtx(tempHome(), { run: fakeRunner({ "git --version": { stdout: "git version 2.43.0" } }) });
  const checks = await toolChecks(ctx, { nodeVersion: "22.1.0", platform: "linux" });
  const by = Object.fromEntries(checks.map((c) => [c.id, c]));
  assert.equal(by.node.status, "fail");
  assert.equal(by.letta.status, "fail");
  assert.match(by.letta.fix, /npm i -g .*@letta-ai\/letta-code@0\.34\.41/);
  assert.equal(by.git.status, "ok");
  assert.equal(by.gh.status, "warn");
  assert.equal(by.gh.fix, "sudo apt-get install -y gh");
  assert.equal(by.zstd.status, "warn");
  assert.deepEqual(failed(checks).map((c) => c.id), ["node", "letta"]);
});

test("tool checks: Letta Code outside 0.34.x fails", async () => {
  const ctx = makeCtx(tempHome(), { run: fakeRunner({ ...healthyTools, "letta --version": { stdout: "0.35.0 (Letta Code)" } }) });
  const checks = await toolChecks(ctx, { nodeVersion: "24.22.2" });
  assert.equal(checks.find((c) => c.id === "letta").status, "fail");
});

test("doctor: fresh data root reports what to run", async () => {
  const home = tempHome();
  const ctx = makeCtx(home, { run: fakeRunner(healthyTools) });
  const checks = await doctorChecks(ctx, { nodeVersion: "24.22.2" });
  const by = Object.fromEntries(checks.map((c) => [c.id, c]));
  assert.equal(by.data.status, "fail");
  assert.equal(by["git-identity"].fix, "memmem-server setup");
  assert.equal(by.provider.status, "fail");
  assert.equal(by.provider.fix, "memmem-server provider connect chatgpt");
  assert.equal(by.server.status, "warn");
  assert.equal(by.projects.status, "warn");
  assert.ok(failed(checks).length >= 3);
});

test("doctor: a configured server passes, and per-project problems are reported", async () => {
  const home = tempHome();
  const ctx = makeCtx(home, {
    run: fakeRunner({
      ...healthyTools,
      "git config --global user.name": { stdout: "mem-mem\n" },
      "git config --global user.email": { stdout: "mem-mem@localhost\n" },
      "git config --global --get-all credential.https://github.com.helper": { stdout: "\n!/usr/bin/gh auth git-credential\n" },
      "git config --global --get-all credential.helper": { code: 1 },
      "gh auth status -h github.com": { stdout: "github.com\n  ✓ Logged in to github.com account octo (keyring)\n" },
      "letta --backend local agents list": { stdout: JSON.stringify({ items: [{ id: AGENT, name: "demo-shop" }] }) },
    }),
  });
  for (const d of ["state", "repos", "agentcwd", "logs"]) mkdirSync(join(home, d), { recursive: true });
  const letta = join(home, "letta");
  mkdirSync(join(letta, "lc-local-backend", "providers"), { recursive: true });
  writeFileSync(
    join(letta, "lc-local-backend", "providers", "auth.json"),
    JSON.stringify({ providers: { "chatgpt-plus-pro": { name: "chatgpt-plus-pro", provider_type: "chatgpt_oauth", auth: { type: "oauth", access: "x", refresh: "y", expires: Date.now() - 1000 } } } }),
  );
  mkdirSync(join(letta, "agents"), { recursive: true });
  writeFileSync(join(letta, "agents", "reflection.md"), "---\nname: reflection\nmodel: openai-codex/gpt-5.6-sol\n---\n");
  mkdirSync(join(letta, "lc-local-backend", "memfs", AGENT, "memory", ".git"), { recursive: true });
  writeFileSync(
    join(home, "projects.json"),
    JSON.stringify({
      settings: { stepCount: 3 },
      projects: [
        { project: "demo-shop", agentId: AGENT, memoryRepo: "https://github.com/o/mem-demo-shop.git", transcriptsRepo: "https://github.com/o/mem-demo-shop-transcripts.git" },
        { project: "ghost", agentId: "agent-local-missing", memoryRepo: "m", transcriptsRepo: "t", enabled: false },
      ],
    }),
  );
  const checks = await doctorChecks(ctx, { nodeVersion: "24.22.2" });
  const by = Object.fromEntries(checks.map((c) => [c.id, c]));
  assert.equal(by.data.status, "ok");
  assert.equal(by["git-identity"].status, "ok");
  assert.equal(by.github.status, "ok");
  assert.match(by.github.detail, /octo/);
  assert.equal(by["provider:chatgpt-plus-pro"].status, "ok");
  assert.match(by["provider:chatgpt-plus-pro"].detail, /refreshes it/);
  assert.equal(by["reflection-model"].detail, "openai-codex/gpt-5.6-sol");
  assert.equal(by["project:demo-shop"].status, "ok");
  assert.equal(by["project:ghost"].status, "fail");
  assert.match(by["project:ghost"].detail, /not found in Letta.*MemFS missing.*paused/);
  assert.deepEqual(failed(checks).map((c) => c.id), ["project:ghost"]);
});

test("doctor: gh helper configured but gh logged out is critical", async () => {
  const home = tempHome();
  const ctx = makeCtx(home, {
    run: fakeRunner({
      ...healthyTools,
      "git config --global --get-all credential.https://github.com.helper": { stdout: "!/usr/bin/gh auth git-credential\n" },
      "gh auth status -h github.com": { code: 1, stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login" },
    }),
  });
  const checks = await doctorChecks(ctx, { nodeVersion: "24.22.2" });
  const gh = checks.find((c) => c.id === "github");
  assert.equal(gh.status, "fail");
  assert.match(gh.detail, /not logged/);
});
