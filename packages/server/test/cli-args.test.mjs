import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, helpText, intOpt, parseCommandLine } from "../dist/cli/args.js";
import { UsageError } from "../dist/cli/io.js";

test("parses two-word commands with positionals and options", () => {
  const r = parseCommandLine(["project", "add", "demo-shop", "--owner", "acme", "--dry-run", "--json"]);
  assert.equal(r.kind, "command");
  assert.equal(r.cmd.spec.name, "project add");
  assert.deepEqual(r.cmd.positionals, ["demo-shop"]);
  assert.equal(r.cmd.values.owner, "acme");
  assert.equal(r.cmd.values["dry-run"], true);
  assert.equal(r.cmd.values.json, true);
});

test("parses one-word commands, short flags and global options", () => {
  const r = parseCommandLine(["logs", "-f", "-n", "50", "-p", "demo-shop", "--home", "/srv/mm"]);
  assert.equal(r.cmd.spec.name, "logs");
  assert.equal(r.cmd.values.follow, true);
  assert.equal(r.cmd.values.lines, "50");
  assert.equal(r.cmd.values.project, "demo-shop");
  assert.equal(r.cmd.values.home, "/srv/mm");
  assert.equal(parseCommandLine(["stop", "--wait-reflection", "-y"]).cmd.values.yes, true);
  assert.equal(parseCommandLine(["reflect", "now", "--project", "x"]).cmd.spec.name, "reflect now");
});

test("help, version and group help", () => {
  assert.deepEqual(parseCommandLine([]), { kind: "help", topic: null });
  assert.deepEqual(parseCommandLine(["-h"]), { kind: "help", topic: null });
  assert.deepEqual(parseCommandLine(["--version"]), { kind: "version" });
  assert.deepEqual(parseCommandLine(["project"]), { kind: "help", topic: "project" });
  assert.deepEqual(parseCommandLine(["project", "add", "-h"]), { kind: "help", topic: "project add" });
  assert.deepEqual(parseCommandLine(["help", "model", "set"]), { kind: "help", topic: "model set" });
  for (const c of COMMANDS) assert.match(helpText(c.name, "1.0.0"), new RegExp(`memmem-server ${c.name}`));
  assert.match(helpText(null, "1.0.0"), /project add <name>/);
  assert.match(helpText("project", "1.0.0"), /project remove <name>/);
});

test("rejects unknown commands, unknown flags and wrong arity", () => {
  assert.throws(() => parseCommandLine(["bogus"]), UsageError);
  assert.throws(() => parseCommandLine(["project", "bogus"]), /unknown command: project bogus/);
  assert.throws(() => parseCommandLine(["status", "--bogus"]), /Unknown option/);
  assert.throws(() => parseCommandLine(["project", "add"]), /needs <name>/);
  assert.throws(() => parseCommandLine(["project", "add", "a", "b"]), /unexpected argument: b/);
  assert.throws(() => parseCommandLine(["start", "extra"]), /unexpected argument/);
});

test("intOpt validates integers", () => {
  assert.equal(intOpt(undefined, "n", 200), 200);
  assert.equal(intOpt("5", "n", 200), 5);
  assert.throws(() => intOpt("x", "n", 200), /--n must be an integer/);
  assert.throws(() => intOpt("0", "port", 4500, 1), /--port/);
});
