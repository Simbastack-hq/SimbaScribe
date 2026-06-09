import type { WindowMessage } from '../synth/store.js';
import { effectiveContent } from '../db/content.js';
import type { TrackerItem } from './types.js';

/**
 * Builds the USER message for the reconcile model call: the open tracked items
 * (with their ids — so the model can reference them in resolutions/touches) plus
 * the new message window (with msg ids — so it can cite evidence/source). This
 * is a SEPARATE input from the digest's formatWindow; the digest is unchanged.
 *
 * Uses effective (edited) content, same as the digest. Reads Date.now() for the
 * per-item "age" hint, so not strictly pure — age is advisory context only.
 */
export function formatReconcileInput(
  openItems: TrackerItem[],
  messages: WindowMessage[],
): string {
  const itemsBlock =
    openItems.length === 0
      ? '(none open)'
      : openItems
          .map((i) => {
            const owner = i.owner ?? '—';
            const flags = [i.kind, `owner=${owner}`, `confidence=${i.confidence}`];
            if (i.blocked) flags.push('blocked');
            const ageDays = Math.max(0, Math.floor((Date.now() - i.last_seen_at) / 86_400_000));
            flags.push(`age=${ageDays}d`);
            return `#${i.id} [${flags.join(', ')}]: ${i.text}`;
          })
          .join('\n');

  const msgsBlock =
    messages.length === 0
      ? '(no new messages)'
      : messages
          .map((m) => {
            const content = effectiveContent(m).replace(/\s*\n\s*/g, ' ').trim();
            return `{${m.id}} [#${m.channel_name}] ${m.author_name} (id=${m.author_id}): ${content}`;
          })
          .join('\n');

  return [
    '## OPEN TRACKED ITEMS (reference by #id in resolutions/touches)',
    itemsBlock,
    '',
    '## NEW MESSAGES (cite {msg_id} as evidence/source; these are the ONLY valid evidence ids this run)',
    msgsBlock,
  ].join('\n');
}
