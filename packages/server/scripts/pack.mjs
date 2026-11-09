// Build the release tarball memmem-server-<version>.tgz: memmem-server with
// its runtime dependencies bundled (bundleDependencies) and the repo's
// templates/ copied in. It is not published to the npm registry: the release
// workflow attaches it to the GitHub Release (scripts/install-server.sh
// installs it from there) and the Docker image installs the same file.
//
//   node scripts/pack.mjs [dest-dir]      (npm run pack:release)
//
// Why bundled: @letta-ai/letta-agent-sdk declares @letta-ai/letta-code as a
// (non-optional) peer dependency, so `npm i -g` of an unbundled package would
// install a second, nested Letta Code (~1 GB with its dependencies). Bundled
// dependencies are not re-resolved at install time, so the peer is not
// pulled in; operators install Letta Code globally next to memmem-server.
//
// The workspace hoists dependencies to the repo root, where `npm pack` cannot
// bundle them, so this packs from an isolated copy with its own node_modules.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dest = resolve(process.argv[2] ?? pkgDir);
const repoRoot = resolve(pkgDir, "..", "..");
const templates = join(repoRoot, "templates");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (args, cwd) => execFileSync(npm, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });

// The whole templates/ tree is copied: memory-repo/<lang> for every memory language, and transcripts-repo.
for (const f of ["memory-repo/en/MEMORY.md", "memory-repo/ko/MEMORY.md", "transcripts-repo/README.md"]) {
  if (!existsSync(join(templates, f))) throw new Error(`templates incomplete: ${join(templates, f)} not found`);
}
run(["run", "build"], pkgDir);

const work = mkdtempSync(join(tmpdir(), "memmem-server-pack-"));
try {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  delete pkg.scripts.prepack;
  delete pkg.scripts.postpack;
  delete pkg.devDependencies;
  writeFileSync(join(work, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  for (const f of ["README.md", "bin", "config"]) cpSync(join(pkgDir, f), join(work, f), { recursive: true });
  cpSync(join(pkgDir, "dist"), join(work, "dist"), { recursive: true, filter: (src) => !src.endsWith(".map") });
  cpSync(templates, join(work, "templates"), { recursive: true });
  cpSync(join(repoRoot, "LICENSE"), join(work, "LICENSE"));
  run(["install", "--omit=dev", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], work);
  mkdirSync(dest, { recursive: true });
  run(["pack", "--pack-destination", dest], work);
} finally {
  rmSync(work, { recursive: true, force: true });
}
