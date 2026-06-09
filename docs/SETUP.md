# Deploy it for your team

SimbaScribe is self-hosted. One instance serves one chat workspace (one Discord
server). This guide stands up an instance on a single Linux box.

> Conventions below use placeholders: `<writer>` is the trusted user that owns the
> data and runs the listener/synth/snapshot; `<reader>` is a separate, unprivileged
> user that runs the agent + MCP server. Keeping them distinct is the security model
> (see [SECURITY.md](../SECURITY.md)) — don't collapse them.

## 0. Prerequisites

- **Node 20.20.1** (see `.nvmrc`). `better-sqlite3` needs the prebuilt binary for
  this version; newer Node majors can fail the native build.
- A Discord bot (developer portal) with the **MESSAGE CONTENT** privileged intent.
  For private threads, also grant **Manage Threads** + **View Channel** + **Read
  Message History** on the parent channels.
- An API key for an Anthropic-protocol model provider.

## 1. Clone, install, build

```bash
git clone <repo> && cd SimbaScribe
nvm use            # 20.20.1
npm install
npm run build
npm test           # 200+ tests should pass
```

## 2. Create your workspace profile

Copy the example and edit it with your team's details (full reference:
[CONFIG.md](./CONFIG.md)):

```bash
mkdir -p config
cp profiles/example.workspace.json config/workspace.local.json
$EDITOR config/workspace.local.json     # gitignored — never committed
```

The synth finds it automatically at `config/workspace.local.json`, or set
`SIMBASCRIBE_WORKSPACE_PROFILE` to a path. If neither is set, the synth fails loud
(it will not run on the fictional example).

## 3. Fill in `.env`

Copy `.env.example` → `.env`, `chmod 600 .env`, and fill in the token, guild id,
whitelisted channel ids, DB paths, the digest webhook, and the model API key (the
env var **named by your profile's `provider.apiKeyEnv`**). Everything is annotated
in `.env.example`.

## 4. The two-user / shared-snapshot layout

The agent reads a read-only snapshot from a shared directory, never the live DB:

```bash
sudo groupadd -f ssbrain
sudo install -d -o <writer> -g ssbrain -m 2750 /srv/ssbrain   # setgid; group r-x, NOT writable
sudo usermod -aG ssbrain <reader>                              # takes effect on next login
```

Set `SIMBASCRIBE_SNAPSHOT_DB_PATH=/srv/ssbrain/snapshot.db` (and, if using the
tracker, `SIMBASCRIBE_TRACKER_SNAPSHOT_DB_PATH=/srv/ssbrain/tracker-snapshot.db`)
to the **same absolute path** in both the writer's `.env` and the reader's MCP env.

## 5. Run the pieces

- **Listener** (always-on): PM2, fork mode, with the absolute NVM node path. See
  `ecosystem.config.cjs`.
- **Synth** (twice daily) and **Snapshot** (every ~2 min): **system cron**, not PM2
  (PM2 fork-mode deadlocks with `better-sqlite3`). Use an absolute NVM node path and
  `cd` into the repo first (the process loads `.env` from its working directory).
  Wrap with `flock -n` so runs never overlap. See `crontab.example` and
  `simbascribe-snapshot.cron` for the exact lines and the rationale.

## 6. Verify

- Listener logs show messages being captured.
- A manual synth dry-run prints a digest:
  `node dist/synth/index.js --dry-run`
- After the first snapshot tick, the agent's `recent_messages` / `list_channels`
  tools return data.

## 7. (Optional) The tracker + nag-loop

- The tracker (capture + recall) turns on when `SIMBASCRIBE_TRACKER_DB_PATH` is set.
- The **nag-loop** (aging + surfacing + ✅/❌ reactions) ships **OFF**. Turn it on
  only after you've watched the surfacing posts look right for your team:
  set `SIMBASCRIBE_TRACKER_SURFACING_ENABLED=true` (needs the webhook + bot token).

## 8. (Optional) Knowledge base

Point `SIMBASCRIBE_KB_PATH` at a directory of curated markdown (runbooks, policies,
how-tos) and the agent gains `kb_list` / `kb_search` / `kb_get`. The MCP server runs as the
**reader** user, so the directory must be **readable by `<reader>`** — put it in the
shared `/srv/ssbrain` tree, or grant the reader read access wherever it lives. Set
`SIMBASCRIBE_KB_PATH` in the reader's MCP env (no writer process reads the KB). The path
is per-instance, so two companies' KBs never mix. Format: plain `*.md` only (other
extensions are ignored), subfolders are fine, the first `# H1` is each doc's title and
every heading is a citeable section — see `kb/example/`. KB files are read live per
query, so add or edit docs with no restart; only changing `SIMBASCRIBE_KB_PATH` needs
an MCP-server restart.

## Standing up a second team

One instance per workspace. Use a per-instance DB path, profile, snapshot file, and
a distinct flock lock + cron lines so two instances never collide. See
[DEPLOY-PER-COMPANY.md](./DEPLOY-PER-COMPANY.md).
