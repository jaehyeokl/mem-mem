// projects.json read/merge/write. The worker re-reads it every pass.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseProjects, parseSettings, type ProjectConfig } from "../config.js";
import type { ServerPaths } from "../paths.js";
import { CliError } from "./io.js";

export interface ProjectEntry {
  project: string;
  agentId: string;
  memoryRepo: string;
  transcriptsRepo: string;
  model?: string;
  createdAt?: string;
  enabled?: boolean;
  /** Memory language (`en` | `ko`); absent means `en`. */
  language?: string;
  [key: string]: unknown;
}

export interface ProjectsFile {
  settings: Record<string, unknown>;
  /** Defaults chosen in setup (not read by the worker). */
  defaults?: { model?: string; reflectionModel?: string };
  projects: ProjectEntry[];
  [key: string]: unknown;
}

export const DEFAULT_FILE_SETTINGS = { stepCount: 3, dailyReflectHour: 23, ingestMaxChars: 40000 };

export function readProjectsFile(paths: ServerPaths): ProjectsFile {
  let raw: string;
  try {
    raw = readFileSync(paths.configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { settings: { ...DEFAULT_FILE_SETTINGS }, projects: [] };
    throw err;
  }
  let obj: ProjectsFile;
  try {
    obj = JSON.parse(raw) as ProjectsFile;
  } catch (err) {
    throw new CliError(`${paths.configPath} is not valid JSON: ${(err as Error).message}`);
  }
  return { ...obj, settings: obj.settings ?? { ...DEFAULT_FILE_SETTINGS }, projects: Array.isArray(obj.projects) ? obj.projects : [] };
}

/** Validate like the worker does, then write atomically. */
export function writeProjectsFile(paths: ServerPaths, file: ProjectsFile): void {
  parseSettings(file.settings);
  parseProjects(file.projects);
  mkdirSync(dirname(paths.configPath), { recursive: true });
  const tmp = `${paths.configPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n");
  renameSync(tmp, paths.configPath);
}

/** Replace (in place) or append the entry, keeping the original createdAt (and enabled, unless given). */
export function upsertProject(file: ProjectsFile, entry: ProjectEntry, now = new Date()): ProjectsFile {
  const prev = file.projects.find((p) => p.project === entry.project);
  const merged: ProjectEntry = {
    ...(prev ?? {}),
    ...entry,
    createdAt: prev?.createdAt ?? entry.createdAt ?? now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  if (prev && prev.enabled === false && entry.enabled === undefined) merged.enabled = false;
  // Replace in place (the worker processes projects in file order); append when new.
  const projects = prev ? file.projects.map((p) => (p.project === entry.project ? merged : p)) : [...file.projects, merged];
  return { ...file, projects };
}

export function findProject(file: ProjectsFile, name: string): ProjectEntry {
  const p = file.projects.find((x) => x.project === name);
  if (!p) throw new CliError(`unknown project: ${name}`, `known: ${file.projects.map((x) => x.project).join(", ") || "(none; memmem-server project add <name>)"}`);
  return p;
}

export function toConfigs(file: ProjectsFile): ProjectConfig[] {
  return parseProjects(file.projects);
}
