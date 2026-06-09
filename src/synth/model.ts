import Anthropic from '@anthropic-ai/sdk';
import type { SynthConfig } from './config.js';

export interface SynthResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

// A 30-min team digest is short (a few hundred chars). 8192 is a generous
// safety ceiling — actual digests sit far below it — so hitting it signals a
// runaway, which we treat as an error (see the max_tokens check) rather than
// posting a truncated digest. Well under the streaming threshold.
const MAX_TOKENS = 8192;

/**
 * Runs the synth model via its Anthropic-protocol endpoint (the @anthropic-ai/sdk
 * client pointed at the provider's baseURL). The provider (baseUrl + model) and
 * the rendered system prompt come from the active workspace profile via config;
 * there is no hardcoded provider or fallback.
 *
 * On any error — transport, non-2xx, empty output, or max_tokens truncation —
 * this throws. The caller records the error, does NOT advance the watermark, and
 * exits non-zero; the next scheduled cron run re-summarizes the same (plus
 * newer) window. The cron cadence IS the retry.
 *
 * No prompt caching: the provider's /anthropic endpoint cache support is
 * unverified, and sending an unknown cache_control block risks a 400 on every
 * run. The per-token price makes the uncached system prompt cheap at this volume.
 */
export async function runModel(userMessage: string, config: SynthConfig): Promise<SynthResult> {
  const { provider } = config;
  const client = new Anthropic({ apiKey: provider.apiKey, baseURL: provider.baseUrl });

  const response = await client.messages.create({
    model: provider.model,
    max_tokens: MAX_TOKENS,
    system: config.systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  // Truncated output would be a partial digest (cut off mid-link). Treat as an
  // error so we retry next run rather than posting garbage.
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`model ${provider.model} hit max_tokens (${MAX_TOKENS}) — digest would be truncated`);
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  // Empty output is anomalous — the prompt's only "nothing to say" signal is the
  // literal string SKIP_POST, never empty. Throw so we don't mistake it for a skip.
  if (text === '') {
    throw new Error(`model ${provider.model} returned empty output`);
  }

  return {
    text,
    model: provider.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
