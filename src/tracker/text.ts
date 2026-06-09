// Deterministic dedup backstop. The PRIMARY dedup is the prompt (the model sees
// the open list and is told to emit a `touch`, not a new `add`, for a re-mention).
// This is the belt-and-suspenders guard the reconcile applies before inserting.

/** Lowercase, strip punctuation, collapse whitespace, drop very short tokens. */
export function normalizeTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  );
}

/** Jaccard overlap of two token sets: |∩| / |∪|, in [0,1]. Empty sets → 0. */
export function tokenOverlap(a: string, b: string): number {
  const sa = normalizeTokens(a);
  const sb = normalizeTokens(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Default similarity threshold above which a new item is treated as a re-mention. */
export const DEDUP_OVERLAP_THRESHOLD = 0.6;
