#!/usr/bin/env node
// Scaffold a new SimbaScribe workspace from the committed example: copies the
// example profile (and .env) into place WITHOUT overwriting anything, then prints
// a checklist of what to fill in. Zero dependencies, no build step — run it on a
// fresh clone with `npm run init` (or `node scripts/init-workspace.mjs`).
//
// One instance serves one chat workspace; run this once per workspace, each in its
// own checkout / data dir (see docs/DEPLOY-PER-COMPANY.md).

import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const r = (p) => resolve(root, p);

let created = [];
let skipped = [];

// These files hold secrets (.env) and private workspace data (the profile), so
// they must be owner-only (0600), never the 0644 the tracked examples carry.
function copyIfAbsent(from, to, opts = {}) {
  if (existsSync(r(to))) {
    chmodSync(r(to), 0o600); // repair perms on an already-present sensitive file (no content change)
    skipped.push(to);
    return;
  }
  if (opts.mkdir) mkdirSync(dirname(r(to)), { recursive: true });
  copyFileSync(r(from), r(to));
  chmodSync(r(to), 0o600);
  created.push(to);
}

console.log('\nSimbaScribe — workspace init\n');

copyIfAbsent('profiles/example.workspace.json', 'config/workspace.local.json', { mkdir: true });
copyIfAbsent('.env.example', '.env');

if (created.length) console.log('Created (edit these):\n' + created.map((f) => `  + ${f}`).join('\n'));
if (skipped.length) console.log('\nAlready present (content left untouched; perms secured to 0600):\n' + skipped.map((f) => `  · ${f}`).join('\n'));

console.log(`
Next steps
----------
1. Edit  config/workspace.local.json  — your team, channels, language, provider.
   Reference: docs/CONFIG.md
2. Edit  .env  (chmod 600 .env)  — fill in:
     DISCORD_BOT_TOKEN            (bot token; enable the MESSAGE CONTENT intent)
     DISCORD_GUILD_ID             (your server id)
     SIMBASCRIBE_WHITELIST_CHANNEL_IDS  (comma-separated channel ids)
     SIMBASCRIBE_OUTPUT_WEBHOOK_URL     (digest channel webhook)
     <the env var your profile's provider.apiKeyEnv names>  (model API key)
   Paths (SIMBASCRIBE_DB_PATH, *_SNAPSHOT_DB_PATH) — per-instance; see docs/DEPLOY-PER-COMPANY.md
3. npm run build && npm test
4. Dry-run the digest:  node dist/synth/index.js --dry-run
5. Wire up the listener (PM2) + synth/snapshot (cron). See docs/SETUP.md.

The tracker nag-loop ships OFF. Turn it on only after you've watched the surfacing
posts look right:  SIMBASCRIBE_TRACKER_SURFACING_ENABLED=true
`);
