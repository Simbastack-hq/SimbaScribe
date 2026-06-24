import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { optionalPositiveInt } from '../config.js';
import type { Reconciliation } from './types.js';

// Tunable for busier workspaces: a reconcile that exceeds the cap throws (the
// isolated tracker step swallows it, so the digest is unaffected) but the
// tracker watermark does not advance, so an under-sized cap can wedge the
// tracker into a compounding retry loop. Raise via SIMBASCRIBE_TRACKER_MAX_TOKENS.
const MAX_TOKENS = optionalPositiveInt('SIMBASCRIBE_TRACKER_MAX_TOKENS', 4096);

// Structural validation of the model's JSON (shape only — SEMANTIC validation
// against open items / window ids is validateReconciliation's job). Unknown keys
// are stripped; a missing array defaults to empty so a terse model reply is fine.
const NewItemSchema = z.object({
  kind: z.enum(['todo', 'idea', 'decision', 'question']),
  text: z.string(),
  owner: z.string().nullable().default(null),
  owner_id: z.string().nullable().default(null),
  confidence: z.enum(['high', 'low']),
  blocked: z.boolean().default(false),
  source_msg_id: z.string(),
});
const ResolutionSchema = z.object({
  target_id: z.number().int(),
  type: z.enum(['done', 'answered', 'superseded']),
  strength: z.enum(['strong', 'weak']),
  evidence_msg_id: z.string(),
});
const TouchSchema = z.object({
  target_id: z.number().int(),
  evidence_msg_id: z.string(),
});
export const ReconciliationSchema = z.object({
  new_items: z.array(NewItemSchema).default([]),
  resolutions: z.array(ResolutionSchema).default([]),
  touches: z.array(TouchSchema).default([]),
});

/** Strip ```json fences if the model wrapped its output despite instructions. */
function stripFences(s: string): string {
  const t = s.trim();
  if (t.startsWith('```')) {
    return t.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
  }
  return t;
}

/** Parse + structurally validate raw model text into a Reconciliation. Throws on
 *  unparseable/!schema output — the caller swallows it (tracker is isolated). */
export function parseReconciliation(raw: string): Reconciliation {
  const text = stripFences(raw);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`reconcile output is not valid JSON: ${text.slice(0, 200)}`);
  }
  const parsed = ReconciliationSchema.parse(json);
  return parsed as Reconciliation;
}

export interface ReconcileModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** The reconcile system prompt, rendered from the workspace profile. Passed in
   *  (not read here) so the render happens inside the synth's tracker-step swallow
   *  boundary — a missing/bad skeleton degrades only the tracker, never the digest. */
  systemPrompt: string;
}

/**
 * The SEPARATE reconcile model call — distinct from the digest's runModel, which
 * stays unchanged. Same provider/model, different (profile-rendered) system
 * prompt, structured-JSON output. Returns the parsed (structurally-valid)
 * Reconciliation; the caller then runs validateReconciliation (semantic) before
 * applying. Throws on transport/empty/truncated/parse error — fully swallowed by
 * the isolated tracker step, so the digest is never affected.
 */
export async function runReconcileModel(
  userMessage: string,
  config: ReconcileModelConfig,
): Promise<Reconciliation> {
  const client = new Anthropic({ apiKey: config.apiKey, baseURL: config.baseUrl });
  const response = await client.messages.create({
    model: config.model,
    max_tokens: MAX_TOKENS,
    system: config.systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`reconcile hit max_tokens (${MAX_TOKENS}) — output would be truncated`);
  }
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (text === '') throw new Error('reconcile model returned empty output');
  return parseReconciliation(text);
}
