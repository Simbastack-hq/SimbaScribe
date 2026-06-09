# Contributing

Thanks for your interest. SimbaScribe is a small, opinionated codebase — a few
principles keep it that way.

## The architecture is the contract

**Smart edges, dumb middle.** Keep it that way:

- The **listener never calls an LLM.** `grep -ri llm src/listener/` must stay empty.
- The **only place intelligence runs is the synth's model call(s).** Everything in
  `src/tracker/`, `src/mcp-server/`, `src/snapshot/` is LLM-free.
- The LLM only ever **proposes**; deterministic code **validates then applies**.
  Never let model output mutate state without passing through validation.
- **One writer.** Only the synth writes the corpus/tracker DBs. The agent (Pulse)
  and MCP server are **read-only**, over a snapshot. Don't add a write path to the
  sandboxed side — that's the injection boundary (see [SECURITY.md](./SECURITY.md)).
- **No new hardcoding.** Anything team/venture/language/channel/provider-specific
  goes through the workspace profile ([docs/CONFIG.md](./docs/CONFIG.md)), never a
  literal in `src/`. CI/grep should find no real names in committed source.

## Dev setup

```bash
nvm use            # Node 20.20.1 — better-sqlite3 needs the prebuilt binary for it
npm install
npm test           # vitest
npm run build      # tsc + copies *.sql / *.skeleton.txt into dist/
npx tsc --noEmit   # typecheck
```

> Node version matters: newer majors can fail the `better-sqlite3` native build.
> Use the pinned 20.20.1.

## Tests

- Every change keeps the suite green (`npm test`) and `tsc --noEmit` clean.
- New behavior gets tests. The tracker's hard paths (coreference, the injection
  validation, aging boundaries, reaction interpretation) are exercised directly —
  match that bar rather than smoke-testing.
- Use **generic, fictional** fixtures (no real names) — see the existing tests.
- I/O (Discord REST, the model call) is **injected** so logic is tested without the
  network. Keep new I/O behind a thin, injectable adapter.

## PRs

- One coherent change per PR; descriptive body. Green before merge.
- If you touch a prompt skeleton, keep it name-free; team-specific content belongs
  in the profile.
- The tracker's nag-loop is **off by default** — keep new runtime behavior gated so
  a deploy can't surprise a team.

## Filing issues

Bugs and ideas welcome. For anything security-sensitive, see
[SECURITY.md](./SECURITY.md) (report privately, don't open a public issue).
