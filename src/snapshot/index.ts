import Database from 'better-sqlite3';
import { chmodSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { required } from '../config.js'; // importing also loads dotenv (.env from cwd)

/**
 * Publishes an atomic, read-only snapshot of the live corpus DB so the read-only
 * MCP server — running as a DIFFERENT, unprivileged user — can query it without
 * ever touching the live database.
 *
 * NOTE: this is a rolling snapshot — each run OVERWRITES the previous one, so it
 * is NOT a substitute for point-in-time backups. A corrupt/truncated live DB
 * would propagate to the snapshot on the next tick. Retained/rotated backups are
 * a deploy concern (handled separately), not this publisher's job.
 *
 * Uses `VACUUM INTO`, NOT the online-backup API, on purpose: `.backup` copies
 * the source's WAL journal_mode into the snapshot, so opening that snapshot
 * read-only would try to create a `-shm` sidecar — which fails when the reader
 * is a different user in a directory it cannot write to. `VACUUM INTO` produces
 * a standalone, defragmented copy in rollback-journal mode (no `-wal`/`-shm`
 * sidecars), exactly what the read-only MCP server expects.
 *
 * Runs from a READ-ONLY connection, so the live DB is never written. Safe to run
 * while the listener is writing (VACUUM INTO reads one consistent transaction).
 * Caveat: VACUUM INTO holds a read transaction for its duration, which can delay
 * a WAL checkpoint on the source — so under sustained writes the live `-wal` can
 * grow until the snapshot finishes. Negligible at this corpus size / 2-min
 * cadence; noted so it isn't a surprise if the corpus grows large.
 *
 * The snapshot is a FULL copy — soft-deleted rows included. Deleted-row
 * filtering happens at query time in the MCP server, not here; a backup should
 * be complete.
 */
export function publishSnapshot(liveDbPath: string, destPath: string): void {
  // Preflight: a missing/unwritable dest dir otherwise surfaces as an opaque
  // SQLite "unable to open database file" — name the real problem in the log.
  const destDir = dirname(destPath);
  try {
    if (!statSync(destDir).isDirectory()) {
      throw new Error(`snapshot dest dir is not a directory: ${destDir}`);
    }
  } catch (err) {
    throw new Error(
      `snapshot dest dir unusable: ${destDir} (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  // Per-pid temp in the destination directory (same filesystem) so the final
  // rename is atomic. VACUUM INTO refuses to overwrite an existing file, so
  // clear any stale temp from a previously killed run first.
  const tmp = join(destDir, `.snapshot.tmp.${process.pid}`);
  rmSync(tmp, { force: true });
  try {
    const db = new Database(liveDbPath, { readonly: true, fileMustExist: true });
    try {
      // The target must be a SINGLE-QUOTED SQL string literal. Double quotes are
      // identifiers in SQLite and fail ("no such column"). Escape embedded
      // single quotes by doubling them.
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
    // Group-readable for the shared group (the MCP-server user), owner-only
    // write. Then publish atomically — a reader opening mid-run sees either the
    // old whole file or the new whole file, never a partial one.
    chmodSync(tmp, 0o640);
    renameSync(tmp, destPath);
  } finally {
    // No-op after a successful rename; cleans up the temp if anything threw.
    rmSync(tmp, { force: true });
  }
}

/**
 * Publishes the tracker snapshot IF configured AND the tracker DB exists, with
 * its failure HARD-ISOLATED: any error (perms, schema, disk) is logged and
 * swallowed, never thrown. The corpus snapshot is the priority — Pulse depends
 * on it — and a broken tracker must degrade only the tracker_* tools, never
 * block the corpus path (spec §4 independence). Returns what happened, for tests
 * and observability. Both env vars optional: the tracker DB is created by the
 * synth reconcile (a later increment), so until then there's nothing to publish.
 */
export function publishTrackerSnapshotIsolated(
  trackerSrc: string | undefined,
  trackerDest: string | undefined,
): 'published' | 'skipped-unconfigured' | 'skipped-absent' | 'failed' {
  const src = trackerSrc?.trim();
  const dest = trackerDest?.trim();
  if (!src || !dest) return 'skipped-unconfigured';
  try {
    if (!existsSync(src)) {
      console.error(`[snapshot] tracker DB not present yet at ${src} — skipping tracker snapshot`);
      return 'skipped-absent';
    }
    publishSnapshot(src, dest);
    return 'published';
  } catch (err) {
    console.error(
      `[snapshot] tracker snapshot failed (corpus snapshot unaffected): ${err instanceof Error ? err.message : String(err)}`,
    );
    return 'failed';
  }
}

function main(): void {
  const liveDbPath = required('SIMBASCRIBE_DB_PATH');
  const destPath = required('SIMBASCRIBE_SNAPSHOT_DB_PATH');
  publishSnapshot(liveDbPath, destPath);

  // Independent, failure-isolated tracker publish (see fn doc). Runs AFTER the
  // corpus snapshot so the corpus is already on disk regardless of tracker state.
  publishTrackerSnapshotIsolated(
    process.env.SIMBASCRIBE_TRACKER_DB_PATH,
    process.env.SIMBASCRIBE_TRACKER_SNAPSHOT_DB_PATH,
  );
}

// Run only when invoked directly (cron: `node dist/snapshot/index.js`), not when
// imported by tests. Comparing this module's URL to argv[1] is the robust idiom
// (an `endsWith` path check is fooled by symlinks / similar suffixes).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error('[snapshot] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
