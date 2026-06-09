# Running one instance per team / client

SimbaScribe is **single-tenant**: one instance serves one chat workspace (one
Discord server). To serve several teams or clients, run several instances — each
fully isolated by config, with nothing shared between them. There is no multi-tenant
mode, on purpose: isolation is simpler to reason about (and to bill, and to delete).

This guide is the runbook for onboarding a new workspace **X** alongside existing
ones. Do the one-time [SETUP.md](./SETUP.md) steps per instance; this page is the
per-instance checklist that keeps two instances from colliding.

## What MUST be unique per instance

| Thing | Where | Example for workspace X |
|---|---|---|
| Checkout / working dir | filesystem | `/home/<writer>/apps/simbascribe-X` |
| Corpus DB path | `SIMBASCRIBE_DB_PATH` | `./data/X.db` |
| Snapshot path(s) | `SIMBASCRIBE_SNAPSHOT_DB_PATH`, `…_TRACKER_SNAPSHOT_DB_PATH` | `/srv/ssbrain/X-snapshot.db`, `/srv/ssbrain/X-tracker-snapshot.db` |
| KB path (if used) | `SIMBASCRIBE_KB_PATH` | `/srv/ssbrain/X-kb` |
| Tracker DB path | `SIMBASCRIBE_TRACKER_DB_PATH` | `./data/X-tracker.db` |
| Workspace profile | `config/workspace.local.json` (per checkout) | X's team/channels/provider |
| Discord token + guild + channels + webhook | `.env` | X's bot + server |
| PM2 app name | `ecosystem.config.cjs` | `simbascribe-listener-X` |
| flock lock files | cron lines | `/tmp/simbascribe-synth-X.lock`, `…-snapshot-X.lock` |
| Cron file names | `/etc/cron.d/` | `simbascribe-synth-X`, `simbascribe-snapshot-X` |

Everything else (the code, the conventions) is shared by being the same repo. The
example profile proves the point: a second instance is **pure config** — no code
changes.

## Onboard workspace X (checklist)

1. **Discord:** create X's bot (enable the MESSAGE CONTENT intent), invite it to X's
   server with read + (for private threads) Manage Threads, and create a digest
   webhook.
2. **Checkout:** clone into a per-instance dir; `nvm use && npm install && npm run build`.
3. **Scaffold:** `npm run init`, then edit `config/workspace.local.json`
   ([CONFIG.md](./CONFIG.md)) and `.env` with X's values + the unique paths above.
4. **Model provider:** point X's profile `provider` at the right endpoint/model.
   If X is a client with data-residency constraints, choose a provider accordingly
   (every digest/answer ships chat to it — see [SECURITY.md](./SECURITY.md#data-residency)).
5. **Snapshot dir:** reuse the shared `ssbrain` group/dir, but give X its own
   snapshot filenames (table above) so instances never overwrite each other. If X
   uses a knowledge base, give it its own `SIMBASCRIBE_KB_PATH` too (e.g.
   `/srv/ssbrain/X-kb`, readable by `<reader>`) — never share one KB dir across
   instances, or one client's docs leak into another's answers ([SETUP.md §8](./SETUP.md)).
6. **Processes:** add a PM2 app `simbascribe-listener-X`; add two `/etc/cron.d/`
   files for X's synth + snapshot with X-specific lock files and the `cd` into X's
   checkout.
7. **Verify:** listener captures; `node dist/synth/index.js --dry-run` prints a
   digest; after a snapshot tick the agent's tools return X's data; if X has a KB,
   `kb_list` returns X's docs (not "kb unavailable") — confirms the reader can read
   `SIMBASCRIBE_KB_PATH` and it points at X's dir, not another instance's.
8. **Tracker:** leave the nag-loop **off** initially. Turn it on for X only after
   watching its surfacing posts look right.

## Offboarding

Because instances are isolated, removing one is: stop its PM2 app, delete its two
cron files, and delete its `data/` + snapshot files (and its `/srv/ssbrain/X-kb`
dir, if it had a KB). Nothing leaks into the others.
