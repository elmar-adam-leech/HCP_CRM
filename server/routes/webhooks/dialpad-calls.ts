import type { Express, Request, Response } from "express";
import express from "express";
import { storage } from "../../storage";
import { webhookEvents, dialpadPhoneNumbers, activities } from "@shared/schema";
import { db } from "../../db";
import { eq, and, sql, desc } from "drizzle-orm";
import { webhookRateLimiter } from "../../middleware/rate-limiter";
import { normalizePhoneNumber, maskPhone } from "../../utils/phone-normalizer";
import { asyncHandler } from "../../utils/async-handler";
import { logger } from "../../utils/logger";
import { broadcastToContractor } from "../../websocket";
import { CredentialService } from "../../credential-service";
import type { DialpadCallEvent, DialpadCallOutcome } from "../../dialpad/types";
import { enqueueDialpadEvent } from "../../jobs/dialpad-event-worker";

const log = logger('DialpadCallsWebhook');

/**
 * Fallback: read the plaintext webhook_api_key directly from the contractors
 * table. Mirrors the same fallback used by dialpad-sms.ts.
 */
async function getPlaintextWebhookApiKey(tenantId: string): Promise<string | null> {
  try {
    const result = await db.execute(
      sql`SELECT webhook_api_key FROM contractors WHERE id = ${tenantId} LIMIT 1`
    );
    const rows = result.rows as Array<{ webhook_api_key: string | null }>;
    return rows[0]?.webhook_api_key ?? null;
  } catch {
    return null;
  }
}

/**
 * Dialpad-specific key resolver.
 * Mirrors dialpad-sms.ts exactly.
 */
async function dialpadKeyResolver(contractorId: string): Promise<string | null> {
  let storedApiKey: string | null;
  try {
    storedApiKey = await CredentialService.getCredential(contractorId, 'dialpad', 'webhook_api_key');
  } catch {
    storedApiKey = null;
  }
  return storedApiKey ?? getPlaintextWebhookApiKey(contractorId);
}

/**
 * Derive a human-readable call outcome from a Dialpad call event.
 */
function deriveOutcome(event: DialpadCallEvent): DialpadCallOutcome {
  const state = event.state?.toLowerCase();
  if (state === 'missed') return 'missed';
  if (state === 'cancelled' || state === 'canceled') return 'cancelled';
  if (state === 'voicemail' || state === 'voicemail_uploaded') return 'voicemail';
  if ((state === 'hangup' || state === 'all') && (event.duration ?? 0) > 0) return 'answered';
  if (state === 'hangup') return 'missed';
  return 'answered';
}

/**
 * Format duration in seconds to a human-readable string, e.g. "3m 12s".
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/**
 * Build the activity title from direction and outcome.
 */
function buildTitle(direction: 'inbound' | 'outbound', outcome: DialpadCallOutcome, duration?: number): string {
  const dirLabel = direction === 'inbound' ? 'Inbound call' : 'Outbound call';
  if (outcome === 'missed') return `Missed ${dirLabel.toLowerCase()}`;
  if (outcome === 'cancelled') return `Cancelled ${dirLabel.toLowerCase()}`;
  if (outcome === 'voicemail') return `${dirLabel} — voicemail`;
  if (duration && duration > 0) return `${dirLabel} — ${formatDuration(duration)}`;
  return dirLabel;
}

/**
 * Extract the recording URL (and whether it points at a voicemail) from a
 * Dialpad call payload. Checks `recording_details`, `recording_url`,
 * `voicemail_link`, and `voicemail_url` in priority order.
 */
function extractRecordingUrl(payload: DialpadCallEvent): { url: string | null; isVoicemail: boolean } {
  if (payload.recording_details && payload.recording_details.length > 0) {
    const url = payload.recording_details[0].url ?? null;
    if (url) return { url, isVoicemail: false };
  }
  const rawRecUrl = payload.recording_url;
  const recUrl = Array.isArray(rawRecUrl) ? rawRecUrl[0] ?? null : rawRecUrl ?? null;
  if (recUrl) return { url: recUrl, isVoicemail: false };
  const vmUrl = payload.voicemail_link ?? payload.voicemail_url ?? null;
  if (vmUrl) return { url: vmUrl, isVoicemail: true };
  return { url: null, isVoicemail: false };
}

/**
 * Rank for call outcomes — higher is "richer". Used so a later
 * voicemail_uploaded event upgrades a hangup-derived "answered"/"missed".
 */
function outcomeRank(o: DialpadCallOutcome): number {
  switch (o) {
    case 'voicemail': return 3;
    case 'answered': return 2;
    case 'missed': return 1;
    case 'cancelled': return 0;
  }
}

/**
 * Merge metadata from an incoming (newer) event into the existing activity
 * metadata. Rule: never overwrite a populated field with null/undefined.
 * For numeric fields like `duration`, prefer the larger value.
 * For `outcome`, prefer the richer outcome (see outcomeRank).
 */
function mergeCallMetadata(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, val] of Object.entries(incoming)) {
    if (val === null || val === undefined) continue;
    if (key === 'duration') {
      const cur = typeof merged.duration === 'number' ? merged.duration : 0;
      const next = typeof val === 'number' ? val : 0;
      merged.duration = Math.max(cur, next);
      continue;
    }
    if (key === 'outcome') {
      const cur = merged.outcome as DialpadCallOutcome | undefined;
      const next = val as DialpadCallOutcome;
      if (!cur || outcomeRank(next) > outcomeRank(cur)) merged.outcome = next;
      continue;
    }
    merged[key] = val;
  }
  return merged;
}

/**
 * Background processing for a single Dialpad call event. Runs after the
 * HTTP handler has already acked 200 to Dialpad. Throws on failure so the
 * worker can retry with backoff; final failures are recorded against the
 * audit row by the worker.
 */
export async function processDialpadCallEvent(
  payload: DialpadCallEvent,
  contractorId: string,
  webhookEventId: string,
): Promise<void> {
  const state = (payload.state ?? '').toLowerCase();

  // ------------------------------------------------------------------
  // Only process terminal call states (ended calls).
  // Ignore in-progress states like 'calling', 'ringing', 'connected'.
  // ------------------------------------------------------------------
  const terminalStates = ['hangup', 'all', 'missed', 'cancelled', 'canceled', 'voicemail', 'voicemail_uploaded'];

  if (!terminalStates.includes(state)) {
    log.info(`Ignoring non-terminal call state: ${state}`);
    await db.update(webhookEvents)
      .set({ processed: true, processedAt: new Date(), errorMessage: `Non-terminal state ignored: ${state}` })
      .where(eq(webhookEvents.id, webhookEventId));
    return;
  }

  const callId = payload.call_id?.toString();

  if (!callId) {
    log.warn('Call webhook payload missing call_id; skipping');
    await db.update(webhookEvents)
      .set({ processed: true, processedAt: new Date(), errorMessage: 'Missing call_id' })
      .where(eq(webhookEvents.id, webhookEventId));
    return;
  }

  // ------------------------------------------------------------------
  // Look up existing activity for this call_id. We no longer skip on
  // duplicate — instead we enrich the existing row so that a later
  // voicemail_uploaded event (which carries recording URLs) can attach
  // its data to the activity created by the earlier hangup event.
  // ------------------------------------------------------------------
  const existingRows = await db.select()
    .from(activities)
    .where(and(
      eq(activities.contractorId, contractorId),
      eq(activities.externalSource, 'dialpad'),
      eq(activities.externalId, callId),
    ))
    .orderBy(desc(activities.createdAt))
    .limit(1);
  const existingActivity = existingRows[0];

  // ------------------------------------------------------------------
  // Determine direction by matching numbers against tenant's Dialpad numbers
  // ------------------------------------------------------------------
  const dialpadNumbers = await db.select()
    .from(dialpadPhoneNumbers)
    .where(eq(dialpadPhoneNumbers.contractorId, contractorId));

  const normalizedDialpadNums = dialpadNumbers.map(dpn => normalizePhoneNumber(dpn.phoneNumber));

  const explicitExternalNumber = payload.external_number ?? payload.contact?.phone ?? payload.contact_number ?? null;

  const rawFrom = payload.from_number ?? null;
  const rawTo = payload.to_number ?? payload.internal_number ?? null;

  let direction: 'inbound' | 'outbound';
  let contactPhone: string | null;

  if (explicitExternalNumber) {
    contactPhone = explicitExternalNumber;
    if (payload.direction) {
      direction = payload.direction;
    } else {
      const internalNorm = payload.internal_number ? normalizePhoneNumber(payload.internal_number) : '';
      direction = normalizedDialpadNums.includes(internalNorm) ? 'inbound' : 'outbound';
      if (!internalNorm) direction = 'inbound';
    }
  } else {
    const normalizedFrom = rawFrom ? normalizePhoneNumber(rawFrom) : '';
    const normalizedTo = rawTo ? normalizePhoneNumber(rawTo) : '';

    if (payload.direction) {
      direction = payload.direction;
      contactPhone = direction === 'inbound' ? rawFrom : rawTo;
    } else if (normalizedFrom && normalizedDialpadNums.includes(normalizedFrom)) {
      direction = 'outbound';
      contactPhone = rawTo;
    } else if (normalizedTo && normalizedDialpadNums.includes(normalizedTo)) {
      direction = 'inbound';
      contactPhone = rawFrom;
    } else {
      direction = 'inbound';
      contactPhone = rawFrom;
      log.info(`Could not match direction for call_id=${callId}; defaulting to inbound`);
    }
  }

  log.info(`Call direction=${direction}, contactPhone=${maskPhone(contactPhone ?? '')}, callId=${callId}`);

  // ------------------------------------------------------------------
  // Find matching contact by phone number
  // ------------------------------------------------------------------
  let contactId: string | null = null;

  if (contactPhone) {
    const normalizedContactPhone = normalizePhoneNumber(contactPhone);
    let contact = await storage.getContactByPhone(normalizedContactPhone, contractorId);
    if (!contact) {
      contact = await storage.getContactByPhone(contactPhone, contractorId);
    }
    if (contact) {
      contactId = contact.id;
      log.info(`Matched contact ${contact.id} (${contact.name})`);
    } else if (existingActivity) {
      contactId = existingActivity.contactId ?? null;
      log.info(`No contact match in payload but existing activity present; reusing contactId=${contactId ?? 'null'}`);
    } else {
      log.info(`No contact found for phone ${maskPhone(contactPhone)}; recording as unmatched_contact`);
      await db.update(webhookEvents)
        .set({
          processed: true,
          processedAt: new Date(),
          errorMessage: `unmatched_contact: no contact for phone ${maskPhone(contactPhone)} (direction=${direction}, callId=${callId})`,
        })
        .where(eq(webhookEvents.id, webhookEventId));
      return;
    }
  } else if (existingActivity) {
    contactId = existingActivity.contactId ?? null;
    log.info(`No contact phone in follow-up payload; reusing existing activity's contactId=${contactId ?? 'null'}`);
  } else {
    log.info(`No contact phone available for call_id=${callId}; recording as unmatched_contact`);
    await db.update(webhookEvents)
      .set({
        processed: true,
        processedAt: new Date(),
        errorMessage: `unmatched_contact: no contact phone available (direction=${direction}, callId=${callId})`,
      })
      .where(eq(webhookEvents.id, webhookEventId));
    return;
  }

  // ------------------------------------------------------------------
  // Determine outcome and build activity content
  // ------------------------------------------------------------------
  const outcome = deriveOutcome(payload);
  const rawDuration = payload.duration ?? 0;
  const durationSeconds = rawDuration >= 1000 ? Math.round(rawDuration / 1000) : rawDuration;
  const title = buildTitle(direction, outcome, durationSeconds > 0 ? durationSeconds : undefined);

  const operatorName = payload.operator_name ?? payload.target?.name ?? null;

  const { url: recordingUrl, isVoicemail: isVoicemailLink } = extractRecordingUrl(payload);

  const buildContent = (t: string, recUrl: string | null, isVm: boolean, opName: string | null): string => {
    const note = opName ? ` (handled by ${opName})` : '';
    const recText = recUrl ? ` — [${isVm ? 'Voicemail' : 'Call recording'}](${recUrl})` : '';
    return `${t}${note}${recText}`;
  };

  const content = buildContent(title, recordingUrl, isVoicemailLink, operatorName);

  const incomingEventTs = typeof payload.event_timestamp === 'number' ? payload.event_timestamp : null;

  const incomingMetadata: Record<string, unknown> = {
    direction,
    outcome,
    duration: durationSeconds,
    callId,
    operatorName: operatorName ?? null,
    recording_url: recordingUrl,
    voicemail_link: payload.voicemail_link ?? null,
    recording_details: payload.recording_details ?? null,
    contactName: payload.contact?.name ?? null,
    event_timestamp: incomingEventTs,
    is_voicemail_link: recordingUrl ? isVoicemailLink : null,
  };

  if (existingActivity) {
    const existingMeta = (existingActivity.metadata ?? {}) as Record<string, unknown>;
    const existingEventTs = typeof existingMeta.event_timestamp === 'number'
      ? existingMeta.event_timestamp
      : 0;

    if (incomingEventTs !== null && incomingEventTs < existingEventTs) {
      log.info(`Stale call event ignored for call_id=${callId} (incoming=${incomingEventTs} < existing=${existingEventTs})`);
      await db.update(webhookEvents)
        .set({
          processed: true,
          processedAt: new Date(),
          errorMessage: `stale event ignored (event_timestamp ${incomingEventTs} < existing ${existingEventTs})`,
        })
        .where(eq(webhookEvents.id, webhookEventId));
      return;
    }

    const mergedMeta = mergeCallMetadata(existingMeta, incomingMetadata);

    const mergedDirection = (mergedMeta.direction as 'inbound' | 'outbound') ?? direction;
    const mergedOutcome = (mergedMeta.outcome as DialpadCallOutcome) ?? outcome;
    const mergedDuration = typeof mergedMeta.duration === 'number' ? mergedMeta.duration : durationSeconds;
    const mergedRecUrl = (mergedMeta.recording_url as string | null) ?? null;
    const mergedIsVm = mergedMeta.is_voicemail_link === true
      || (mergedRecUrl !== null && mergedOutcome === 'voicemail' && !mergedMeta.recording_details);
    const mergedOperatorName = (mergedMeta.operatorName as string | null) ?? null;
    const mergedTitle = buildTitle(mergedDirection, mergedOutcome, mergedDuration > 0 ? mergedDuration : undefined);
    const mergedContent = buildContent(mergedTitle, mergedRecUrl, mergedIsVm, mergedOperatorName);

    const updated = await storage.updateActivity(existingActivity.id, {
      title: mergedTitle,
      content: mergedContent,
      metadata: mergedMeta,
    }, contractorId);

    await db.update(webhookEvents)
      .set({
        processed: true,
        processedAt: new Date(),
        errorMessage: `enriched existing activity ${existingActivity.id}`,
      })
      .where(eq(webhookEvents.id, webhookEventId));

    if (updated) {
      broadcastToContractor(contractorId, {
        type: 'activity_updated',
        activity: updated,
        contactId,
      });
    }

    log.info(`Enriched existing call activity ${existingActivity.id} for call_id=${callId}`);
    return;
  }

  // ------------------------------------------------------------------
  // Create the activity
  // ------------------------------------------------------------------
  const activity = await storage.createActivity({
    type: 'call',
    title,
    content,
    metadata: incomingMetadata,
    contactId,
    externalId: callId,
    externalSource: 'dialpad',
  }, contractorId);

  await db.update(webhookEvents)
    .set({ processed: true, processedAt: new Date() })
    .where(eq(webhookEvents.id, webhookEventId));

  broadcastToContractor(contractorId, {
    type: 'activity_created',
    activity,
    contactId,
  });

  log.info(`Successfully logged call activity ${activity.id} for call_id=${callId}`);
}

export function registerDialpadCallsWebhookRoutes(app: Express): void {
  app.post("/api/webhooks/dialpad/calls/:tenantId", webhookRateLimiter, express.json(), asyncHandler(async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      log.info(`Received call webhook for tenant ${tenantId}`);

      // ------------------------------------------------------------------
      // Auth — performed inline so every 401 path writes a call.auth_failed
      // row with the raw payload before returning.  Failure modes covered:
      //   1. Contractor not found → 404 (no auth_failed row)
      //   2. Missing incoming key → 401 + auth_failed row
      //   3. No stored key configured → 401 + auth_failed row
      //   4. Key mismatch → 401 + auth_failed row
      // ------------------------------------------------------------------
      const contractor = await storage.getContractor(tenantId);
      if (!contractor) {
        log.error(`[dialpad-calls] Contractor not found: ${tenantId}`);
        res.status(404).json({ error: 'Contractor not found', message: 'The specified contractor ID does not exist' });
        return;
      }

      const incomingKey = (req.headers['x-api-key'] as string | undefined) ?? (req.query['key'] as string | undefined);

      const rejectWithAuthFailed = async (reason: string, statusJson: Record<string, string>): Promise<void> => {
        log.warn(`[dialpad-calls] Auth failure for tenant ${tenantId}: ${reason}`);
        try {
          await db.insert(webhookEvents).values({
            contractorId: tenantId,
            service: 'dialpad',
            eventType: 'call.auth_failed',
            payload: JSON.stringify(req.body),
            processed: true,
            processedAt: new Date(),
            errorMessage: `Authentication failed: ${reason}`,
          });
        } catch (dbErr) {
          log.error('[dialpad-calls] Failed to write auth_failed webhook_event row', dbErr);
        }
        res.status(401).json(statusJson);
      };

      if (!incomingKey) {
        await rejectWithAuthFailed('missing API key', {
          error: 'Missing API key',
          message: "Include your API key in the 'X-API-Key' header or 'key' query param",
        });
        return;
      }

      const storedKey = await dialpadKeyResolver(tenantId);
      if (!storedKey) {
        await rejectWithAuthFailed('no webhook API key configured for this contractor', {
          error: 'Webhook not configured',
          message: 'No webhook API key has been set up for this contractor.',
        });
        return;
      }

      if (storedKey !== incomingKey) {
        await rejectWithAuthFailed('invalid API key', {
          error: 'Invalid API key',
          message: 'The provided API key is not valid for this contractor',
        });
        return;
      }

      // Auth passed.
      const contractorId = tenantId;
      const payload = req.body as DialpadCallEvent;

      const state = (payload.state ?? '').toLowerCase();
      const eventType = `call.${state}`;

      // ------------------------------------------------------------------
      // Insert webhook_events audit row (processed: false). Once written,
      // we ack 200 immediately — the heavy work runs on the background
      // worker so Dialpad never times out waiting on slow DB queries.
      // ------------------------------------------------------------------
      const inserted = await db.insert(webhookEvents).values({
        contractorId,
        service: 'dialpad',
        eventType,
        payload: JSON.stringify(payload),
        processed: false,
      }).returning();

      const webhookEventId = inserted[0].id;

      res.status(200).json({ success: true, message: 'Call webhook accepted for processing' });

      enqueueDialpadEvent({
        webhookEventId,
        description: `dialpad-call ${eventType} ${webhookEventId}`,
        handler: () => processDialpadCallEvent(payload, contractorId, webhookEventId),
      });
    } catch (error) {
      log.error('Error accepting call webhook:', error);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: 'Failed to accept call webhook' });
      }
    }
  }));
}
