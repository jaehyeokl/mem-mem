// members [--project p]: the team members registered in the transcripts repo
// (members/<handle>.json, written by the client's `memmem setup`) with each
// member's init contribution. Read from the worker's transcripts clone (as of
// its last pass) and the project state; emails are never printed.
import { join } from "node:path";
import { readStatusFileSync } from "../init-recovery.js";
import { aliasMap, readMembers, resolveMember } from "../members.js";
import { loadState, type InitMemberStatus, type InitProjectRecord, type ProjectState } from "../state.js";
import { str } from "./args.js";
import type { Ctx } from "./ctx.js";
import { findProject, readProjectsFile } from "./projects-file.js";

type Values = Record<string, string | boolean | undefined>;

export function transcriptsClone(ctx: Ctx, project: string): string {
  return join(ctx.paths.reposDir, project, "transcripts");
}

/** The project's init record: the state's, else the clone's bootstrap/status.json. */
export function initRecordOf(ctx: Ctx, project: string, st: ProjectState): InitProjectRecord | null {
  if (st.initProject) return st.initProject;
  const doc = readStatusFileSync(transcriptsClone(ctx, project));
  if (!doc) return null;
  return {
    depth: doc.depth === "standard" || doc.depth === "deep" ? doc.depth : null,
    initializedAt: typeof doc.initializedAt === "string" ? doc.initializedAt : null,
    initializedBy: Array.isArray(doc.initializedBy) ? (doc.initializedBy as string[]) : [],
    repos: Array.isArray(doc.repos) ? (doc.repos as string[]) : [],
    members: doc.members && typeof doc.members === "object" ? (doc.members as Record<string, InitMemberStatus>) : {},
  };
}

function contribution(e: InitMemberStatus | undefined): string {
  if (!e) return "not contributed";
  const fail = e.lastFailure ? `  (later ${e.lastFailure.kind} ${e.lastFailure.initId} failed)` : "";
  return `${e.kind} ${e.state}  ${e.sessions} sessions${e.finishedAt ? `  ${e.finishedAt}` : ""}  ${e.initId}${e.uploadedAs ? `  (uploaded as ${e.uploadedAs})` : ""}${fail}`;
}

/** `init status` lines: who initialized at what depth, and one row per member. */
export function renderInitMembers(rec: InitProjectRecord | null): string[] {
  if (!rec) return [];
  const L: string[] = [];
  L.push(
    rec.initializedAt
      ? `project initialized ${rec.initializedAt} by ${rec.initializedBy.join(", ") || "?"}  depth ${rec.depth ?? "unknown"}${rec.repos.length ? `  repos ${rec.repos.join(", ")}` : ""}`
      : "project not initialized yet",
  );
  const rows = Object.entries(rec.members).sort(([a], [b]) => a.localeCompare(b));
  if (rows.length) {
    L.push("members:");
    const w = Math.max(...rows.map(([h]) => h.length));
    for (const [h, e] of rows) L.push(`  ${h.padEnd(w)}  ${contribution(e)}`);
  }
  return L;
}

export interface MemberRow {
  handle: string;
  displayName: string;
  aliases: string[];
  /** Git author names (emails are left out). */
  gitAuthors: string[];
  joinedAt: string | null;
  githubId?: number;
  registered: boolean;
  init: InitMemberStatus | null;
}

export function memberRows(repoDir: string, rec: InitProjectRecord | null): MemberRow[] {
  const members = readMembers(repoDir);
  const aliases = aliasMap(members);
  const status: Record<string, InitMemberStatus> = {};
  for (const [k, e] of Object.entries(rec?.members ?? {})) {
    const h = resolveMember(k, aliases);
    if (!status[h] || String(e.finishedAt ?? "") > String(status[h]!.finishedAt ?? "")) status[h] = e;
  }
  const rows: MemberRow[] = members.map((m) => ({
    handle: m.handle,
    displayName: m.displayName,
    aliases: m.aliases,
    gitAuthors: [...new Set(m.gitAuthors.map((a) => a.name).filter(Boolean))],
    joinedAt: m.joinedAt,
    ...(m.githubId !== undefined ? { githubId: m.githubId } : {}),
    registered: true,
    init: status[m.handle] ?? null,
  }));
  for (const [h, e] of Object.entries(status)) {
    if (!rows.some((r) => r.handle === h)) rows.push({ handle: h, displayName: h, aliases: [], gitAuthors: [], joinedAt: null, registered: false, init: e });
  }
  return rows.sort((a, b) => a.handle.localeCompare(b.handle));
}

export async function cmdMembers(ctx: Ctx, v: Values): Promise<number> {
  const file = readProjectsFile(ctx.paths);
  const only = str(v.project);
  const projects = only ? [findProject(file, only)] : file.projects;
  const out: { project: string; members: MemberRow[] }[] = [];
  for (const p of projects) {
    const st = await loadState(ctx.paths.stateDir, p.project);
    out.push({ project: p.project, members: memberRows(transcriptsClone(ctx, p.project), initRecordOf(ctx, p.project, st)) });
  }
  if (ctx.out.json) {
    ctx.out.data({ projects: out });
    return 0;
  }
  if (!out.length) ctx.out.line("No projects.");
  for (const p of out) {
    ctx.out.line(`${p.project}`);
    if (!p.members.length) {
      ctx.out.line("  no members/*.json in the transcripts clone (members register with `memmem setup`)");
      continue;
    }
    for (const m of p.members) {
      ctx.out.line(`  ${m.handle}${m.displayName !== m.handle ? ` (${m.displayName})` : ""}${m.registered ? "" : "  (not registered)"}`);
      const facts = [
        m.githubId !== undefined ? `githubId ${m.githubId}` : "",
        m.aliases.length ? `aliases ${m.aliases.join(", ")}` : "",
        m.gitAuthors.length ? `git authors ${m.gitAuthors.join(", ")}` : "",
        m.joinedAt ? `joined ${m.joinedAt}` : "",
      ].filter(Boolean);
      if (facts.length) ctx.out.line(`    ${facts.join("  ")}`);
      ctx.out.line(`    init: ${contribution(m.init ?? undefined)}`);
    }
  }
  return 0;
}
