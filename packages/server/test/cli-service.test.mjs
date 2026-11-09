import { test } from "node:test";
import assert from "node:assert/strict";
import { launchdPlistPath, renderLaunchdPlist, renderSystemdUnit, serviceEnv, systemdUnitPath } from "../dist/cli/service.js";

const spec = {
  node: "/usr/local/bin/node",
  bin: "/usr/local/lib/node_modules/memmem-server/bin/memmem-server.js",
  env: { PATH: "/usr/local/bin:/usr/bin", MEMMEM_SERVER_HOME: "/home/op/.local/share/memmem-server", LETTA_CONFIG_DIR: "/home/op/.local/share/memmem-server/letta" },
  home: "/home/op/.local/share/memmem-server",
};

test("systemd user unit runs start in the foreground with restart on failure", () => {
  const unit = renderSystemdUnit(spec);
  assert.match(unit, /^\[Unit\]/);
  assert.match(unit, /ExecStart="\/usr\/local\/bin\/node" "\/usr\/local\/lib\/node_modules\/memmem-server\/bin\/memmem-server.js" start --foreground/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /ExecReload=\/bin\/kill -HUP \$MAINPID/);
  assert.match(unit, /Environment="MEMMEM_SERVER_HOME=\/home\/op\/.local\/share\/memmem-server"/);
  assert.match(unit, /Environment="PATH=\/usr\/local\/bin:\/usr\/bin"/);
  assert.match(unit, /WantedBy=default.target/);
  assert.match(renderSystemdUnit({ ...spec, env: { X: 'a "b" 100%' } }), /Environment="X=a \\"b\\" 100%%"/);
});

test("launchd agent keeps the server alive on failure and logs to the data dir", () => {
  const plist = renderLaunchdPlist({ ...spec, env: { ...spec.env, TZ: "Etc/UTC & co" } });
  assert.match(plist, /<string>dev\.memmem\.server<\/string>/);
  assert.match(plist, /<string>start<\/string>\s*<string>--foreground<\/string>/);
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /<string>Etc\/UTC &amp; co<\/string>/);
  assert.match(plist, /logs\/server.out/);
});

test("service paths and env", () => {
  assert.equal(systemdUnitPath({ HOME: "/home/op" }), "/home/op/.config/systemd/user/memmem-server.service");
  assert.equal(systemdUnitPath({ HOME: "/home/op", XDG_CONFIG_HOME: "/cfg" }), "/cfg/systemd/user/memmem-server.service");
  assert.equal(launchdPlistPath({ HOME: "/Users/op" }), "/Users/op/Library/LaunchAgents/dev.memmem.server.plist");
  assert.deepEqual(serviceEnv({ PATH: "/bin", MEMMEM_SERVER_HOME: "/d", SECRET: "x", TZ: "UTC" }), { PATH: "/bin", MEMMEM_SERVER_HOME: "/d", TZ: "UTC" });
});
