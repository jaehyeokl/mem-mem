// SessionStart context: a short intro (English or Korean, per config.language = the project's memory
// language, which the intro names; the agent talks to the user in the user's language) + root MEMORY.md + root core files
// + one index section per first-level folder (`<folder>/MEMORY.md`).
// Individual files inside folders are not injected; the model reads them on demand.
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_MAX_CHARS = 24_000;
export const MAX_CHARS_ENV = "MEMMEM_CONTEXT_MAX_CHARS";
// persona.md is the server-side memory agent's persona ("one-sentence replies", ingest rules).
// Injected into a coding session it would read as instructions, so it is left out.
const EXCLUDED_CORE = new Set(["memory.md", "persona.md"]);
const PINNED_CORE = ["project.md", "human.md"];

export function maxCharsFromEnv(env = process.env) {
  const n = Number(env[MAX_CHARS_ENV]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_CHARS;
}

function read(file) {
  try { return fs.readFileSync(file, "utf8").trim(); } catch { return null; }
}

const hasFrontmatter = (body) => /^---\r?\n/.test(body);

/** Root core files in injection order: project.md, human.md, then other root .md files with frontmatter. */
export function coreFiles(memDir) {
  let names = [];
  try { names = fs.readdirSync(memDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); } catch { return []; }
  const md = names.filter((n) => n.toLowerCase().endsWith(".md") && !EXCLUDED_CORE.has(n.toLowerCase()));
  const pinned = PINNED_CORE.filter((n) => md.includes(n));
  const others = md
    .filter((n) => !PINNED_CORE.includes(n) && hasFrontmatter(read(path.join(memDir, n)) ?? ""))
    .sort((a, b) => a.localeCompare(b));
  return [...pinned, ...others];
}

/**
 * First-level folders that have a MEMORY.md, in the order the root MEMORY.md first
 * mentions them (`decisions/`), then the rest alphabetically.
 */
export function indexFolders(memDir, rootIndex = read(path.join(memDir, "MEMORY.md")) ?? "") {
  let dirs = [];
  try {
    dirs = fs.readdirSync(memDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && fs.existsSync(path.join(memDir, e.name, "MEMORY.md")))
      .map((e) => e.name);
  } catch { return []; }
  const pos = (d) => { const i = rootIndex.indexOf(`${d}/`); return i < 0 ? Infinity : i; };
  return dirs.sort((a, b) => pos(a) - pos(b) || a.localeCompare(b));
}

const INTRO = {
  en: ({ project, memDir }) => [
    `This project (${project}) has a shared team memory. Local copy: \`${memDir}\`.`,
    `This memory is written in English. Talk to the user in their own language.`,
    `Below are its index (MEMORY.md), the root core files, and one index per folder (\`## <folder>/ (index)\`). Index entries point to files under that path (links in a folder index are relative to that folder).`,
    `The folder is hidden and git-ignored, so file search such as rg or glob does not list it unless hidden and ignored files are included.`,
    `When it is relevant to the task, read the file directly by its path from the index (for example with cat or the Read tool). Check past decisions and their reasons there instead of guessing.`,
    `Never edit files under this path: the server updates the team memory from session transcripts, and when the user says "remember" or "기억해", record it with \`memmem remember\` (the remember skill).`,
  ],
  ko: ({ project, memDir }) => [
    `이 프로젝트(${project})에는 팀 메모리가 있다. 로컬 사본: \`${memDir}\`.`,
    `이 메모리는 한국어로 기록된다. 사용자와는 사용자의 언어로 대화하라.`,
    `아래는 그 색인(MEMORY.md), 루트 핵심 파일, 폴더별 색인(\`## <폴더>/ (index)\`)이다. 색인 항목은 이 경로 아래 파일을 가리킨다(폴더 색인의 링크는 그 폴더 기준).`,
    `이 폴더는 숨김이고 git에서 무시되므로 rg나 glob 같은 파일 검색에는 숨김·무시 파일을 포함하지 않는 한 나오지 않는다.`,
    `작업과 관련 있으면 색인의 경로로 해당 파일을 직접 읽어라(예: cat, Read 도구). 과거 결정이나 이유를 추측하지 말고 먼저 확인해라.`,
    `이 경로의 파일은 직접 수정하지 마라: 팀 메모리는 세션 기록으로 서버가 갱신하고, 사용자가 "기억해"나 "remember"라고 하면 \`memmem remember\`(remember 스킬)로 남긴다.`,
  ],
};

// User mode: there is no remember skill or AGENTS.md block, so the intro's last sentence
// points at the per-checkout guide and names the init skill instead.
const POINTER = {
  en: ({ guide, skill }) => `Never edit files under this path: the server updates the team memory from session transcripts. When the user asks to remember or record something for the team ("remember this", "기억해"), read \`${guide}\` and follow it. To initialize the team memory or add past sessions, the user runs ${skill}.`,
  ko: ({ guide, skill }) => `이 경로의 파일은 직접 수정하지 마라: 팀 메모리는 세션 기록으로 서버가 갱신한다. 사용자가 팀을 위해 무언가를 기억하거나 기록하라고 하면("기억해", "remember") \`${guide}\`를 읽고 그대로 따르라. 팀 메모리 초기화나 과거 세션 추가는 사용자가 ${skill}로 한다.`,
};

const TRUNCATED = {
  en: { core: (name) => `(truncated; read \`${name}\` for the full file)`, folder: (dir) => `(truncated; read \`${dir}/MEMORY.md\` for the rest of the list)` },
  ko: { core: (name) => `(잘림. 전체는 \`${name}\`를 직접 읽어라)`, folder: (dir) => `(잘림. 나머지 목록은 \`${dir}/MEMORY.md\`를 직접 읽어라)` },
};

const lang = (language) => (language === "ko" ? "ko" : "en");

/** The intro; with `guide` (user mode) its last sentence is the guide pointer for `tool`. */
export function intro({ project, memDir, language = "en", guide = "", tool = "claude-code" }) {
  const lines = INTRO[lang(language)]({ project, memDir });
  if (guide) lines[lines.length - 1] = POINTER[lang(language)]({ guide, skill: tool === "codex" ? "$memmem-init" : "/memmem-init" });
  return lines.join(" ");
}

/** Cut `body` to at most `limit` chars, preferring a line boundary. */
function cut(body, limit) {
  if (limit <= 0) return "";
  if (body.length <= limit) return body;
  const head = body.slice(0, limit);
  const nl = head.lastIndexOf("\n");
  return (nl > 0 ? head.slice(0, nl) : head).trimEnd();
}

const render = (s) => `\n## ${s.title}\n\n${s.body}\n`;

/**
 * Assemble the context string. Budget: `maxChars`. When over budget, folder index
 * sections are truncated first (last section first), then core files (last first).
 * The intro and root MEMORY.md are never truncated, so the result can exceed
 * `maxChars` only when those two alone do. Truncation notes use clone-relative paths
 * (the intro names the clone).
 */
export function buildContext({ project, memDir, maxChars = DEFAULT_MAX_CHARS, language = "en", notice = "", guide = "", tool = "claude-code" }) {
  // `notice`: one line about the team-memory init state (see hooks.mjs initNotice), first and never truncated.
  // `guide` (user mode): the remember guide the intro points at; part of the never-truncated head.
  const head = (notice ? `${notice}\n\n` : "") + intro({ project, memDir, language, guide, tool }) + "\n";
  const T = TRUNCATED[lang(language)];
  const rootIndex = read(path.join(memDir, "MEMORY.md"));
  const sections = [];
  if (rootIndex !== null) sections.push({ title: "MEMORY.md", body: rootIndex, kind: "root" });
  for (const name of coreFiles(memDir)) {
    const body = read(path.join(memDir, name));
    if (body !== null) sections.push({ title: name, body, kind: "core",
      note: T.core(name) });
  }
  for (const dir of indexFolders(memDir, rootIndex ?? "")) {
    const body = read(path.join(memDir, dir, "MEMORY.md"));
    if (body !== null) sections.push({ title: `${dir}/ (index)`, body, kind: "folder",
      note: T.folder(dir) });
  }

  const total = () => head.length + sections.reduce((n, s) => n + render(s).length, 0);
  for (const kind of ["folder", "core"]) {
    for (const s of sections.filter((x) => x.kind === kind).reverse()) {
      const excess = total() - maxChars;
      if (excess <= 0) break;
      const kept = cut(s.body, s.body.length - excess - s.note.length - 2);
      const body = kept ? `${kept}\n\n${s.note}` : s.note;
      if (body.length < s.body.length) s.body = body; // a tiny section is not worth a longer note
    }
  }
  return head + sections.map(render).join("");
}
