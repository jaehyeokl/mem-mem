// Init bookkeeping for a fresh project state (a new install, or a wiped state
// file) next to a transcripts repo that already holds a finished init: the
// requests that init handled are marked processed so they do not run again,
// and the sessions its members' manifests list count as already analysed.
// The inputs are bootstrap/status.json and the bootstrap/<member>/request.json
// and manifest.json files of a transcripts clone, with aliases
// (members/*.json) mapped to handles.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INIT_STATUS_PATH, parseRequest, type BootstrapScan, type InitRequestDoc } from "./init.js";
import { aliasMap, readMembers, resolveMember } from "./members.js";
import type { InitProjectRecord, InitStagedSession, ProjectState } from "./state.js";

export interface BootstrapSources {
  /** bootstrap/<member>/request.json documents (member = the directory name). */
  requests: { member: string; path: string; doc: InitRequestDoc }[];
  /** Session ids listed in bootstrap/<member>/manifest.json, by directory name. */
  manifestSessionIds: Record<string, string[]>;
  /** alias -> handle (members/*.json). */
  aliases: Map<string, string>;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : [];
}

/** Read bootstrap/status.json from a clone's working tree (null when missing or not an object). */
export function readStatusFileSync(repoDir: string): Record<string, unknown> | null {
  try {
    const doc = JSON.parse(readFileSync(join(repoDir, INIT_STATUS_PATH), "utf8")) as unknown;
    return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Requests, manifest session ids and aliases from a transcripts clone's working tree. */
export function readBootstrapSources(repoDir: string): BootstrapSources {
  const out: BootstrapSources = { requests: [], manifestSessionIds: {}, aliases: aliasMap(readMembers(repoDir)) };
  let dirs: string[] = [];
  try {
    dirs = readdirSync(join(repoDir, "bootstrap"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return out;
  }
  for (const m of dirs) {
    try {
      const path = `bootstrap/${m}/request.json`;
      out.requests.push({ member: m, path, doc: parseRequest(readFileSync(join(repoDir, path), "utf8")) });
    } catch {
      /* no request, or unreadable */
    }
    try {
      const man = JSON.parse(readFileSync(join(repoDir, "bootstrap", m, "manifest.json"), "utf8")) as { sessions?: unknown };
      if (Array.isArray(man.sessions)) {
        out.manifestSessionIds[m] = man.sessions
          .map((x) => (x && typeof x === "object" ? (x as { sessionId?: unknown }).sessionId : undefined))
          .filter((x): x is string => typeof x === "string" && !!x);
      }
    } catch {
      /* no manifest */
    }
  }
  return out;
}

/**
 * A fresh state (no processed requests and no run) next to a finished init in
 * status.json: mark the requests that run handled as processed (outcome done,
 * its initId), so the worker does not run the init again. Those are the paths
 * status.json names in `requests`, plus any bootstrap/<member>/request.json
 * whose `requestedAt` is not newer than the run's `finishedAt`. A request
 * newer than the run stays pending. Returns the marked paths.
 */
export function markRequestsFromDoneStatus(
  state: ProjectState,
  status: Record<string, unknown> | null | undefined,
  scan: Pick<BootstrapScan, "requests">,
  src: Pick<BootstrapSources, "requests">,
): string[] {
  if (!status || status.state !== "done" || state.init || Object.keys(state.initRequests ?? {}).length) return [];
  const last = status.lastRun && typeof status.lastRun === "object" ? (status.lastRun as Record<string, unknown>) : {};
  const pick = (k: string): string | null => (typeof status[k] === "string" ? (status[k] as string) : typeof last[k] === "string" ? (last[k] as string) : null);
  const finishedAt = pick("finishedAt") ?? pick("updatedAt");
  const initId = pick("initId") ?? undefined;
  const named = new Set(strList(status.requests));
  const done = finishedAt ? Date.parse(finishedAt) : NaN;
  const marked: string[] = [];
  state.initRequests ??= {};
  for (const r of scan.requests) {
    let handled = named.has(r.path);
    if (!handled && Number.isFinite(done)) {
      const at = Date.parse(String(src.requests.find((x) => x.path === r.path)?.doc.requestedAt ?? ""));
      handled = Number.isFinite(at) && at <= done;
    }
    if (!handled) continue;
    state.initRequests[r.path] = { blob: r.blob, processedAt: finishedAt ?? new Date().toISOString(), outcome: "done", ...(initId ? { initId } : {}) };
    marked.push(r.path);
  }
  return marked;
}

/**
 * Seed `state.initStagedSessions` for a state without it (a fresh state whose
 * init record came from status.json): when the project has a completed init
 * and no such map yet, every session listed in a
 * bootstrap/<member>/manifest.json whose member's record is `done` counts as
 * analysed by that member's run. A member with a pending request is skipped
 * (its manifest may already carry sessions no run has seen; re-analysing them
 * is the safe side). Returns the number of seeded sessions, or null when
 * nothing was done (map present, or no completed init).
 */
export function seedInitStagedSessions(
  state: ProjectState,
  rec: InitProjectRecord | null | undefined,
  src: Pick<BootstrapSources, "manifestSessionIds" | "aliases">,
  pendingPaths: Iterable<string> = [],
): number | null {
  if (state.initStagedSessions || !rec?.initializedAt) return null;
  if (!Object.values(rec.members ?? {}).some((e) => e.state === "done")) return null;
  const pending = new Set(pendingPaths);
  const map: Record<string, InitStagedSession> = {};
  for (const [dir, ids] of Object.entries(src.manifestSessionIds ?? {})) {
    if (pending.has(`bootstrap/${dir}/request.json`)) continue;
    const handle = resolveMember(dir, src.aliases);
    const e = rec.members[handle] ?? rec.members[dir];
    if (e?.state !== "done") continue;
    for (const id of ids) map[id] ??= { initId: e.initId, member: handle };
  }
  state.initStagedSessions = map;
  return Object.keys(map).length;
}
