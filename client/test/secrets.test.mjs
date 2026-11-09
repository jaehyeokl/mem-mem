import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { redactDeep, redactString } from "../lib/secrets.mjs";
import { buildTrajectoryDoc } from "../lib/sync.mjs";
import { CLAUDE_FIXTURE } from "./helpers.mjs";

// Fake secrets are assembled at runtime so no secret-shaped literal sits in the repo.
const fake = {
  aws: "AKIA" + "Z".repeat(16),
  sk: "sk-" + "proj-" + "a1B2".repeat(8),
  ghp: "gh" + "p_" + "x9".repeat(18),
  pat: "github" + "_pat_" + "Ab1_".repeat(10),
  gho: "gh" + "o_" + "Q".repeat(36),
  jwt: ["eyJ" + "hbGciOiJIUzI1NiJ9", "eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0", "c2lnbmF0dXJlLXZhbHVl"].join("."),
  pem: "-----BEGIN RSA " + "PRIVATE KEY-----\nMIIEow" + "A".repeat(40) + "\n-----END RSA " + "PRIVATE KEY-----",
};

test("redactString handles each pattern", () => {
  const counts = {};
  const text = `aws ${fake.aws} key ${fake.sk} gh ${fake.ghp} ${fake.pat} ${fake.gho} jwt ${fake.jwt}\n${fake.pem}\npassword=hunter22 ok`;
  const out = redactString(text, counts);
  for (const v of Object.values(fake)) assert.ok(!out.includes(v), `leaked: ${v.slice(0, 12)}`);
  assert.ok(!out.includes("hunter22"));
  assert.match(out, /\[REDACTED:aws_access_key\]/);
  assert.match(out, /\[REDACTED:api_key\]/);
  assert.match(out, /\[REDACTED:github_token\]/);
  assert.match(out, /\[REDACTED:jwt\]/);
  assert.match(out, /\[REDACTED:private_key\]/);
  assert.match(out, /password=\[REDACTED:password\]/);
  assert.equal(counts.github_token, 3);
  assert.ok(out.endsWith(" ok"));
});

test("plain text is left alone", () => {
  const s = "The test fails because checkToken() is not mocked. sk-learn is a library; password policy is 12 chars.";
  assert.equal(redactString(s, {}), s);
});

test("redactDeep walks nested records and counts", () => {
  const r = redactDeep([{ role: "tool", content: `token ${fake.ghp}` }, { args: JSON.stringify({ env: `AWS=${fake.aws}` }) }]);
  assert.equal(r.total, 2);
  assert.match(r.value[0].content, /REDACTED:github_token/);
  assert.match(r.value[1].args, /REDACTED:aws_access_key/);
});

test("trajectory doc records redaction counts in meta", () => {
  const lines = fs.readFileSync(CLAUDE_FIXTURE, "utf8").trim().split("\n");
  const user = JSON.parse(lines[1]);
  user.message.content = `deploy with ${fake.sk} please`;
  lines[1] = JSON.stringify(user);
  const r = buildTrajectoryDoc({ raw: lines.join("\n"), tool: "claude-code", sessionId: "s1", member: "alice", project: "acme" });
  assert.equal(r.doc.meta.redactions, 1);
  assert.deepEqual(r.doc.meta.redactionsByType, { api_key: 1 });
  assert.ok(!r.json.includes(fake.sk));
});
