// `memmem remember "<text>"`: write an explicit note to inbox/<member>/ and push.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactString } from "./secrets.mjs";
import { commitAndPush, ensureClone, findConfig, log, preparePull, projectPaths, repoUrl, withLock } from "./util.mjs";

/**
 * ASCII-only slug (non-ASCII file names break across macOS NFD / Linux NFC
 * checkouts). Text without ASCII words, e.g. Korean, gets `note-<hash>`.
 */
export function slugify(text) {
  const s = text.normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  if (s.length >= 3) return s;
  return `note-${createHash("sha1").update(text).digest("hex").slice(0, 8)}`;
}

export function noteBody({ member, project, created, text }) {
  return `---\nmember: ${member}\nproject: ${project}\ncreated: ${created}\nsource: manual\n---\n\n${text.trim()}\n`;
}

export function runRemember(args) {
  let text = args._.join(" ");
  if (text === "-" || (!text && !process.stdin.isTTY)) text = fs.readFileSync(0, "utf8");
  if (!text.trim()) { process.stderr.write('usage: memmem remember "<text>"  (or: memmem remember - < file)\n'); return 2; }
  const found = findConfig(args.cwd || process.cwd());
  if (!found) { process.stderr.write("memmem remember: not a team project (no .memmem/config.json). Run `memmem setup` first.\n"); return 1; }
  const paths = projectPaths(found.config, found.dir);
  const counts = {};
  const clean = redactString(text, counts);
  const cl = ensureClone(repoUrl(found.config.transcriptsRepo), paths.transcripts);
  if (!cl.ok) { process.stderr.write(`memmem remember: cannot clone transcripts repo: ${cl.error}\n`); return 1; }
  const now = new Date();
  try {
    return withLock(paths.lock, () => {
      preparePull(paths.transcripts, paths.member);
      const dir = path.join(paths.transcripts, "inbox", paths.member);
      fs.mkdirSync(dir, { recursive: true });
      const base = `${now.toISOString().slice(0, 10)}-${slugify(clean.replace(/\[REDACTED:[^\]]*\]/g, " "))}`;
      let name = `${base}.md`;
      for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base}-${i}.md`;
      fs.writeFileSync(path.join(dir, name), noteBody({ member: paths.member, project: paths.project, created: now.toISOString(), text: clean }));
      const rel = path.posix.join("inbox", paths.member, name);
      const res = commitAndPush(paths.transcripts, [rel], `remember: ${paths.member}: ${clean.trim().split("\n")[0].slice(0, 60)}`, { member: paths.member });
      const redacted = Object.values(counts).reduce((a, b) => a + b, 0);
      log(paths, "remember", `${rel} pushed=${res.ok}${redacted ? ` redactions=${redacted}` : ""}`);
      if (!res.ok) {
        process.stderr.write(`memmem remember: saved locally but push failed (will retry on next sync): ${res.error}\n`);
        process.stdout.write(`${path.join(paths.transcripts, rel)}\n`);
        return 1;
      }
      if (redacted) process.stderr.write(`memmem remember: redacted ${redacted} secret-like value(s)\n`);
      process.stdout.write(`${path.join(paths.transcripts, rel)}\n`);
      return 0;
    });
  } catch (e) {
    process.stderr.write(`memmem remember: ${e.message}\n`);
    return 1;
  }
}
