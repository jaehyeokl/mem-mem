// Service files for `memmem-server start --install-service`. Rendering is
// pure (tested); writing prints how to enable, it never enables by itself.
import { homedir } from "node:os";
import { join } from "node:path";

export const SERVICE_NAME = "memmem-server";
export const LAUNCHD_LABEL = "dev.memmem.server";

export interface ServiceSpec {
  /** Absolute path of node. */
  node: string;
  /** Absolute path of bin/memmem-server.js. */
  bin: string;
  env: Record<string, string>;
  /** Data root (logs for launchd). */
  home: string;
}

function systemdEscape(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

export function renderSystemdUnit(s: ServiceSpec): string {
  const env = Object.entries(s.env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `Environment=${systemdEscape(`${k}=${v}`)}`);
  return [
    "[Unit]",
    "Description=mem-mem server (Letta Code App Server + ingest worker)",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${systemdEscape(s.node)} ${systemdEscape(s.bin)} start --foreground`,
    "ExecReload=/bin/kill -HUP $MAINPID",
    "Restart=on-failure",
    "RestartSec=10",
    "# The worker finishes the current turn on SIGTERM (up to 30 s).",
    "TimeoutStopSec=60",
    "KillMode=mixed",
    ...env,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function xml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderLaunchdPlist(s: ServiceSpec): string {
  const env = Object.entries(s.env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(s.node)}</string>
      <string>${xml(s.bin)}</string>
      <string>start</string>
      <string>--foreground</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ExitTimeOut</key>
    <integer>60</integer>
    <key>StandardOutPath</key>
    <string>${xml(join(s.home, "logs", "server.out"))}</string>
    <key>StandardErrorPath</key>
    <string>${xml(join(s.home, "logs", "server.out"))}</string>
  </dict>
</plist>
`;
}

export function systemdUnitPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "systemd", "user", `${SERVICE_NAME}.service`);
}

export function launchdPlistPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME || homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

/** Environment the service needs: PATH (node, letta, git, gh) and the server's own dirs. */
export function serviceEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "MEMMEM_SERVER_HOME", "LETTA_CONFIG_DIR", "LETTA_APP_SERVER_PORT", "MEMMEM_POLL_SECONDS", "MEMMEM_CONFIG", "MEMMEM_GIT_CONFIG", "GH_CONFIG_DIR", "TZ", "HOME"]) {
    const v = env[k];
    if (v) out[k] = v;
  }
  return out;
}
