-- SimbaScribe schema. Applied idempotently on listener boot.
-- Phase 1a creates: messages (the corpus) + synth_state (seeded for Phase 1b).
-- Phase 1b will add: synth_runs (audit log of summarizer runs).

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,                -- Discord message snowflake
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,         -- denormalized for query convenience
  guild_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,          -- nickname | globalName | username
  ts INTEGER NOT NULL,                -- unix epoch ms (message.createdTimestamp)
  content TEXT,                       -- nullable; pure-emoji/attachment messages may be empty
  reply_to_id TEXT,                   -- nullable; message.reference.messageId
  thread_root_id TEXT,                -- nullable; channel.parentId when channel is a thread
  attachments TEXT NOT NULL DEFAULT '[]',
                                      -- JSON array: [{filename, url, content_type, size}]
                                      -- Phase 1a does NOT download attachments to disk; URL only.
  edits TEXT NOT NULL DEFAULT '[]',   -- JSON array: [{ts, content}], appended on every edit
  deleted_at INTEGER,                 -- nullable; soft delete (epoch ms)
  reactions TEXT NOT NULL DEFAULT '{}'
                                      -- JSON object: {emoji_key: [user_id, ...]}
                                      -- emoji_key is reaction.emoji.name for unicode,
                                      -- "<:name:id>" for custom server emojis.
);
CREATE INDEX IF NOT EXISTS idx_messages_channel_ts ON messages(channel_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);

CREATE TABLE IF NOT EXISTS synth_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO synth_state (key, value) VALUES ('last_synth_run_ts', '0');
