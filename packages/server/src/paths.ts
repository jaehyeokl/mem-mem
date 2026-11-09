// Where memmem-server keeps its state. Shared by the worker and the CLI.
//
//   $MEMMEM_SERVER_HOME (default $XDG_DATA_HOME/memmem-server, else ~/.local/share/memmem-server)
//     letta/            LETTA_CONFIG_DIR for the server's own Letta state (when LETTA_CONFIG_DIR is unset)
//     projects.json     project <-> agent <-> repos ($MEMMEM_CONFIG overrides)
//     state/            per-project worker state
//     repos/            transcripts repo clones
//     agentcwd/         working directories of the App Server sessions
//     logs/worker.log   the worker's JSON log (also on stdout)
//     gitconfig         GIT_CONFIG_GLOBAL for everything the server runs (identity, credential helper)
//     git-credentials   optional token store (mode 0600) when gh is not used
//     requests/         one-shot requests to the running server (reflect now/retry)
//     server.pid        pid of `memmem-server start`
//     server.json       runtime info written by `start` (port, App Server pid, reload time)
import { homedir } from "node:os";
import { join } from "node:path";

export interface ServerPaths {
  home: string;
  lettaConfigDir: string;
  configPath: string;
  stateDir: string;
  reposDir: string;
  cwdBase: string;
  logsDir: string;
  workerLog: string;
  appServerLog: string;
  gitConfig: string;
  gitCredentials: string;
  requestsDir: string;
  pidFile: string;
  runtimeFile: string;
}

export function serverHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MEMMEM_SERVER_HOME) return env.MEMMEM_SERVER_HOME;
  const base = env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share");
  return join(base, "memmem-server");
}

export function serverPaths(env: NodeJS.ProcessEnv = process.env): ServerPaths {
  const home = serverHome(env);
  const logsDir = join(home, "logs");
  return {
    home,
    lettaConfigDir: env.LETTA_CONFIG_DIR || join(home, "letta"),
    configPath: env.MEMMEM_CONFIG || join(home, "projects.json"),
    stateDir: env.MEMMEM_STATE_DIR || join(home, "state"),
    reposDir: env.MEMMEM_REPOS_DIR || join(home, "repos"),
    cwdBase: env.MEMMEM_CWD || join(home, "agentcwd"),
    logsDir,
    workerLog: env.MEMMEM_LOG_FILE || join(logsDir, "worker.log"),
    appServerLog: join(logsDir, "app-server.log"),
    gitConfig: env.MEMMEM_GIT_CONFIG || join(home, "gitconfig"),
    gitCredentials: join(home, "git-credentials"),
    requestsDir: env.MEMMEM_REQUESTS_DIR || join(home, "requests"),
    pidFile: join(home, "server.pid"),
    runtimeFile: join(home, "server.json"),
  };
}

/**
 * Make `env` the server environment: every Letta call uses the server's own
 * LETTA_CONFIG_DIR, and every git call (ours, the worker's, Letta's MemFS
 * hooks, gh's credential helper setup) uses the server-scoped gitconfig, so
 * the operator's ~/.letta and ~/.gitconfig are never read or written.
 */
export function applyServerEnv(env: NodeJS.ProcessEnv = process.env): ServerPaths {
  const paths = serverPaths(env);
  env.MEMMEM_SERVER_HOME = paths.home;
  env.LETTA_CONFIG_DIR = paths.lettaConfigDir;
  env.GIT_CONFIG_GLOBAL = paths.gitConfig;
  return paths;
}

export const DEFAULT_APP_SERVER_PORT = 4500;

export function appServerPort(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LETTA_APP_SERVER_PORT || DEFAULT_APP_SERVER_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_APP_SERVER_PORT;
}
