// The memory-repo and transcripts-repo templates. memory-repo has one
// directory per memory language (memory-repo/en, memory-repo/ko); folder names
// and frontmatter keys are English in both.
//
// Resolution order: $MEMMEM_TEMPLATES, then <package>/templates (the copy that
// `npm pack` puts into the published package, see scripts/copy-templates.mjs),
// then <repo>/templates (a repo checkout: packages/server/../../templates).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** dist/cli/templates.js -> package root. */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function templateCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const pkg = packageRoot();
  return [env.MEMMEM_TEMPLATES, join(pkg, "templates"), resolve(pkg, "..", "..", "templates")].filter((d): d is string => !!d);
}

export function resolveTemplatesDir(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of templateCandidates(env)) {
    if (existsSync(join(dir, "memory-repo")) && existsSync(join(dir, "transcripts-repo"))) return dir;
  }
  return null;
}

/** The memory-repo template for `language`: `memory-repo/<language>`, or null when it has no MEMORY.md. */
export function memoryTemplateDir(templates: string, language: string): string | null {
  const dir = join(templates, "memory-repo", language);
  return existsSync(join(dir, "MEMORY.md")) ? dir : null;
}

/** Every regular file under `dir`, relative, sorted. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === ".git") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

/** Replace every `{{KEY}}` (literal, no regex or `$&` surprises). */
export function render(text: string, vars: Record<string, string>): string {
  let s = text;
  for (const [k, v] of Object.entries(vars)) s = s.split(`{{${k}}}`).join(v);
  return s;
}

/** Copy `src` to `dest`, rendering placeholders; `skip(rel)` leaves files out. Returns the relative paths written. */
export function renderTree(src: string, dest: string, vars: Record<string, string>, skip: (rel: string) => boolean = () => false): string[] {
  const written: string[] = [];
  for (const rel of listFiles(src)) {
    if (skip(rel)) continue;
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, render(readFileSync(join(src, rel), "utf8"), vars));
    written.push(rel);
  }
  return written;
}

/** The example decision documents the format only; it must not become memory. */
export function isExampleDecision(rel: string): boolean {
  return /^decisions\/EXAMPLE-[^/]*\.md$/.test(rel.split("\\").join("/"));
}
