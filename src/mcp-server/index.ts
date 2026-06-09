import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  withSnapshot,
  listChannels,
  recentMessages,
  searchMessages,
  messagesInWindow,
  getMessage,
} from './db.js';
import {
  readTracker,
  listItems,
  getItem,
  type TrackerKind,
  type TrackerStatus,
} from './tracker-db.js';
import { readKb, listDocs, searchKb, getDoc, clampLimit as clampKbLimit } from './kb.js';

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(`${name} is required (absolute path to the read-only SQLite corpus snapshot)`);
  }
  return v;
}

/**
 * Runs a read against the tracker snapshot, degrading gracefully: an unset path
 * or any open failure becomes a clear tool error, never a throw. The tracker is
 * an OPTIONAL, independently-published feed — its absence must never break the
 * corpus tools or take the server down (spec §4). The decision logic lives in
 * readTracker() (testable); this just maps the result to an MCP envelope.
 */
function withTracker<T>(fn: (db: import('better-sqlite3').Database) => T) {
  const r = readTracker(process.env.SIMBASCRIBE_TRACKER_SNAPSHOT_DB_PATH, fn);
  return r.ok ? ok(r.value) : err(r.error);
}

function err(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

/**
 * Runs a read against the knowledge base (SIMBASCRIBE_KB_PATH), degrading the
 * same way the tracker does: an unset path or a missing/bad dir becomes a clear
 * tool error, never a throw — the kb_* tools are an OPTIONAL, independent source
 * and their absence must not affect the corpus or tracker tools.
 */
function withKb<T>(fn: (root: string) => T) {
  const r = readKb(process.env.SIMBASCRIBE_KB_PATH, fn);
  return r.ok ? ok(r.value) : err(r.error);
}

const KINDS: readonly TrackerKind[] = ['todo', 'idea', 'decision', 'question'];
const STATUSES: readonly TrackerStatus[] = [
  'open',
  'done',
  'answered',
  'superseded',
  'dismissed',
  'archived',
];

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

async function main(): Promise<void> {
  const dbPath = requireEnv('SIMBASCRIBE_SNAPSHOT_DB_PATH');

  // Fail loud at startup if the snapshot is missing/unreadable OR isn't actually
  // our corpus — probe the schema so a wrong/empty SQLite file is caught before
  // any tool is registered, not on the first query.
  withSnapshot(dbPath, (db) => db.prepare('SELECT id FROM messages LIMIT 1').get());

  const server = new McpServer({ name: 'simbascribe-corpus', version: '0.1.0' });

  server.tool(
    'list_channels',
    'List channels in the captured corpus with message_count and last_ts (epoch ms). Use it to discover exact channel names before filtering other tools.',
    {},
    async () => ok(withSnapshot(dbPath, (db) => listChannels(db))),
  );

  server.tool(
    'recent_messages',
    'Most recent messages, newest first. Optional channel filter (exact channel name or id). limit is clamped to 1..200 (default 50). Every row carries a Discord url for citation.',
    { channel: z.string().optional(), limit: z.number().int().optional() },
    async (args) => ok(withSnapshot(dbPath, (db) => recentMessages(db, args))),
  );

  server.tool(
    'search_messages',
    'ASCII case-insensitive substring search over message content. Searches ORIGINAL content only — text added in a later edit is not matched. Optional channel filter. limit clamped 1..200 (default 50).',
    { query: z.string().min(1), channel: z.string().optional(), limit: z.number().int().optional() },
    async (args) => ok(withSnapshot(dbPath, (db) => searchMessages(db, args))),
  );

  server.tool(
    'messages_in_window',
    'Messages with ts within [startTs, endTs] (epoch ms, both inclusive), in chronological order. Optional channel filter. limit clamped 1..200 (default 50).',
    {
      startTs: z.number().int(),
      endTs: z.number().int(),
      channel: z.string().optional(),
      limit: z.number().int().optional(),
    },
    async (args) => ok(withSnapshot(dbPath, (db) => messagesInWindow(db, args))),
  );

  server.tool(
    'get_message',
    'Fetch one message by its Discord id, plus the message it replied to (if any), for citation context. Returns null if the message is not found or was deleted.',
    { id: z.string().min(1) },
    async ({ id }) => ok(withSnapshot(dbPath, (db) => getMessage(db, id))),
  );

  // --- Tracker tools (read-only over the tracker snapshot) -------------------
  // The tracker is the team's durable, auto-maintained todo/idea/decision list.
  // These tools are independent of the corpus snapshot above: if the tracker
  // snapshot is missing they return a "tracker unavailable" error and the
  // corpus tools keep working.

  server.tool(
    'tracker_list',
    "List tracked items — the team's durable todos/ideas/decisions inferred from chat. Defaults to OPEN items, ranked pinned > blocked > high-confidence > most-recent. Filter by kind, owner (use it to answer \"what's on <person>'s plate?\" — matches Discord id or canonical name), status, or blocked. limit clamped 1..200 (default 50). Each item carries a Discord source url.",
    {
      kind: z.enum(KINDS as [TrackerKind, ...TrackerKind[]]).optional(),
      owner: z.string().optional(),
      status: z.enum(STATUSES as [TrackerStatus, ...TrackerStatus[]]).optional(),
      blocked: z.boolean().optional(),
      limit: z.number().int().optional(),
    },
    async (args) => withTracker((db) => listItems(db, args)),
  );

  server.tool(
    'tracker_get',
    'Fetch one tracked item by its numeric tracker id, plus its full event history (created/touched/closed/pinned/…) — answers "why is this here, when did it close, who confirmed". Returns null if no such item.',
    { id: z.number().int() },
    async ({ id }) => withTracker((db) => getItem(db, id)),
  );

  // --- Knowledge-base tools (read-only over the team's curated markdown) ------
  // A third source alongside the corpus + tracker: hand-written reference docs
  // (runbooks, policies, how-tos). Independent of both — if SIMBASCRIBE_KB_PATH is
  // unset they return "kb unavailable" and the other tools keep working.

  server.tool(
    'kb_list',
    "List the team's knowledge-base documents (curated markdown — runbooks, policies, how-tos) with their titles + paths. Use it to discover what reference material exists before kb_search / kb_get.",
    {},
    async () => withKb((root) => listDocs(root)),
  );

  server.tool(
    'kb_search',
    'Case-insensitive search across the team knowledge base. Returns matching sections, each with the file + heading to cite. Prefer this for "how do we…", "what\'s our policy on…", "where is X documented" — questions about durable reference material rather than chat history. limit clamped 1..100 (default 20).',
    { query: z.string().min(1), limit: z.number().int().optional() },
    async (args) => withKb((root) => searchKb(root, args.query, clampKbLimit(args.limit))),
  );

  server.tool(
    'kb_get',
    'Fetch one knowledge-base document by its path (as returned by kb_list / kb_search). Returns { file, content } or null. Read-only and restricted to *.md inside the KB directory.',
    { file: z.string().min(1) },
    async ({ file }) => withKb((root) => getDoc(root, file)),
  );

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  // stdout is the MCP stdio channel — log only to stderr — then exit non-zero.
  console.error('[simbascribe-mcp] fatal:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
