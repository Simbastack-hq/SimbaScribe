# Engineering conventions

Durable "how we do things" — the kind of reference the agent should cite instead
of guessing from chat.

## Branching

Trunk-based: short-lived branches off `main`, squash-merge, delete after. No
long-running release branches.

## Code review policy

One approval to merge; two for anything touching auth or billing. CI must be
green. Reviews focus on correctness first, then simplicity.

## On-call

One-week rotations. The on-call owns the alert inbox and the incident channel.
Hand off every Monday at standup.

## Secrets

Never in the repo. Secrets live in the environment; config files reference the
env var name, not the value.
