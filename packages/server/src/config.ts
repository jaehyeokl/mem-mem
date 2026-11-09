// Worker configuration: projects.json plus environment overrides.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LANGUAGE, isMemoryLanguage, MEMORY_LANGUAGES } from "./language.js";
import { serverPaths } from "./paths.js";

export interface Settings {
  /** Letta step-count dreaming: one ingest turn = one step. */
  stepCount: number;
  /** Local hour (0-23, process TZ) for the daily forced reflection; null disables it. */
  dailyReflectHour: number | null;
  /** Upper bound for one ingest turn's text; longer sessions are split into parts. */
  ingestMaxChars: number;
  /** Per-message cap inside the ingest text. */
  messageMaxChars: number;
  /** How long one pass waits for a triggered reflection before moving on. */
  reflectionWaitSeconds: number;
  /** Give up on a file after this many failed turns. */
  maxAttemptsPerFile: number;
  /** Project init (bootstrap/<member>/request.json): limit for each init turn (the Letta `init` command, an answer turn). */
  initTimeoutMinutes: number;
  /** Project init: at most this many past sessions are laid out for Letta (the newest are kept). */
  initMaxSessions: number;
  /** Project init: model handle named for the history-analysis subagents; null means the agent's current model. */
  initHistoryModel: string | null;
}

export interface ProjectConfig {
  project: string;
  agentId: string;
  memoryRepo: string;
  transcriptsRepo: string;
  model?: string;
  createdAt?: string;
  /** Set false to pause a project without removing it. */
  enabled?: boolean;
  /** Language the memory is written in (`en` | `ko`); entries without one are `en`. */
  language: string;
}

export interface WorkerConfig {
  configPath: string;
  settings: Settings;
  projects: ProjectConfig[];
  appServerUrl: string;
  stateDir: string;
  reposDir: string;
  pollSeconds: number;
  lettaConfigDir: string;
  transcriptRoot: string;
  cwdBase: string;
  /** One-shot requests from the CLI (`reflect now/retry`) to the running worker. */
  requestsDir: string;
  /** Where init lays out past sessions for Letta's /init (`letta trajectories export` default: /tmp/letta-trajectories). */
  initTrajectoriesDir: string;
  once: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  stepCount: 3,
  dailyReflectHour: 23,
  ingestMaxChars: 40_000,
  messageMaxChars: 1_500,
  reflectionWaitSeconds: 240,
  maxAttemptsPerFile: 5,
  initTimeoutMinutes: 60,
  initMaxSessions: 200,
  initHistoryModel: null,
};

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** `$MEMMEM_CONFIG`, else `<server home>/projects.json` (see paths.ts). */
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return serverPaths(env).configPath;
}

function num(value: unknown, name: string, min: number, max: number): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be a number in [${min}, ${max}] (got ${JSON.stringify(value)})`);
  }
  return n;
}

export function parseSettings(raw: unknown): Settings {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (s.stepCount !== undefined) out.stepCount = Math.floor(num(s.stepCount, "settings.stepCount", 1, 1000));
  if (s.dailyReflectHour !== undefined) {
    out.dailyReflectHour =
      s.dailyReflectHour === null ? null : Math.floor(num(s.dailyReflectHour, "settings.dailyReflectHour", 0, 23));
  }
  if (s.ingestMaxChars !== undefined) out.ingestMaxChars = Math.floor(num(s.ingestMaxChars, "settings.ingestMaxChars", 2_000, 1_000_000));
  if (s.messageMaxChars !== undefined) out.messageMaxChars = Math.floor(num(s.messageMaxChars, "settings.messageMaxChars", 100, 100_000));
  if (s.reflectionWaitSeconds !== undefined) {
    out.reflectionWaitSeconds = Math.floor(num(s.reflectionWaitSeconds, "settings.reflectionWaitSeconds", 0, 3600));
  }
  if (s.maxAttemptsPerFile !== undefined) out.maxAttemptsPerFile = Math.floor(num(s.maxAttemptsPerFile, "settings.maxAttemptsPerFile", 1, 100));
  if (s.initTimeoutMinutes !== undefined) out.initTimeoutMinutes = num(s.initTimeoutMinutes, "settings.initTimeoutMinutes", 0.05, 24 * 60);
  if (s.initMaxSessions !== undefined) out.initMaxSessions = Math.floor(num(s.initMaxSessions, "settings.initMaxSessions", 0, 100_000));
  if (s.initHistoryModel !== undefined) {
    if (s.initHistoryModel !== null && (typeof s.initHistoryModel !== "string" || !s.initHistoryModel.trim())) {
      throw new ConfigError("settings.initHistoryModel must be a model handle or null");
    }
    out.initHistoryModel = s.initHistoryModel === null ? null : (s.initHistoryModel as string).trim();
  }
  return out;
}

export function parseProjects(raw: unknown): ProjectConfig[] {
  if (!Array.isArray(raw)) throw new ConfigError("projects must be an array");
  const seen = new Set<string>();
  return raw.map((p, i) => {
    if (!p || typeof p !== "object") throw new ConfigError(`projects[${i}] must be an object`);
    const o = p as Record<string, unknown>;
    for (const key of ["project", "agentId", "memoryRepo", "transcriptsRepo"] as const) {
      if (typeof o[key] !== "string" || (o[key] as string).trim() === "") {
        throw new ConfigError(`projects[${i}].${key} is required`);
      }
    }
    const project = o.project as string;
    if (o.language !== undefined && !isMemoryLanguage(o.language)) {
      throw new ConfigError(`projects[${i}].language must be one of ${MEMORY_LANGUAGES.join(", ")} (got ${JSON.stringify(o.language)})`);
    }
    if (!PROJECT_NAME.test(project)) throw new ConfigError(`projects[${i}].project has invalid characters: ${project}`);
    if (seen.has(project)) throw new ConfigError(`duplicate project: ${project}`);
    seen.add(project);
    return {
      project,
      agentId: o.agentId as string,
      memoryRepo: o.memoryRepo as string,
      transcriptsRepo: o.transcriptsRepo as string,
      model: typeof o.model === "string" ? o.model : undefined,
      createdAt: typeof o.createdAt === "string" ? o.createdAt : undefined,
      enabled: o.enabled === false ? false : true,
      language: (o.language as string | undefined) ?? DEFAULT_LANGUAGE,
    };
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const configPath = resolveConfigPath(env);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new ConfigError(`cannot read config ${configPath}: ${(err as Error).message}`);
  }
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const paths = serverPaths(env);
  const lettaConfigDir = paths.lettaConfigDir;
  return {
    configPath,
    settings: parseSettings(obj.settings),
    projects: parseProjects(obj.projects ?? []),
    appServerUrl: env.MEMMEM_APP_SERVER_URL || `ws://127.0.0.1:${env.LETTA_APP_SERVER_PORT || "4500"}`,
    stateDir: paths.stateDir,
    reposDir: paths.reposDir,
    pollSeconds: env.MEMMEM_POLL_SECONDS ? num(env.MEMMEM_POLL_SECONDS, "MEMMEM_POLL_SECONDS", 1, 86_400) : 60,
    lettaConfigDir,
    transcriptRoot: env.LETTA_TRANSCRIPT_ROOT || join(lettaConfigDir, "transcripts"),
    cwdBase: paths.cwdBase,
    requestsDir: paths.requestsDir,
    initTrajectoriesDir: env.MEMMEM_INIT_TRAJECTORIES_DIR || "/tmp/letta-trajectories",
    once: env.MEMMEM_ONCE === "1" || env.MEMMEM_ONCE === "true",
  };
}

/** Working directory handed to the project's App Server sessions. */
export function projectCwd(cfg: WorkerConfig, project: string): string {
  return join(cfg.cwdBase, project);
}
