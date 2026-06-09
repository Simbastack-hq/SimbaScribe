export interface SynthArgs {
  dryRun: boolean;
  windowStart: number | null;
  windowEnd: number | null;
}

/**
 * Parses synth CLI flags.
 *   --dry-run                  print the digest, don't post, don't advance state
 *   --window-start <ms>        override window lower bound (ts) — testing only
 *   --window-end <ms>          override window upper bound (ts) — testing only
 *
 * Window overrides FORCE dry-run: a historical re-run must never post to the
 * team channel or move the production watermark. Both bounds must be given
 * together, and must be valid integers.
 */
export function parseArgs(argv: string[]): SynthArgs {
  const args: SynthArgs = { dryRun: false, windowStart: null, windowEnd: null };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--window-start') {
      args.windowStart = parseIntArg(argv[++i], '--window-start');
    } else if (a === '--window-end') {
      args.windowEnd = parseIntArg(argv[++i], '--window-end');
    } else {
      throw new Error(`Unknown argument: ${String(a)}`);
    }
  }

  const hasStart = args.windowStart !== null;
  const hasEnd = args.windowEnd !== null;
  if (hasStart !== hasEnd) {
    throw new Error('--window-start and --window-end must be provided together');
  }
  if (hasStart && hasEnd && args.windowStart! >= args.windowEnd!) {
    throw new Error('--window-start must be less than --window-end');
  }
  if (hasStart) {
    // Window overrides are testing-only — force dry-run so they can never post
    // or advance the production watermark.
    args.dryRun = true;
  }

  return args;
}

function parseIntArg(raw: string | undefined, flag: string): number {
  if (raw === undefined) throw new Error(`${flag} requires a value`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer (ms)`);
  return n;
}
