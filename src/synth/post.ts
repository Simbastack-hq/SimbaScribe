const CHUNK_LIMIT = 1900; // headroom under Discord's hard 2000-char content limit

export interface PostOutcome {
  chunksPosted: number;
  totalChunks: number;
  error: string | null;
}

/**
 * Splits into <=CHUNK_LIMIT pieces on line boundaries, hard-splitting any single
 * line that is itself longer than the limit. Never truncates — every character
 * of the digest ends up in some chunk.
 */
export function splitForDiscord(content: string, limit = CHUNK_LIMIT): string[] {
  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current.length > 0) chunks.push(current);
    current = '';
  };

  for (const line of content.split('\n')) {
    // A single line longer than the limit: hard-split it into limit-sized pieces.
    if (line.length > limit) {
      flush();
      let i = 0;
      while (i < line.length) {
        let end = Math.min(i + limit, line.length);
        if (end < line.length) {
          // Never cut inside a `<@\d+>` mention token: a bisected token corrupts
          // across chunks and the ping silently vanishes. If the slice would end
          // mid-token, back the cut off to the token's start so the whole token
          // moves to the next chunk. Tokens are ≤ ~24 chars ≪ limit, so the
          // `index > 0` guard always makes progress (a token can't fill a chunk).
          const open = line.slice(i, end).match(/<@\d*$/);
          if (open && open.index !== undefined && open.index > 0) end = i + open.index;
        }
        chunks.push(line.slice(i, end));
        i = end;
      }
      continue;
    }
    if (current.length + line.length + 1 > limit) {
      flush();
      current = line;
    } else {
      current = current.length > 0 ? `${current}\n${line}` : line;
    }
  }
  flush();
  return chunks.length > 0 ? chunks : [''];
}

/**
 * Posts the digest to a Discord channel webhook, one message per chunk.
 *
 * Returns how many chunks were posted (NOT throwing on a mid-batch failure) so
 * the caller can decide: nothing posted → safe to retry (don't advance the
 * watermark); something posted → must advance (re-posting would duplicate the
 * already-delivered chunks in the public channel).
 *
 * `allowedUserIds` is the opt-in @-mention allow-list (empty by default). Per
 * chunk we send only the IDs whose `<@id>` token actually appears in THAT chunk
 * (the digest spans multiple messages). When a chunk has none, the body is
 * `{ parse: [] }` — byte-identical to the long-standing safe default, so
 * `@everyone`/`@here`/roles can never fire. `{ parse: [], users: [...] }` is the
 * Discord-documented "only these users" form (the conflict is `"users"` IN parse
 * plus a users array — empty parse never conflicts).
 */
export async function postToWebhook(
  webhookUrl: string,
  content: string,
  allowedUserIds: readonly string[] = [],
): Promise<PostOutcome> {
  const chunks = splitForDiscord(content);
  let chunksPosted = 0;

  for (const chunk of chunks) {
    const idsInChunk = allowedUserIds.filter((id) => chunk.includes(`<@${id}>`));
    const allowed_mentions = idsInChunk.length > 0 ? { parse: [], users: idsInChunk } : { parse: [] };
    let res: Response;
    try {
      res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: chunk, allowed_mentions }),
      });
    } catch (err) {
      return { chunksPosted, totalChunks: chunks.length, error: `network error: ${String(err)}` };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        chunksPosted,
        totalChunks: chunks.length,
        error: `Discord webhook returned ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    chunksPosted += 1;
  }

  return { chunksPosted, totalChunks: chunks.length, error: null };
}
