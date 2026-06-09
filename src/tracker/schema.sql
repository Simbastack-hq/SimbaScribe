-- SimbaScribe Phase 2 — Tracker schema. Lives in its OWN writable DB
-- (tracker.db), separate from the read-only corpus. Applied idempotently when
-- the tracker store opens. The synth is the only writer.
--
-- tracker_items is a human-correctable VIEW of the durable-worthy signal the
-- synth infers from chat. Status is re-evaluated against the corpus each run;
-- human_flag (set by ✅/❌ reactions) is the only authoritative-and-sticky field
-- and always wins over the model on re-derivation.

CREATE TABLE IF NOT EXISTS tracker_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL CHECK (kind IN ('todo','idea','decision','question')),
                                              -- 'question' designed-for; not emitted in v1 (validate rejects it)
  text            TEXT NOT NULL,              -- deliverable / idea / decision statement
  owner           TEXT,                       -- canonical display name; NULL for idea/decision/unassigned
  owner_id        TEXT,                       -- stable Discord author id where known (preferred over name for matching)
  status          TEXT NOT NULL CHECK (status IN ('open','done','answered','superseded','dismissed','archived')),
  confidence      TEXT NOT NULL CHECK (confidence IN ('high','low')),  -- drives ranking + aging speed
  blocked         INTEGER NOT NULL DEFAULT 0, -- todo-only urgency flag (the "blocker")
  human_flag      TEXT,                       -- NULL | 'pinned' | 'dismissed' | 'reopened' (sticky; overrides the model)
  source_msg_id   TEXT NOT NULL,              -- corpus message that created it
  source_url      TEXT NOT NULL,              -- prebuilt Discord deep link (citation)
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,           -- bumped on each touch (re-mention) → drives aging
  resolved_at     INTEGER,                    -- done/answered/superseded time
  resolved_msg_id TEXT,                       -- evidence message for the resolution
  resolved_url    TEXT,
  resolved_by     TEXT,                        -- reactor id for a ✅-confirmed close; else inferred actor
  needs_review    INTEGER NOT NULL DEFAULT 0, -- weak close awaiting a "looks done?" confirm
  superseded_by   INTEGER,                    -- decision lineage (→ tracker_items.id); nullable
  resurfaced_at   INTEGER,                    -- when an aging item was surfaced once (NULL = not yet)
  digest_msg_id   TEXT,                         -- the per-item message a ✅/❌ targets (reaction binding)
  digest_msg_kind TEXT                          -- semantic of that message: new|looks-done|resurfaced|revisit
                                                -- (reactions are interpreted by THIS, not by drifting item state)
);

CREATE INDEX IF NOT EXISTS idx_tracker_open ON tracker_items(kind, status);
CREATE INDEX IF NOT EXISTS idx_tracker_owner ON tracker_items(owner_id, status);
-- Covers listOpen()'s WHERE status='open' ORDER BY last_seen_at.
CREATE INDEX IF NOT EXISTS idx_tracker_status_seen ON tracker_items(status, last_seen_at);

-- Dedup backstop: one tracker item per surfacing message. digest_msg_id is the
-- stable reaction-binding key, so it must be unique among surfaced items.
-- Partial (NULLs allowed) so un-surfaced items don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracker_digest_msg
  ON tracker_items(digest_msg_id) WHERE digest_msg_id IS NOT NULL;
-- NOTE: source_msg_id is deliberately NOT unique — one message can spawn several
-- items ("@sam and @alex both deploy X"). Cross-time dedup ("still on the
-- service" ≠ a new item) is the reconcile's owner+text-overlap guard, not SQL.

-- Append-only audit of every state change: makes the view auditable ("why did
-- this close?"), and the item-mutation + its event row are written in ONE
-- transaction so the log can never disagree with item state.
CREATE TABLE IF NOT EXISTS tracker_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id      INTEGER NOT NULL REFERENCES tracker_items(id),  -- no orphan events (foreign_keys pragma is ON)
  ts           INTEGER NOT NULL,
  event        TEXT NOT NULL,    -- created|touched|closed|answered|superseded|pinned|dismissed|reopened|flagged_review|resurfaced|auto_archived
  source       TEXT NOT NULL,    -- 'synth_infer' | 'reaction' | 'aging'
  detail       TEXT,             -- JSON: evidence msg, reactor id, strength, etc.
  synth_run_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tracker_events_item ON tracker_events(item_id, ts);

CREATE TABLE IF NOT EXISTS tracker_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
