// `memmem remember "<text>"`: write an explicit note to inbox/<member>/ and push.
// When the data folder cannot be written (the `codex exec` sandbox makes it
// read-only), the redacted note goes to <project>/.memmem/outbox/ instead;
// `sync` (run by the hooks, outside the sandbox) and the next successful
// `remember` move outbox notes into inbox/<member>/ and push them.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactString } from "./secrets.mjs";
import { commitAndPush, ensureClone, findConfig, log, OUTBOX_DIR, preparePull, projectPaths, repoUrl, withLock } from "./util.mjs";

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

/** True when the data folder (transcripts clone, lock, logs) can be written. */
export function dataWritable(paths) {
  try {
    fs.mkdirSync(paths.root, { recursive: true });
    const probe = path.join(paths.root, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.rmSync(probe);
    return true;
  } catch { return false; }
}

/** First `<base>.md`, `<base>-2.md`, ... in `dir` that does not exist. */
function freeName(dir, base) {
  let name = `${base}.md`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base}-${i}.md`;
  return name;
}

/**
 * Copy outbox notes into the transcripts clone's inbox/<member>/ (call inside
 * the lock). A note whose exact text is already there (copied before, but the
 * outbox file was not removed) is not copied again. Returns { rels, sources }:
 * the repo paths to commit and the outbox files to delete once committed.
 */
export function moveOutbox(projectDir, paths) {
  const dir = path.join(projectDir, OUTBOX_DIR);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort(); } catch { return { rels: [], sources: [] }; }
  const inbox = path.join(paths.transcripts, "inbox", paths.member);
  const rels = [], sources = [];
  for (const n of names) {
    const src = path.join(dir, n);
    const text = fs.readFileSync(src, "utf8");
    fs.mkdirSync(inbox, { recursive: true });
    const base = n.slice(0, -3);
    let name = `${base}.md`;
    for (let i = 2; fs.existsSync(path.join(inbox, name)) && fs.readFileSync(path.join(inbox, name), "utf8") !== text; i++) name = `${base}-${i}.md`;
    if (!fs.existsSync(path.join(inbox, name))) fs.writeFileSync(path.join(inbox, name), text);
    rels.push(path.posix.join("inbox", paths.member, name));
    sources.push(src);
  }
  return { rels, sources };
}

/** Delete outbox files once their notes are committed in the transcripts clone; drop the empty outbox folder. */
function clearOutbox(projectDir, sources) {
  for (const f of sources) fs.rmSync(f, { force: true });
  try { fs.rmdirSync(path.join(projectDir, OUTBOX_DIR)); } catch { /* not empty or absent */ }
}

/**
 * `sync`'s part: upload the outbox notes, if any (no clone, lock, or network
 * otherwise). Returns { moved, ok }.
 */
export function flushOutbox(projectDir, paths, config) {
  let names = [];
  try { names = fs.readdirSync(path.join(projectDir, OUTBOX_DIR)).filter((n) => n.endsWith(".md")); } catch { /* none */ }
  if (!names.length) return { moved: 0, ok: true };
  const cl = ensureClone(repoUrl(config.transcriptsRepo), paths.transcripts);
  if (!cl.ok) { log(paths, "outbox", `clone transcripts repo failed: ${cl.error}`); return { moved: 0, ok: false }; }
  return withLock(paths.lock, () => {
    preparePull(paths.transcripts, paths.member);
    const { rels, sources } = moveOutbox(projectDir, paths);
    if (!rels.length) return { moved: 0, ok: true };
    const res = commitAndPush(paths.transcripts, rels, `remember: ${paths.member}: ${rels.length} queued note(s)`, { member: paths.member });
    if (res.ok || res.committed) clearOutbox(projectDir, sources);
    log(paths, "outbox", `${rels.length} note(s) committed=${Boolean(res.ok || res.committed)} pushed=${Boolean(res.ok)}${res.ok ? "" : ` error=${res.error}`}`);
    return { moved: res.ok || res.committed ? rels.length : 0, ok: res.ok };
  });
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
  const now = new Date();
  const base = `${now.toISOString().slice(0, 10)}-${slugify(clean.replace(/\[REDACTED:[^\]]*\]/g, " "))}`;
  const body = noteBody({ member: paths.member, project: paths.project, created: now.toISOString(), text: clean });
  const redacted = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!dataWritable(paths)) {
    const outbox = path.join(found.dir, OUTBOX_DIR);
    try {
      fs.mkdirSync(outbox, { recursive: true });
      const file = path.join(outbox, freeName(outbox, base));
      fs.writeFileSync(file, body);
      if (redacted) process.stderr.write(`memmem remember: redacted ${redacted} secret-like value(s)\n`);
      process.stdout.write(`queued ${file}: the data folder is read-only here (sandbox); it uploads at the next sync\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`memmem remember: the data folder ${paths.root} and ${outbox} are not writable: ${e.message}\n`);
      return 1;
    }
  }
  const cl = ensureClone(repoUrl(found.config.transcriptsRepo), paths.transcripts);
  if (!cl.ok) { process.stderr.write(`memmem remember: cannot clone transcripts repo: ${cl.error}\n`); return 1; }
  try {
    return withLock(paths.lock, () => {
      preparePull(paths.transcripts, paths.member);
      const queued = moveOutbox(found.dir, paths);
      const dir = path.join(paths.transcripts, "inbox", paths.member);
      fs.mkdirSync(dir, { recursive: true });
      const name = freeName(dir, base);
      fs.writeFileSync(path.join(dir, name), body);
      const rel = path.posix.join("inbox", paths.member, name);
      const res = commitAndPush(paths.transcripts, [rel, ...queued.rels], `remember: ${paths.member}: ${clean.trim().split("\n")[0].slice(0, 60)}`, { member: paths.member });
      if (res.ok || res.committed) clearOutbox(found.dir, queued.sources);
      log(paths, "remember", `${rel} pushed=${res.ok}${redacted ? ` redactions=${redacted}` : ""}${queued.rels.length ? ` outbox=${queued.rels.length}` : ""}`);
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
