import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProfile, type WorkspaceProfile } from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Env var holding the path to the active workspace profile. */
export const PROFILE_ENV = 'SIMBASCRIBE_WORKSPACE_PROFILE';

/**
 * The conventional gitignored path for a real (private) profile, relative to the
 * process working directory. If present, it's used when the env var is unset —
 * so a deployer can just drop their profile here without setting the env var.
 */
export const DEFAULT_LOCAL_PROFILE = 'config/workspace.local.json';

/** The committed, fictional example profile (the fallback ONLY when explicitly asked). */
export const EXAMPLE_PROFILE_PATH = resolve(__dirname, '../../profiles/example.workspace.json');

/**
 * Resolve which profile path to load, in precedence order:
 *   1. an explicit `path` argument (tests pass the example here),
 *   2. the `SIMBASCRIBE_WORKSPACE_PROFILE` env var,
 *   3. `config/workspace.local.json` if it exists.
 *
 * Returns `null` if none resolve — the caller decides whether that's fatal.
 * NOTE: we deliberately do NOT silently fall back to the example profile for a
 * live process. A production run on the fictional example would post digests
 * about people who don't exist; far better to fail loud (see loadProfile). For
 * a quick demo, point the env var at `profiles/example.workspace.json`.
 */
export function resolveProfilePath(path?: string): string | null {
  if (path !== undefined && path.trim() !== '') return path.trim();
  const fromEnv = process.env[PROFILE_ENV]?.trim();
  if (fromEnv) return fromEnv;
  if (existsSync(DEFAULT_LOCAL_PROFILE)) return DEFAULT_LOCAL_PROFILE;
  return null;
}

/**
 * Load + validate the active workspace profile. Fails loud if no profile is
 * configured (rather than silently using the fictional example) and if the file
 * is missing or invalid. The returned profile is the single source of truth for
 * everything team/venture/language/channel/provider-specific.
 */
export function loadProfile(path?: string): WorkspaceProfile {
  const resolved = resolveProfilePath(path);
  if (resolved === null) {
    throw new Error(
      `No workspace profile configured. Set ${PROFILE_ENV} to your profile path, ` +
        `or create ${DEFAULT_LOCAL_PROFILE}. For a demo, point ${PROFILE_ENV} at ` +
        `profiles/example.workspace.json. See docs/CONFIG.md.`,
    );
  }
  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf-8');
  } catch (err) {
    throw new Error(
      `Cannot read workspace profile at ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Workspace profile at ${resolved} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseProfile(json);
}
