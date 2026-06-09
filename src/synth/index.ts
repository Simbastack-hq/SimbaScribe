import { pathToFileURL } from 'node:url';
import { openDb, type Db } from '../db/client.js';
import { log } from '../log.js';
import { loadSynthConfig, type SynthConfig } from './config.js';
import { parseArgs } from './args.js';
import { runModel } from './model.js';
import { formatWindow } from './window.js';
import { postToWebhook } from './post.js';
import { runTrackerStep, type SurfacingDeps } from '../tracker/tracker-step.js';
import { runReconcileModel } from '../tracker/reconcile-model.js';
import { makeReactionReader, makeItemPoster } from '../tracker/discord-rest.js';
import { renderTrackerPrompt } from '../profile/render.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Cap on per-item ✅/❌ messages per run, to bound channel noise. */
const MAX_ITEM_MESSAGES = 10;
import {
  ensureSynthSchema,
  getRowidWatermark,
  setRowidWatermark,
  getMaxMessageRowid,
  readWindowByRowid,
  readWindowByTs,
  getLatestRun,
  insertRun,
  markPostedAndAdvance,
  markSkippedAndAdvance,
  markPartialAndAdvance,
  markError,
  type WindowMessage,
} from './store.js';

const SKIP_TOKEN = 'SKIP_POST';

/**
 * The swallow boundary, extracted + injectable so the isolation guarantee is a
 * TESTED invariant rather than a code-reading claim. `step` is the work to
 * isolate; ANY rejection is logged and absorbed — this never rejects. Returns
 * true if the step ran clean, false if it was swallowed (for tests/observability).
 *
 * NOTE: every failure mode of the tracker step (config, model, prompt-file read,
 * parse, validate, sqlite) must occur INSIDE `step` so it lands here — e.g. the
 * reconcile prompt is loaded lazily, not at import, for exactly this reason.
 */
export async function isolateTrackerStep(step: () => Promise<unknown>): Promise<boolean> {
  try {
    const res = await step();
    log.info({ tracker: res }, 'tracker reconcile step complete');
    return true;
  } catch (err) {
    // Swallow: a tracker failure must never break the (already-handled) digest.
    log.error({ err }, 'tracker reconcile step failed (digest unaffected, will retry next run)');
    return false;
  }
}

async function runTrackerStepSafely(
  db: Db,
  config: SynthConfig,
  synthRunId: number | null,
): Promise<void> {
  if (config.trackerDbPath === null) return;
  const trackerDbPath = config.trackerDbPath;
  const surfacing = buildSurfacingDeps(config);
  await isolateTrackerStep(() => {
    // Render the tracker prompt HERE — inside the swallow boundary, not at
    // startup — so a missing/bad prompt skeleton degrades only the tracker and
    // never the (already-handled) digest.
    const trackerSystemPrompt = renderTrackerPrompt(config.profile);
    return runTrackerStep(
      db,
      { trackerDbPath, discordGuildId: config.discordGuildId },
      (userMessage) =>
        runReconcileModel(userMessage, {
          apiKey: config.provider.apiKey,
          baseUrl: config.provider.baseUrl,
          model: config.provider.model,
          systemPrompt: trackerSystemPrompt,
        }),
      Date.now(),
      synthRunId,
      surfacing,
    );
  });
}

/**
 * Build the nag-loop deps when surfacing is ENABLED and its preconditions hold.
 * Returns undefined → the tracker step stays in shadow mode (the default). A
 * missing webhook disables surfacing entirely (nothing to post to); a missing
 * bot token degrades to post-only (no reaction reads). Either way the digest is
 * never affected — this only enriches the already-isolated tracker step.
 */
export function buildSurfacingDeps(config: SynthConfig): SurfacingDeps | undefined {
  if (!config.surfacingEnabled) return undefined;
  const { confirmEmoji, vetoEmoji, aging } = config.profile;

  // Surfacing has hard preconditions. If any is unmet we degrade to SHADOW (no
  // posts, no aging) rather than running a broken loop — crucially, aging must
  // NOT run when we can't read corrections, or it would archive items a human
  // tried to keep. The digest is never affected either way.
  const reasons: string[] = [];
  if (config.webhookUrl === null) reasons.push('SIMBASCRIBE_OUTPUT_WEBHOOK_URL unset (nothing to post to)');
  if (config.botToken === null) reasons.push('DISCORD_BOT_TOKEN unset (cannot read ✅/❌ — aging without corrections is unsafe)');
  if (confirmEmoji === vetoEmoji) reasons.push('confirmEmoji and vetoEmoji are identical (a ✅ would be read as a ❌)');
  if (reasons.length > 0) {
    log.warn({ reasons }, 'tracker surfacing enabled but preconditions unmet — staying in shadow reconcile (no posts, no aging)');
    return undefined;
  }

  return {
    emojis: { confirmEmoji, vetoEmoji },
    aging: {
      todoResurfaceMs: aging.todoResurfaceDays * DAY_MS,
      todoArchiveGraceMs: aging.todoArchiveGraceDays * DAY_MS,
      ideaRevisitMs: aging.ideaRevisitDays * DAY_MS,
    },
    read: makeReactionReader(config.botToken as string, [confirmEmoji, vetoEmoji]),
    post: makeItemPoster(config.webhookUrl as string),
    maxItemMessages: MAX_ITEM_MESSAGES,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadSynthConfig({ requirePostingVars: !args.dryRun });
  log.level = config.logLevel;

  const db = openDb(config.dbPath);
  try {
    ensureSynthSchema(db);

    // Surface an ambiguous prior run (posted-status unknown — drafted, no error
    // recorded, never marked posted). Don't auto-repost; just warn loudly.
    const latest = getLatestRun(db);
    if (latest && latest.posted === 0 && latest.digest_text !== null && latest.error === null) {
      log.warn(
        { runId: latest.id },
        'previous run post-status ambiguous (digest drafted, not marked posted, no error) — possible duplicate; check #simbascribe',
      );
    }

    // ---- Resolve the window -------------------------------------------------
    let messages: WindowMessage[];
    let windowStartRowid: number | null = null;

    if (args.windowStart !== null && args.windowEnd !== null) {
      // Manual ts-window override (always dry-run; parseArgs enforces that).
      messages = readWindowByTs(db, args.windowStart, args.windowEnd);
      log.info(
        { start: args.windowStart, end: args.windowEnd, count: messages.length },
        'manual ts-window (dry-run)',
      );
    } else {
      const lastRowid = getRowidWatermark(db);
      if (lastRowid === null) {
        // First boot: start from "now", don't summarize the historical corpus.
        const maxRowid = getMaxMessageRowid(db);
        setRowidWatermark(db, maxRowid);
        log.info({ maxRowid }, 'first synth boot — initialized rowid watermark, skipping history');
        // The tracker has its own watermark + first-boot; let it initialize too.
        if (!args.dryRun) await runTrackerStepSafely(db, config, null);
        return;
      }
      windowStartRowid = lastRowid;
      messages = readWindowByRowid(db, lastRowid);
    }

    if (messages.length === 0) {
      log.info('empty window — nothing to summarize, no model call');
      // The tracker has its OWN watermark + lifecycle (aging/surfacing): it must
      // run even when the digest window is empty — a quiet day is exactly when a
      // stale todo should resurface. Non-dry only (it writes state + posts).
      if (!args.dryRun) await runTrackerStepSafely(db, config, null);
      return;
    }

    const maxRowid = messages.reduce((max, m) => (m.rowid > max ? m.rowid : max), 0);
    const userMessage = formatWindow(messages, config.discordGuildId);

    // ---- One model call -----------------------------------------------------
    // runModel guarantees non-empty text (it throws on empty output, which
    // propagates to the fatal handler → exit 1, no watermark advance). So the
    // ONLY skip signal is the literal SKIP_POST — empty is never a skip.
    const result = await runModel(userMessage, config);
    const isSkip = result.text === SKIP_TOKEN;

    // ---- Dry run: print, don't post, don't advance --------------------------
    if (args.dryRun) {
      log.info(
        {
          model: result.model,
          messages: messages.length,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        },
        'dry-run complete (no post, watermark unchanged)',
      );
      process.stdout.write('\n===== SYNTH DRY-RUN OUTPUT =====\n');
      process.stdout.write(isSkip ? 'SKIP_POST (no signal in window)\n' : `${result.text}\n`);
      process.stdout.write('================================\n\n');
      return;
    }

    // ---- SKIP_POST: audit + advance, no post --------------------------------
    if (isSkip) {
      const runId = insertRun(db, {
        startedAt: nowMs(),
        windowStartRowid,
        windowEndRowid: maxRowid,
        messagesProcessed: messages.length,
        digestText: null,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });
      markSkippedAndAdvance(db, runId, nowMs(), maxRowid);
      log.info({ runId, messages: messages.length }, 'no signal — SKIP_POST, watermark advanced');
      // A SKIP_POST window (no digest-worthy signal) can still contain a
      // trackable todo — run the isolated tracker step before returning.
      await runTrackerStepSafely(db, config, runId);
      return;
    }

    // ---- Real digest: pending row -> post -> advance ------------------------
    const runId = insertRun(db, {
      startedAt: nowMs(),
      windowStartRowid,
      windowEndRowid: maxRowid,
      messagesProcessed: messages.length,
      digestText: result.text,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });

    const outcome = await postToWebhook(config.webhookUrl!, result.text);

    if (outcome.chunksPosted === 0) {
      // Nothing delivered → safe to retry. Don't advance the watermark.
      markError(db, runId, nowMs(), outcome.error ?? 'post failed');
      log.error(
        { runId, err: outcome.error },
        'webhook post failed (nothing delivered) — digest preserved, watermark NOT advanced (next run retries)',
      );
      process.exitCode = 1;
      return;
    }

    if (outcome.chunksPosted < outcome.totalChunks) {
      // Partial delivery → MUST advance (re-posting would duplicate delivered
      // chunks). Record the loss loudly; full digest stays in synth_runs.
      const note = `partial post: ${outcome.chunksPosted}/${outcome.totalChunks} chunks delivered; ${outcome.error ?? 'unknown'}`;
      markPartialAndAdvance(db, runId, nowMs(), maxRowid, note);
      log.error({ runId, note }, 'PARTIAL webhook post — watermark advanced to avoid duplicate; lost tail preserved in synth_runs');
      process.exitCode = 1;
      return;
    }

    markPostedAndAdvance(db, runId, nowMs(), maxRowid);
    log.info(
      { runId, model: result.model, messages: messages.length, chunks: outcome.totalChunks, outputTokens: result.outputTokens },
      'digest posted, watermark advanced',
    );
    // Digest is safely posted + watermark advanced — now the isolated tracker
    // step. Anything it does is swallowed; the digest is already done.
    await runTrackerStepSafely(db, config, runId);
  } finally {
    db.close();
  }
}

function nowMs(): number {
  return Date.now();
}

// Run only when invoked directly (cron: `node dist/synth/index.js`), NOT when
// imported (tests import isolateTrackerStep from here). Same idiom as snapshot.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    log.fatal({ err }, 'synth run failed');
    process.exit(1);
  });
}
