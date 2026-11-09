#!/usr/bin/env node
// Build single-file executables with `bun build --compile` (bun is a build
// tool only; users never see it). Output: dist/memmem-<os>-<arch>[.exe], the
// names install.sh / install.ps1 download from GitHub Releases.
//   node scripts/build-bin.mjs              all five targets
//   node scripts/build-bin.mjs --host       this machine's target only
//   node scripts/build-bin.mjs linux-x64 darwin-arm64
// $BUN selects the bun executable (default: `bun` on PATH).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TARGETS = {
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "darwin-x64": "bun-darwin-x64",
  "darwin-arm64": "bun-darwin-arm64",
  "windows-x64": "bun-windows-x64",
};

const hostName = () => `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;

const argv = process.argv.slice(2);
let names = argv.filter((a) => !a.startsWith("--"));
if (argv.includes("--host")) names = [hostName()];
if (!names.length) names = Object.keys(TARGETS);
for (const n of names) if (!TARGETS[n]) { console.error(`unknown target ${n}; one of ${Object.keys(TARGETS).join(", ")}`); process.exit(2); }

const bun = process.env.BUN || "bun";
const embed = spawnSync(process.execPath, [path.join(CLIENT, "scripts", "embed-assets.mjs")], { stdio: "inherit" });
if (embed.status !== 0) process.exit(embed.status ?? 1);
fs.mkdirSync(path.join(CLIENT, "dist"), { recursive: true });
for (const n of names) {
  const out = path.join("dist", `memmem-${n}${n.startsWith("windows") ? ".exe" : ""}`);
  const args = ["build", "--compile", "--minify", `--target=${TARGETS[n]}`, "--define", "__MEMMEM_COMPILED__=true", "./bin/memmem.mjs", "--outfile", out];
  console.log(`${bun} ${args.join(" ")}`);
  const r = spawnSync(bun, args, { cwd: CLIENT, stdio: "inherit" });
  if (r.status !== 0) { console.error(`build failed for ${n}`); process.exit(r.status ?? 1); }
}
