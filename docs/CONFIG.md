# Configuration

SimbaScribe splits its configuration in two:

- **`.env`** — secrets and deploy-specific paths (tokens, DB paths, the webhook).
  See [`.env.example`](../.env.example) for the complete, annotated list.
- **The workspace profile** — everything team/venture/language/channel/provider-
  specific, in one JSON file. This page is its reference.

The committed source ships a generic skeleton plus a fictional example profile
([`profiles/example.workspace.json`](../profiles/example.workspace.json)); your
real profile is **never committed**.

## Where the profile lives

The synth resolves the active profile in this order:

1. `SIMBASCRIBE_WORKSPACE_PROFILE` (env) — an explicit path;
2. `config/workspace.local.json` — the conventional gitignored path, if present;
3. otherwise it **fails loud** — it will not silently run on the fictional example.

For a quick demo: `SIMBASCRIBE_WORKSPACE_PROFILE=profiles/example.workspace.json`.

Real profiles are gitignored (`config/*.local.*`, `profiles/*.local.*`), so going
public later is simply "the real profile was never committed."

## Fields

| Field | Required | Type | What it is |
|---|---|---|---|
| `botName` | yes | string | The bot's display name, e.g. `"SimbaScribe"`. |
| `workspaceName` | yes | string | Possessive-friendly team name, e.g. `"the Acme dev team"` (rendered as `"{workspaceName}'s institutional memory"`). |
| `teamOverview` | yes | string | One short paragraph: who's on the team + what they work on. |
| `offPlatformNote` | no | string | People who matter but aren't in the chat corpus (e.g. someone on email). Empty when everyone's in chat. |
| `languageGuidance` | no | string | How the team writes — empty for plain English; describe the mix for a code-switching team so the model reads it correctly. |
| `signals` | yes | object | Per-category classification guidance (see below). |
| `channelContext` | yes | string | Markdown bullets of per-channel classification hints. |
| `canonicalization` | no | `{from,to}[]` | Display-name → canonical-name rules (e.g. `{"from":"jsmith.42","to":"Jordan"}`). |
| `fewShotHeading` | no | string | Heading for the worked-examples section (default `"Worked examples"`). |
| `fewShotExamples` | no | string | Worked examples from your own corpus — the classifier's calibration set. Strongly recommended. |
| `confirmEmoji` | no | string | Pin/confirm reaction (default `✅`). |
| `vetoEmoji` | no | string | Veto/dismiss reaction (default `❌`). |
| `provider` | yes | object | The model provider (see below). |
| `aging` | no | object | Tracker nag-loop thresholds in days (see below). |
| `mentions` | no | object | Opt-in Discord @-mention tagging in the digest (see below). Off by default. |

### `signals`

Seven markdown fragments, one per digest signal bucket. Each is injected under
that category's generic definition in the prompt, so write the **language-specific
markers/examples** here (the structure and rules live in the skeleton):

`commitment`, `decision`, `openQuestion`, `blocker`, `status`, `context`, `noise`.

Look at the example profile for the shape. A bilingual team puts its code-switched
markers here (and in `languageGuidance`); a plain-English team uses plain markers.

### `provider`

```json
"provider": { "baseUrl": "https://api.anthropic.com", "apiKeyEnv": "MODEL_API_KEY", "model": "claude-sonnet-4-6" }
```

- `baseUrl` — an Anthropic-protocol endpoint (Anthropic itself, or any compatible
  gateway — e.g. an on-prem or alternative provider that speaks the protocol).
- `apiKeyEnv` — the **NAME** of the env var holding the key, NOT the key. Must be
  `UPPER_SNAKE_CASE`. The key stays in `.env`; the profile is safe to share.
- `model` — the model id at that endpoint.

> Strict: an inlined `apiKey` (or any unknown provider field) is rejected loudly,
> so a secret can't slip into a committed profile.

### `aging`

```json
"aging": { "todoResurfaceDays": 5, "todoArchiveGraceDays": 9, "ideaRevisitDays": 60 }
```

Used only by the nag-loop (off by default). A todo untouched for `todoResurfaceDays`
is resurfaced once; if still untouched `todoArchiveGraceDays` later it auto-archives.
An idea gets one gentle "revisit?" at `ideaRevisitDays`. Decisions never age.
Tracker-only fields are **lenient** — a malformed value degrades to the default
rather than ever breaking the digest.

### `mentions`

```json
"mentions": {
  "enabled": true,
  "roster": [
    { "name": "Jordan", "discordId": "111111111111111111" },
    { "name": "Priya",  "discordId": "222222222222222222" }
  ]
}
```

Opt-in @-mention tagging. When `enabled` **and** the roster is non-empty, the
digest replaces each rostered person's **first** appearance with a Discord ping
(`<@id>`), so they get one notification per daily digest. Off by default — absent
or `"enabled": false` posts exactly as before, with no pings.

- `name` — the **canonical** name as it appears in the digest prose (the same name
  your `canonicalization` rules resolve to). Matching is case-sensitive, on whole
  words, longest-name-first (so `"James A"` wins over `"James"`).
- `discordId` — the teammate's Discord **user ID** (17–20 digit snowflake; enable
  Developer Mode in Discord, right-click a user → *Copy User ID*). A value that
  isn't a snowflake is rejected.
- The flag is a one-flip pause switch: set `"enabled": false` to mute all pings
  without deleting your roster.

Safety: only the listed IDs can ever ping — `@everyone`/`@here`/role mentions stay
suppressed exactly as before. `mentions` touches the live digest, so like the
other digest-touching fields it is **lenient**: a malformed block degrades to OFF
(no pings) rather than breaking the post. Note the match is by name, so a roster
name that's also a common word can mis-tag — curate the roster. Test it safely
with `--dry-run` (it prints the tagged IDs without posting).

## Behaviour-equivalence (for existing deployments)

The two prompts are name-free skeletons rendered from the profile. To migrate an
existing static prompt: move its team-specific text into a profile, and (optionally)
keep a copy of the old prompt as `config/golden-system-prompt.local.txt` —
[`tests/profile-equivalence.local.test.ts`](../tests/profile-equivalence.local.test.ts)
will then prove your render matches the original on every run.
