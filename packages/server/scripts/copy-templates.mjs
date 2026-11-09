// prepack: copy the repo's templates/ into the package so the published
// tarball is self-contained. In a repo checkout the CLI resolves
// ../../templates directly (see src/cli/templates.ts), so this copy is only
// made for `npm pack` / `npm publish` and removed again by postpack.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(pkg, "..", "..", "templates");
const dest = join(pkg, "templates");
// memory-repo has one directory per memory language (src/language.ts MEMORY_LANGUAGES).
const required = ["memory-repo/en/MEMORY.md", "memory-repo/ko/MEMORY.md", "transcripts-repo/README.md"];
const missing = required.filter((f) => !existsSync(join(src, f)));
if (missing.length) {
  console.error(`copy-templates: ${src} is missing ${missing.join(", ")}`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`copy-templates: ${src} -> ${dest}`);
