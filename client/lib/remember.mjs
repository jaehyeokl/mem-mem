// `memmem remember "<text>"`: write an explicit note to inbox/<member>/ and push.
// When the data folder cannot be written (the `codex exec` sandbox makes it
// read-only), the redacted note goes to <project>/.memmem/outbox/ instead;
// `sync` (run by the hooks, outside the sandbox) and the next successful
// `remember` move outbox notes into inbox/<member>/ and push them.
// In a linked git worktree the outbox is the worktree's own (the folder a
// sandbox lets the session write); both it and the main checkout's are flushed.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactString } from "./secrets.mjs";
import { commitAndPush, CONFIG_DIR, ensureClone, findConfig, log, OUTBOX_DIR, preparePull, projectPaths, repoUrl, withLock } from "./util.mjs";

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

/** Folders whose `.memmem/outbox/` belongs to this project: the worktree the command runs in (if any), then the main checkout. */
export function outboxDirs(found) {
  return [...new Set([found.checkout, found.dir].filter(Boolean))];
}

/** Notes waiting in `<dir>/.memmem/outbox/`, sorted. */
export function outboxNotes(dir) {
  try { return fs.readdirSync(path.join(dir, OUTBOX_DIR)).filter((n) => n.endsWith(".md")).sort(); } catch { return []; }
}

/**
 * Copy outbox notes of `projectDirs` into the transcripts clone's
 * inbox/<member>/ (call inside the lock). A note whose exact text is already
 * there (copied before, but the outbox file was not removed) is not copied
 * again. Returns { rels, sources }: the repo paths to commit and the outbox
 * files to delete once committed.
 */
export function moveOutbox(projectDirs, paths) {
  const rels = [], sources = [];
  const inbox = path.join(paths.transcripts, "inbox", paths.member);
  for (const projectDir of [].concat(projectDirs)) for (const n of outboxNotes(projectDir)) {
    const dir = path.join(projectDir, OUTBOX_DIR);
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

/**
 * Delete outbox files once their notes are committed in the transcripts clone;
 * drop empty outbox folders, and a worktree's then-empty `.memmem/` (rmdir
 * only; never the main checkout's).
 */
function clearOutbox(found, sources) {
  for (const f of sources) fs.rmSync(f, { force: true });
  for (const d of outboxDirs(found)) {
    try { fs.rmdirSync(path.join(d, OUTBOX_DIR)); } catch { continue; /* not empty or absent */ }
    if (d !== found.dir) { try { fs.rmdirSync(path.join(d, CONFIG_DIR)); } catch { /* not empty */ } }
  }
}

/**
 * `sync`'s part: upload the outbox notes of this checkout and the main one, if
 * any (no clone, lock, or network otherwise). Returns { moved, ok }.
 */
export function flushOutbox(found, paths) {
  const dirs = outboxDirs(found);
  if (!dirs.some((d) => outboxNotes(d).length)) return { moved: 0, ok: true };
  const config = found.config;
  const cl = ensureClone(repoUrl(config.transcriptsRepo), paths.transcripts);
  if (!cl.ok) { log(paths, "outbox", `clone transcripts repo failed: ${cl.error}`); return { moved: 0, ok: false }; }
  return withLock(paths.lock, () => {
    preparePull(paths.transcripts, paths.member);
    const { rels, sources } = moveOutbox(dirs, paths);
    if (!rels.length) return { moved: 0, ok: true };
    const res = commitAndPush(paths.transcripts, rels, `remember: ${paths.member}: ${rels.length} queued note(s)`, { member: paths.member });
    if (res.ok || res.committed) clearOutbox(found, sources);
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
    // The checkout the session runs in first (a sandbox lets it write there), then the main checkout.
    const tried = [];
    for (const d of outboxDirs(found)) {
      const outbox = path.join(d, OUTBOX_DIR);
      try {
        fs.mkdirSync(outbox, { recursive: true });
        const file = path.join(outbox, freeName(outbox, base));
        fs.writeFileSync(file, body);
        if (redacted) process.stderr.write(`memmem remember: redacted ${redacted} secret-like value(s)\n`);
        process.stdout.write(`queued ${file}: the data folder is read-only here (sandbox); it uploads at the next sync\n`);
        return 0;
      } catch (e) { tried.push(`${outbox}: ${e.message}`); }
    }
    process.stderr.write(`memmem remember: NOT saved: the data folder ${paths.root} is read-only here and the note could not be queued either (${tried.join("; ")})\n`);
    return 1;
  }
  const cl = ensureClone(repoUrl(found.config.transcriptsRepo), paths.transcripts);
  if (!cl.ok) { process.stderr.write(`memmem remember: cannot clone transcripts repo: ${cl.error}\n`); return 1; }
  try {
    return withLock(paths.lock, () => {
      preparePull(paths.transcripts, paths.member);
      const queued = moveOutbox(outboxDirs(found), paths);
      const dir = path.join(paths.transcripts, "inbox", paths.member);
      fs.mkdirSync(dir, { recursive: true });
      const name = freeName(dir, base);
      fs.writeFileSync(path.join(dir, name), body);
      const rel = path.posix.join("inbox", paths.member, name);
      const res = commitAndPush(paths.transcripts, [rel, ...queued.rels], `remember: ${paths.member}: ${clean.trim().split("\n")[0].slice(0, 60)}`, { member: paths.member });
      if (res.ok || res.committed) clearOutbox(found, queued.sources);
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
