# Deploy runbook

How the Northwind team ships. This is example content — replace `kb/example/`
with your own docs and point `SIMBASCRIBE_KB_PATH` at them.

## Releasing the web app

1. Merge to `main` (green CI required).
2. Tag `vX.Y.Z` and push the tag — the deploy workflow runs on tags only.
3. Watch the canary for 10 minutes before promoting to 100%.

## Rolling back

`make rollback ENV=prod` re-points the load balancer to the previous release.
Rollbacks are always safe — releases are immutable and we never run destructive
migrations in the deploy step.

## Who to ping

Infra issues go to Diego. Anything customer-facing during an incident: Ada.
