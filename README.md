# SimbaScribe

Self-hostable institutional memory — and a thin, self-maintaining todo tracker —
for a team that lives in Discord.

It **captures** everything said across the team's channels, **summarizes** it on a
daily rhythm, lets anyone **ask questions** about it on demand (grounded in what was
actually said, with links back to the source), and — optionally — **tracks the
todos/ideas/decisions** it infers from the conversation, resurfacing the ones nobody
actioned.

Architectural principle: **smart at the edges, dumb in the middle.** The thing that
captures never thinks; the things that think never capture; and nothing that thinks
ever mutates state directly. That's not just tidiness — it's how the AI stays
[injection-contained](./SECURITY.md).

## What it is

- ✅ **Memory + recall.** It remembers everything, forever, and can find it again —
  grounded answers with citations, not vibes.
- ✅ **A todo tracker that maintains itself.** Todos/ideas/decisions are inferred
  from how the team already talks (no bot commands, no new syntax). Stale todos
  resurface; a ✅/❌ reaction corrects the rare miss. The AI only ever *proposes* —
  deterministic code validates and applies.
- ⚙️ **The tracker's nag-loop ships OFF by default.** Capture + recall are on; the
  aging/surfacing/reaction loop turns on with a single flag once you've watched it
  behave for your team. See [the tracker](#the-tracker).

It is **not** a magic box: every digest and every answer sends chat to an external
model provider (swappable by config — see [data residency](./SECURITY.md#data-residency)).

## How it works

```
                         Discord (your team's channels)
                                   │
                every message, edit, delete, reaction
                                   │
                                   ▼
                        ┌──────────────────────┐
                        │  LISTENER             │   always-on (PM2)
                        │  never calls an LLM   │   "dumb middle"
                        └──────────┬───────────┘
                                   │ writes
                                   ▼
                        ┌──────────────────────┐
                        │   SQLite corpus DB    │   the single source of truth
                        │   (the team brain)    │   soft-delete, full history
                        └──────────┬───────────┘
                                   │
              ┌────────────────────┼─────────────────────────┐
              │ reads                                          │ read-only snapshot
              ▼                                                ▼  (VACUUM INTO, every ~2 min)
   ┌────────────────────┐                          ┌────────────────────────┐
   │  SYNTH             │  cron, twice daily       │  shared read-only dir   │
   │  one model call    │  → digest + (optional)   │  snapshot.db (0640)     │
   │  → digest to a      │     tracker maintenance  │  read-only, cross-user  │
   │    team channel     │  "smart edge"            └───────────┬────────────┘
   └────────────────────┘                                       │ read-only
        push: shows up                                          ▼
        whether you ask                            ┌────────────────────────┐
        or not                                     │  MCP SERVER             │  no LLM
                                                   │  read-only query tools  │  "dumb middle"
                                                   └───────────┬────────────┘
                                                               │ tools
                                                               ▼
                                                   ┌────────────────────────┐
                                                   │  PULSE  (the agent)     │  the "smart edge"
                                                   │  ask anytime, in Discord│  separate, sandboxed,
                                                   │  answers w/ msg links   │  read-only user
                                                   └────────────────────────┘
```

### The pieces

| Piece | Job | When it runs | Thinks? |
|---|---|---|---|
| **Listener** | Capture every message/edit/delete/reaction into SQLite | Always (PM2 daemon) | No — never calls an LLM |
| **Synth** | Post a structured digest of what's new; maintain the tracker | Twice daily, cron | Yes — model call(s) per run |
| **Snapshot** | Publish a read-only copy of the DB for the agent to read safely | Every ~2 min, cron | No |
| **MCP server** | Expose the corpus + tracker + knowledge base as read-only query tools | On demand (spawned by Pulse) | No — pure SQL / file IO |
| **Pulse** | Answer questions, grounded with Discord links | On demand (you @ or DM it) | Yes — it's the agent |

### Push vs pull

- **Synth = push.** Twice a day a digest appears whether or not you ask. Each item
  is surfaced once — it's a notification, not a ledger.
- **Pulse = pull.** Ask "what's pending in #engineering?" any time and it answers
  from the live corpus (seconds stale) with citations.

### Why a snapshot instead of reading the live DB

Pulse runs as a separate, unprivileged user — sandboxed away from production,
because it's the component exposed to untrusted chat. It never touches the live
database; a 2-minute cron publishes a read-only `VACUUM INTO` copy (a standalone,
non-WAL file a different user can open read-only). Even a fully compromised agent
can only ever see a stale, read-only copy. See [SECURITY.md](./SECURITY.md).

## The tracker

SimbaScribe maintains a small, human-correctable list of `todo` / `idea` /
`decision` items, inferred from the conversation:

- **Creation is normal chat.** "I'll deploy the API by EOD" becomes a tracked todo;
  "let's move the queue to Postgres" becomes a tracked decision. No bot commands.
- **The AI proposes; deterministic code decides.** A proposed change is validated
  against reality (real, open, in-window evidence) before anything is written.
  Strong signals auto-close; weak ones become a "looks done?" review; everything is
  a soft close with an audit trail, never a hard delete.
- **It nags (optionally).** Stale todos resurface in the digest with a ✅ keep / ❌
  drop prompt; a ✅/❌ from a human is the out-of-band correction signal. Ignored
  items age out.
- **Off by default.** Capture + recall run as soon as `SIMBASCRIBE_TRACKER_DB_PATH`
  is set. The nag-loop (aging + surfacing + reactions) turns on with
  `SIMBASCRIBE_TRACKER_SURFACING_ENABLED=true` — flip it once you've watched it.

Why infer-and-correct instead of a confirm-gate? Because the headline value is
*resurfacing the todo nobody actioned* — and "nobody actioned it" includes nobody
tapping ✅. A confirm-gated list is emptiest exactly when you need it most.

## Knowledge base (optional)

Point `SIMBASCRIBE_KB_PATH` at a directory of curated markdown (runbooks,
policies, "how we do X") and Pulse can list + search + cite it via `kb_list` / `kb_search` / `kb_get`
— a third grounded source alongside the chat corpus and the tracker, for the
durable reference questions chat history can't answer. It's trusted, team-authored
content; the tools are read-only and path-restricted to that directory. Unset → the
`kb_*` tools simply report "kb unavailable" and everything else works. See
`kb/example/` for the format.

## Quickstart

```bash
nvm use            # Node 20.20.1 (see .nvmrc)
npm install
npm run init       # scaffolds config/workspace.local.json + .env from the examples
npm run build && npm test
node dist/synth/index.js --dry-run   # see a digest without posting
```

Then fill in `config/workspace.local.json` ([CONFIG.md](./docs/CONFIG.md)) and `.env`
([`.env.example`](./.env.example)), and follow [docs/SETUP.md](./docs/SETUP.md) to
wire up the listener + crons. To run one instance per team/client, see
[docs/DEPLOY-PER-COMPANY.md](./docs/DEPLOY-PER-COMPANY.md).

## Configuration

Two layers: **`.env`** for secrets + deploy paths, and a **workspace profile** (one
JSON file) for everything team/venture/language/channel/provider-specific. The
committed source ships a generic skeleton + a fictional example
([`profiles/example.workspace.json`](./profiles/example.workspace.json)); your real
profile is gitignored. Full reference: [docs/CONFIG.md](./docs/CONFIG.md).

## Stack

- Node 20 LTS + TypeScript (ESM)
- `discord.js` v14 (listener)
- `better-sqlite3` (corpus + tracker)
- `@modelcontextprotocol/sdk` (read-only query server)
- Any **Anthropic-protocol** model provider (set in your profile)
- PM2 (listener) + system cron (synth, snapshot)

## Layout

```
src/
  listener/    Discord → SQLite (no LLM)
  synth/       twice-daily digest + tracker maintenance (the model call)
  tracker/     the todo/idea/decision tracker (LLM-free apply, aging, surfacing)
  snapshot/    read-only snapshot publisher (no LLM)
  mcp-server/  read-only corpus + tracker query tools (no LLM)
  profile/     the workspace-profile schema + prompt renderer
  db/          shared SQLite schema + helpers
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Security model: [SECURITY.md](./SECURITY.md).

## License

MIT — see [LICENSE](./LICENSE).
