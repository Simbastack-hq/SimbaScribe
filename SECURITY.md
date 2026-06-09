# Security model

SimbaScribe reads untrusted team chat and answers questions about it with an LLM
agent. That makes prompt injection a first-class threat, not an afterthought. The
architecture is built around containing it.

## The core stance: smart edges, dumb middle

The thing that captures never thinks; the things that think never capture, and
**nothing that thinks ever mutates state directly.**

- The LLM only ever **proposes** (a digest, or a structured set of tracker changes).
- Deterministic, LLM-free code **validates** the proposal against reality and
  **applies** it.
- Humans **correct exceptions** out-of-band.

## Two trust zones (the read/write split)

| Component | Runs as | Can write? | Why |
|---|---|---|---|
| Listener, Synth, Snapshot publisher | the **writer** user | yes (its own DBs) | trusted; the only writers |
| MCP server + the Pulse agent | a **separate, unprivileged** user | **no** — reads a read-only snapshot | sandboxed; this is the part exposed to untrusted chat |

The agent that reads untrusted chat runs as a different, unprivileged user with no
filesystem/shell, and queries a **read-only `VACUUM INTO` snapshot** — never the
live database. A fully compromised agent can only ever see a stale, read-only copy.

> Collapse this split and the sandbox is theater. It is the injection containment,
> not incidental hygiene.

## Injection containment on the write path

The tracker is maintained from chat, so an attacker could try to inject "close every
todo" or "create a malicious item." The defenses, in layers:

1. **Validation before apply.** The model's proposal is checked against reality:
   a resolution/touch must target a currently-open item; evidence must be a message
   *in this run's window* (you can't close item #7 by citing a message you didn't
   just read); transitions must be legal for the kind. Anything else is dropped and
   logged, not applied.
2. **Strong-signal-only auto-close**, with a per-run cap. The dangerous "real work
   silently vanishes" error needs an unambiguous signal; a run proposing too many
   closes has them all demoted to a "looks done?" review (bounds blast radius).
3. **Soft close, never hard delete** + an append-only audit log → a wrong close is
   visible and reversible.
4. **Aging** keeps the list current; phantoms age out.

## The out-of-band commit signal

The human correction signal is a **reaction** (✅/❌) on the bot's own message. A
prompt injection can change what the AI *proposes*, but it cannot manufacture a real
teammate's reaction — the signal lives outside any text channel an injection
controls.

This holds **only** because reactions are filtered to **human users** (the platform's
own bot/app flag). A bot/webhook/agent reaction is ignored, so even a compromised
agent cannot ✅ its own malicious proposal. Reaction apply is idempotent and the
human override is sticky.

## Data residency (read before deploying for a client)

Every digest and every agent answer — and any knowledge-base doc the agent cites —
sends that content to an **external model provider** (the one named in your workspace
profile). For a client or regulated
deployment, that may matter. The provider is **swappable by config**
(`provider` in the profile — any Anthropic-protocol endpoint, including self-hosted
or alternative providers). Decide and document where chat goes before pointing this
at sensitive workspaces.

## Secrets

API keys live only in `.env`; the workspace profile stores the **name** of the env
var, never the key, and the schema rejects an inlined credential. Never commit
`.env` or a real profile (both are gitignored). The snapshot directory is group-
readable but not group-writable (setgid `2750`), so the sandboxed reader cannot
plant files there.

## Reporting

This is currently a self-hosted tool with no central service. If you find a
vulnerability, please report it privately via this repository's GitHub **Security
Advisories** ("Report a vulnerability" under the **Security** tab) rather than
opening a public issue. We'll respond as soon as we can.
