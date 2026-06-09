import { readdirSync, readFileSync, statSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// Read-only knowledge base over a directory of markdown files — a third source
// the agent can ground answers in, alongside the chat corpus (db.ts) and the
// tracker (tracker-db.ts). Pure file IO + substring search, NO LLM: the same
// "dumb middle" as the other read layers.
//
// The KB is TRUSTED, team-authored content (unlike chat), so it's safe to expose
// read-only. But the agent is the injectable component, so `kb_get` is strictly
// path-traversal-guarded: it can ONLY read *.md files inside the configured root.
//
// Config is per-instance (SIMBASCRIBE_KB_PATH) — zero hardcoding, so every company
// instance points at its own KB. Unset/missing degrades gracefully to a clear
// "kb unavailable" error, exactly like the tracker tools (spec §4 independence).

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

// Resource caps so a large/deep/huge-file KB can't hang or OOM the single MCP
// process (which would also starve the corpus + tracker tools). A KB doc is
// human-authored markdown — these bounds are generous for that and reject the
// pathological cases. The KB is trusted, so these are belt-and-suspenders.
const MAX_FILE_BYTES = 1_000_000; // skip a single doc larger than ~1 MB
const MAX_FILES = 2000; // stop walking after this many docs
const MAX_DEPTH = 12; // directory recursion cap

/** True if the file is missing or too large to scan/read. */
function tooLargeOrMissing(abs: string): boolean {
  try {
    return statSync(abs).size > MAX_FILE_BYTES;
  } catch {
    return true;
  }
}

/** A KB document: its path relative to the KB root + a human title. */
export interface KbDoc {
  file: string;
  title: string;
}

/** A search hit: the section that matched, with a citation (file + heading). */
export interface KbHit {
  file: string;
  heading: string;
  snippet: string;
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.trunc(limit);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

/**
 * Recursively collect *.md files under `root`, returning paths relative to it.
 * Symlinks are skipped EXPLICITLY (not relying on Dirent.isFile/isDirectory, which
 * can follow a link on filesystems that don't report d_type) — so the walk can
 * never escape the root via a symlinked file or directory. Bounded by MAX_DEPTH +
 * MAX_FILES.
 */
function markdownFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= MAX_FILES) break;
      if (entry.name.startsWith('.')) continue; // skip dotfiles/dirs
      if (entry.isSymbolicLink()) continue; // never follow a symlink (file or dir)
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(relative(root, abs));
    }
  };
  walk(root, 0);
  return out.sort();
}

/** First `# H1` (or the filename) as a document title. Oversized → filename. */
function titleOf(root: string, file: string): string {
  const abs = join(root, file);
  if (tooLargeOrMissing(abs)) return file;
  const h1 = readFileSync(abs, 'utf-8').match(/^#\s+(.+)$/m);
  return h1 ? h1[1]!.trim() : file;
}

/** List the KB documents (path + title), for the agent to discover what exists. */
export function listDocs(root: string): KbDoc[] {
  return markdownFiles(root).map((file) => ({ file, title: titleOf(root, file) }));
}

interface Section {
  heading: string;
  text: string;
}

/**
 * Split a markdown file into sections at heading lines (`#`..`######`). Content
 * before the first heading is one section headed by the title/filename, so a
 * single search hit always carries a citeable heading.
 */
function sections(file: string, body: string): Section[] {
  const lines = body.split('\n');
  const out: Section[] = [];
  let heading = file;
  let buf: string[] = [];
  const flush = (): void => {
    if (heading !== file || buf.some((l) => l.trim() !== '')) out.push({ heading, text: buf.join('\n').trim() });
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(/^#{1,6}\s+(.+)$/);
    if (m) {
      flush();
      heading = m[1]!.trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/** A short snippet of `text` centered on the first case-insensitive match of `q`. */
function snippet(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  const flat = text.replace(/\s+/g, ' ').trim();
  if (i < 0) return flat.slice(0, 200);
  const fi = flat.toLowerCase().indexOf(q.toLowerCase());
  const start = Math.max(0, fi - 80);
  const end = Math.min(flat.length, fi + q.length + 120);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/**
 * Case-insensitive substring search over every section of every KB doc. Returns
 * the matching sections (heading + a snippet) with their file, for citation.
 * Tier-1: linear scan, good for dozens of docs; swap in SQLite FTS if the KB grows.
 */
export function searchKb(root: string, query: string, limit: number): KbHit[] {
  const q = query.trim();
  if (q === '') return [];
  const ql = q.toLowerCase();
  const hits: KbHit[] = [];
  for (const file of markdownFiles(root)) {
    const abs = join(root, file);
    if (tooLargeOrMissing(abs)) continue; // don't read an oversized doc into memory
    const body = readFileSync(abs, 'utf-8');
    for (const s of sections(file, body)) {
      if (s.heading.toLowerCase().includes(ql) || s.text.toLowerCase().includes(ql)) {
        hits.push({ file, heading: s.heading, snippet: snippet(`${s.heading}\n${s.text}`, q) });
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
}

/**
 * Read one KB document's full content. The injection guard (the agent supplies
 * `file`), defended in layers:
 *   - lexical containment + `.md` suffix on the resolved path;
 *   - the entry itself must NOT be a symlink (lstat) — so a planted
 *     `leak.md -> /etc/passwd` can't be followed;
 *   - realpath containment: the REAL target (after resolving any parent-dir
 *     symlinks) must still live inside the REAL KB root before any bytes are read;
 *   - a size cap so a huge file can't OOM the process.
 * Returns null if missing, oversized, or rejected.
 */
export function getDoc(root: string, file: string): { file: string; content: string } | null {
  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(root));
  } catch {
    return null;
  }
  const target = resolve(rootReal, file);
  if (target !== rootReal && !target.startsWith(rootReal + sep)) return null; // lexical escape
  if (!target.toLowerCase().endsWith('.md')) return null;
  if (!existsSync(target)) return null;
  if (lstatSync(target).isSymbolicLink()) return null; // never follow a symlinked doc
  let targetReal: string;
  try {
    targetReal = realpathSync(target);
  } catch {
    return null;
  }
  // The real file (after any parent-symlink resolution) must still be inside the root.
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) return null;
  if (!statSync(targetReal).isFile() || tooLargeOrMissing(targetReal)) return null;
  return { file: relative(rootReal, targetReal), content: readFileSync(targetReal, 'utf-8') };
}

export type KbResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Resolve SIMBASCRIBE_KB_PATH, run `fn` against it, and turn an unset path or a
 * missing/non-directory root into a clear `{ ok:false, error }` rather than
 * throwing — so the kb_* tools degrade independently and never take the server
 * (or the corpus/tracker tools) down.
 */
export function readKb<T>(kbPathEnv: string | undefined, fn: (root: string) => T): KbResult<T> {
  const root = kbPathEnv?.trim();
  if (!root) return { ok: false, error: 'kb unavailable: SIMBASCRIBE_KB_PATH is not set' };
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      return { ok: false, error: `kb unavailable: ${root} is not a directory` };
    }
    return { ok: true, value: fn(root) };
  } catch (e) {
    return { ok: false, error: `kb unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }
}
