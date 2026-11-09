// Team members registered in the transcripts repo (`members/<handle>.json`,
// written by the client's `memmem setup`; design 3.6). The handle is the
// member's GitHub login; `aliases` are older handles whose paths
// (`trajectories/.../<old>/`, `bootstrap/<old>/`, `people/<old>.md`) stay as
// they are. The server maps an alias to its handle for init bookkeeping and
// gives the agent a table of git authors and aliases so it can attribute
// commits and merge people files.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MEMBERS_DIR = "members";

export interface GitAuthor {
  name: string;
  email?: string;
}

export interface MemberRecord {
  handle: string;
  displayName: string;
  gitAuthors: GitAuthor[];
  joinedAt: string | null;
  aliases: string[];
  /** GitHub's numeric account id (`gh api user` .id); fixed across login renames. */
  githubId?: number;
}

/** Two member files with one `githubId`: `handle` (the newer) absorbed `previous` (older handles) as aliases. */
export interface MemberRename {
  githubId: number;
  handle: string;
  previous: string[];
}

const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** One members/<handle>.json document, or null when it is not usable. The file name wins over a missing `handle`. */
export function parseMember(text: string, fileHandle?: string): MemberRecord | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const d = doc as Record<string, unknown>;
  const handle = str(d.handle) || str(fileHandle);
  if (!HANDLE.test(handle)) return null;
  const authors: GitAuthor[] = [];
  for (const a of Array.isArray(d.gitAuthors) ? d.gitAuthors : []) {
    if (!a || typeof a !== "object") continue;
    const name = str((a as Record<string, unknown>).name);
    const email = str((a as Record<string, unknown>).email);
    if (!name && !email) continue;
    if (authors.some((x) => x.name === name && (x.email ?? "") === email)) continue;
    authors.push(email ? { name, email } : { name });
  }
  const aliases = [...new Set((Array.isArray(d.aliases) ? d.aliases : []).map(str).filter((x) => HANDLE.test(x) && x !== handle))];
  const rec: MemberRecord = { handle, displayName: str(d.displayName) || handle, gitAuthors: authors, joinedAt: str(d.joinedAt) || null, aliases };
  const gid = githubIdOf(d.githubId);
  if (gid !== null) rec.githubId = gid;
  return rec;
}

function githubIdOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function absorb(into: MemberRecord, m: MemberRecord): void {
  for (const a of m.gitAuthors) if (!into.gitAuthors.some((x) => x.name === a.name && x.email === a.email)) into.gitAuthors.push(a);
  into.aliases = [...new Set([...into.aliases, ...m.aliases])].filter((a) => a !== into.handle);
}

/** Read members/*.json from a transcripts checkout (sorted by handle; unreadable files are skipped). */
export function readMembers(repoDir: string): MemberRecord[] {
  return readMembersDetailed(repoDir).members;
}

/**
 * readMembers() plus the renames it applied: files that share a `githubId`
 * under different handles are one GitHub account whose login changed. The
 * file with the later `joinedAt` (tie: the lexicographically first handle)
 * keeps the handle; the others become its aliases (even when its `aliases`
 * does not list them) and are not returned as members of their own.
 */
export function readMembersDetailed(repoDir: string): { members: MemberRecord[]; renames: MemberRename[] } {
  let names: string[];
  try {
    names = readdirSync(join(repoDir, MEMBERS_DIR));
  } catch {
    return { members: [], renames: [] };
  }
  const byHandle = new Map<string, MemberRecord>();
  for (const f of names.filter((n) => n.endsWith(".json")).sort()) {
    let text: string;
    try {
      text = readFileSync(join(repoDir, MEMBERS_DIR, f), "utf8");
    } catch {
      continue;
    }
    const m = parseMember(text, f.slice(0, -5));
    if (!m) continue;
    const prev = byHandle.get(m.handle);
    if (prev) {
      // Two files for one handle: merge (the same person on two machines).
      absorb(prev, m);
      if (prev.githubId === undefined && m.githubId !== undefined) prev.githubId = m.githubId;
    } else byHandle.set(m.handle, m);
  }
  const renames: MemberRename[] = [];
  const byId = new Map<number, MemberRecord[]>();
  for (const m of byHandle.values()) if (m.githubId !== undefined) byId.set(m.githubId, [...(byId.get(m.githubId) ?? []), m]);
  for (const [githubId, group] of byId) {
    if (group.length < 2) continue;
    group.sort((a, b) => String(b.joinedAt ?? "").localeCompare(String(a.joinedAt ?? "")) || a.handle.localeCompare(b.handle));
    const [winner, ...older] = group as [MemberRecord, ...MemberRecord[]];
    for (const o of older) {
      absorb(winner, o);
      winner.aliases = [...new Set([...winner.aliases, o.handle])];
      byHandle.delete(o.handle);
    }
    renames.push({ githubId, handle: winner.handle, previous: older.map((o) => o.handle) });
  }
  return { members: [...byHandle.values()].sort((a, b) => a.handle.localeCompare(b.handle)), renames };
}

/** alias -> handle (a registered handle is never treated as an alias of someone else). */
export function aliasMap(members: MemberRecord[]): Map<string, string> {
  const handles = new Set(members.map((m) => m.handle));
  const out = new Map<string, string>();
  for (const m of members) for (const a of m.aliases) if (!handles.has(a) && !out.has(a)) out.set(a, m.handle);
  return out;
}

/** The member handle for a name taken from a path or a request (an alias maps to its handle). */
export function resolveMember(name: string, aliases: Map<string, string>): string {
  return aliases.get(name) ?? name;
}

/**
 * The members table for agent instructions: one line per member with git
 * authors (name and email: this text goes only to the agent, never to logs)
 * and aliases. Empty when no member is registered.
 */
export function membersTableLines(members: MemberRecord[]): string[] {
  if (!members.length) return [];
  const L: string[] = [];
  for (const m of members) {
    const parts: string[] = [];
    for (const a of m.gitAuthors) parts.push(`git author ${a.name || "?"}${a.email ? ` (${a.email})` : ""} = member ${m.handle}`);
    for (const al of m.aliases) parts.push(`old handle ${al} = ${m.handle}`);
    L.push(`- ${m.handle}${m.displayName && m.displayName !== m.handle ? ` (${m.displayName})` : ""}${parts.length ? `: ${parts.join("; ")}` : ""}`);
  }
  return L;
}

/** The members block of the init pre-answer turn and the reflection instruction. */
export function membersInstruction(members: MemberRecord[]): string[] {
  const table = membersTableLines(members);
  if (!table.length) return [];
  const withAliases = members.filter((m) => m.aliases.length);
  const L = [
    "Team members (members/<handle>.json in the transcripts repo; the handle is the GitHub login and the name used in session paths, `Sources:` and people/<handle>.md):",
    ...table,
    "Attribute commits and decisions to member handles with this table: a git author listed here is that member, not an unknown person.",
  ];
  if (withAliases.length) {
    L.push(
      "An old handle (alias) is the same person: if people/<alias>.md exists, merge its content into people/<handle>.md (keep the facts, mention the alias), keep people/<alias>.md as a one-line pointer to people/<handle>.md (do not delete it), and write new records under the handle.",
    );
  }
  return L;
}
