interface EditEntry {
  ts: number;
  content: string;
}

/**
 * The current text of a message: the latest edit's content if it was edited,
 * else the original content; '' if there is none. Falls back to the original
 * content on malformed `edits` JSON (one bad historical row must not break a
 * read).
 *
 * Lives here (not in src/synth) so the synth (Phase 1b) and the MCP server
 * (Phase 1.5b) resolve edited messages identically — divergence would make the
 * digest and the agent show different text for the same edited message.
 *
 * Structurally typed so any row carrying `content` + `edits` qualifies.
 */
export function effectiveContent(m: { content: string | null; edits: string }): string {
  try {
    const edits = JSON.parse(m.edits) as unknown;
    if (Array.isArray(edits) && edits.length > 0) {
      const last = edits[edits.length - 1] as EditEntry | undefined;
      if (last && typeof last.content === 'string') return last.content;
    }
  } catch {
    // fall through to original content
  }
  return m.content ?? '';
}
