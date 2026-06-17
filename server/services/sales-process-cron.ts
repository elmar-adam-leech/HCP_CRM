import { storage } from "../storage";
import { providerService } from "../providers/provider-service";
import { gmailService } from "../gmail-service";
import { db } from "../db";
import { eq } from "drizzle-orm";
import { salesProcessSteps, type SalesProcessTaskInstance, type SalesProcessStep } from "@shared/schema";
import { logger } from "../utils/logger";

const log = logger("SalesProcessCron");

const BATCH_LIMIT = 25;
const MAX_ATTEMPTS = 5;
// Adaptive scheduling bounds. The cron sleeps until the next auto task is
// actually due (capped at MAX_SLEEP_MS) instead of waking on a fixed interval,
// and drains quickly (MIN_SLEEP_MS) when a full batch suggests more work is
// waiting. A `nudge()` from task materialization snaps it back to MIN_SLEEP_MS
// so freshly-created follow-ups still fire promptly.
const MIN_SLEEP_MS = 5_000;
const MAX_SLEEP_MS = 5 * 60_000;
// Exponential backoff in minutes after each failed attempt: 1, 2, 4, 8, 16.
// Used to delay the next retry by pushing dueAt forward when a soft-failure
// occurs. The cron will only re-claim a row whose dueAt <= now.
export function backoffMinutesAfterAttempt(liveAttempt: number): number {
  return Math.min(2 ** Math.max(0, liveAttempt - 1), 60);
}

interface RunSummary {
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
}

// Render {{var}} / legacy {var} placeholders. Unknown vars → ''.
function renderTemplate(template: string, vars: Record<string, string>): string {
  return template
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => vars[key] ?? '')
    .replace(/\{(\w+)\}/g, (_match, key) => vars[key] ?? '');
}

async function buildVariablesForInstance(instance: SalesProcessTaskInstance): Promise<{
  contactId: string | null;
  email: string | null;
  phone: string | null;
  vars: Record<string, string>;
}> {
  const empty = { contactId: null, email: null, phone: null, vars: {} };
  // Per-entity context. We compute only the fields that the template variable
  // surface needs (this is intentionally a small, opinionated map rather than
  // the full workflow variable extractor — sales-process templates are short
  // and the test surface needs to stay deterministic). Both branches always
  // resolve through the same downstream contact-lookup so contact-level
  // variables behave identically regardless of trigger entity.
  let contactId: string | null = null;
  let leadSource: string | null = null;
  let estimateNumber: string | null = null;
  let estimateTitle: string | null = null;
  let estimateAmount: string | null = null;
  let estimateStatus: string | null = null;
  if (instance.leadId) {
    const lead = await storage.getLead(instance.leadId, instance.contractorId);
    if (!lead) return empty;
    contactId = lead.contactId;
    leadSource = lead.source ?? null;
  } else if (instance.estimateId) {
    const estimate = await storage.getEstimate(instance.estimateId, instance.contractorId);
    if (!estimate) return empty;
    contactId = estimate.contactId;
    estimateNumber = (estimate as { estimateNumber?: string | null }).estimateNumber ?? null;
    estimateTitle = estimate.title ?? null;
    estimateAmount = estimate.amount != null ? String(estimate.amount) : null;
    estimateStatus = estimate.status ?? null;
  } else {
    return empty;
  }
  if (!contactId) return empty;
  const contact = await storage.getContact(contactId, instance.contractorId);
  if (!contact) return { contactId, email: null, phone: null, vars: {} };
  const fullName = contact.name ?? '';
  const [first, ...rest] = fullName.split(/\s+/);
  return {
    contactId: contact.id,
    email: contact.emails?.[0] ?? null,
    phone: contact.phones?.[0] ?? null,
    vars: {
      first_name: first ?? '',
      last_name: rest.join(' '),
      full_name: fullName,
      email: contact.emails?.[0] ?? '',
      phone: contact.phones?.[0] ?? '',
      // Entity-specific vars: blank when the trigger entity does not produce
      // them, so unknown placeholders render as empty strings rather than
      // "{first_name}" leaking through.
      lead_source: leadSource ?? '',
      estimate_number: estimateNumber ?? '',
      estimate_title: estimateTitle ?? '',
      estimate_amount: estimateAmount ?? '',
      estimate_status: estimateStatus ?? '',
    },
  };
}

// Look up the step for an instance directly by its stepId — we no longer
// assume one cadence per tenant.
async function resolveStepForInstance(
  instance: SalesProcessTaskInstance,
): Promise<SalesProcessStep | null> {
  const r = await db.select().from(salesProcessSteps)
    .where(eq(salesProcessSteps.id, instance.stepId))
    .limit(1);
  return r[0] ?? null;
}

async function sendAutoTask(instance: SalesProcessTaskInstance): Promise<{ ok: boolean; error?: string }> {
  const step = await resolveStepForInstance(instance);
  if (!step) {
    return { ok: false, error: 'Step no longer exists for this task' };
  }
  if (step.mode !== 'auto') {
    return { ok: false, error: 'Step is no longer in auto mode' };
  }
  if (!step.messageTemplate || step.messageTemplate.trim().length === 0) {
    return { ok: false, error: 'Step has no message template' };
  }

  const { contactId, email, phone, vars } = await buildVariablesForInstance(instance);
  const message = renderTemplate(step.messageTemplate, vars);

  if (instance.actionType === 'text') {
    if (!phone) return { ok: false, error: 'Contact has no phone number' };
    const result = await providerService.sendSms({
      to: phone,
      message,
      contractorId: instance.contractorId,
    });
    if (!result.success) return { ok: false, error: result.error || 'SMS send failed' };
    if (contactId) {
      try {
        await storage.createMessage({
          type: 'text',
          status: 'sent',
          direction: 'outbound',
          content: message,
          toNumber: phone,
          fromNumber: null,
          contactId,
          userId: null,
          externalMessageId: result.messageId ?? null,
        }, instance.contractorId);
      } catch (err) {
        log.warn(`Sent SMS but failed to persist message record (instance: ${instance.id})`, { err });
      }
    }
    return { ok: true };
  }

  if (instance.actionType === 'email') {
    if (!email) return { ok: false, error: 'Contact has no email address' };
    const sharedAccount = await storage.getSharedEmailAccount(instance.contractorId);
    if (!sharedAccount) {
      return { ok: false, error: 'No shared company email is configured for auto-send' };
    }
    const subject = `Following up`;
    const result = await gmailService.sendEmail({
      to: email,
      subject,
      content: message,
      refreshToken: sharedAccount.gmailRefreshToken,
      fromEmail: sharedAccount.email,
      fromName: sharedAccount.displayName || sharedAccount.email,
    });
    if (!result.success) return { ok: false, error: result.error || 'Email send failed' };
    try {
      await storage.createActivity({
        type: 'email',
        title: `Email sent: ${subject}`,
        content: message,
        metadata: {
          subject,
          to: [email],
          from: sharedAccount.email,
          messageId: result.messageId,
          rfc822MessageId: result.rfc822MessageId,
          direction: 'outbound',
          source: 'sales_process',
        },
        contactId,
        userId: null,
        externalId: result.messageId ?? null,
        externalSource: 'gmail',
      }, instance.contractorId);
    } catch (err) {
      log.warn(`Sent email but failed to persist activity record (instance: ${instance.id})`, { err });
    }
    return { ok: true };
  }

  // 'call' — auto calls are not supported; the route layer rejects auto+call
  // on save, but if a stale row slipped through, fail it cleanly.
  return { ok: false, error: 'Auto calls are not supported' };
}

// One cron pass: claim due auto tasks and send them.
export async function runDueAutoTasksOnce(
  opts: { limit?: number; now?: Date; contractorId?: string } = {},
): Promise<RunSummary> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? BATCH_LIMIT;
  // When `contractorId` is supplied (manager-triggered /run-now), the claim
  // is strictly tenant-scoped so we never dispatch another tenant's auto
  // tasks. The unattended interval-driven cron passes no contractorId and
  // claims globally as before.
  const claimed = await storage.claimDueAutoTasks(now, limit, opts.contractorId);
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const inst of claimed) {
    // claimDueAutoTasks executes `SET attempt_count = t.attempt_count + 1
    // RETURNING t.*` so the returned row's attemptCount is the POST-
    // increment value. liveAttempt is therefore inst.attemptCount itself
    // — the prior +1 was an off-by-one that caused permanent failure
    // after 4 tries instead of the spec's 5.
    const liveAttempt = inst.attemptCount;
    try {
      const result = await sendAutoTask(inst);
      if (result.ok) {
        await storage.markTaskCompleted(inst.id, inst.contractorId, 'auto_sent', null);
        sent += 1;
      } else if (liveAttempt >= MAX_ATTEMPTS) {
        await storage.markTaskFailed(inst.id, inst.contractorId, result.error ?? 'Send failed');
        failed += 1;
        log.warn(`Sales-process auto task failed permanently (instance: ${inst.id}): ${result.error}`);
      } else {
        // Soft failure — push dueAt out by exponential backoff so we don't
        // hammer a flaky provider on every 60s tick.
        const delayMin = backoffMinutesAfterAttempt(liveAttempt);
        const nextDueAt = new Date(now.getTime() + delayMin * 60_000);
        await storage.rescheduleTaskForRetry(inst.id, inst.contractorId, nextDueAt);
        skipped += 1;
        log.info(`sales_process instance_retry_scheduled tenantId=${inst.contractorId} entity=${inst.leadId ? `lead:${inst.leadId}` : `estimate:${inst.estimateId}`} stepId=${inst.stepId} instanceId=${inst.id} attempt=${liveAttempt} delayMin=${delayMin} reason=${result.error}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (liveAttempt >= MAX_ATTEMPTS) {
        await storage.markTaskFailed(inst.id, inst.contractorId, msg);
        failed += 1;
      } else {
        const delayMin = backoffMinutesAfterAttempt(liveAttempt);
        const nextDueAt = new Date(now.getTime() + delayMin * 60_000);
        await storage.rescheduleTaskForRetry(inst.id, inst.contractorId, nextDueAt);
        skipped += 1;
      }
      log.warn(`Sales-process auto task threw (instance: ${inst.id})`, { err });
    }
  }

  return { claimed: claimed.length, sent, failed, skipped };
}

/**
 * Adaptive, self-scheduling cron for due auto-mode sales-process tasks.
 *
 * Instead of waking every 60 s around the clock, each tick computes how long to
 * sleep before the next task is actually due (capped at MAX_SLEEP_MS) and arms a
 * single `setTimeout`. When there is nothing pending it sleeps the full cap;
 * when a tick claims a full batch it drains quickly; and `nudge()` (called when
 * new auto tasks are materialized) snaps the next tick back to MIN_SLEEP_MS so
 * follow-ups still fire on time. Behaviour is unchanged from the caller's
 * perspective — only the wake cadence is leaner.
 */
export class SalesProcessCron {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticking = false;
  private nudged = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    // First pass shortly after boot to drain anything that came due while down.
    this.schedule(MIN_SLEEP_MS);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Reset the schedule to fire soon. Called when new auto tasks are created so
   * a freshly-materialized follow-up does not wait out the current sleep.
   */
  nudge(): void {
    if (!this.running) return;
    if (this.ticking) {
      // A tick is in flight; let its reschedule honor the nudge instead of
      // racing it with a second timer.
      this.nudged = true;
      return;
    }
    this.schedule(MIN_SLEEP_MS);
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    this.ticking = true;
    this.nudged = false;
    let nextDelay = MAX_SLEEP_MS;
    try {
      const summary = await runDueAutoTasksOnce({ limit: BATCH_LIMIT });
      if (summary.claimed > 0) {
        log.info(`Sales-process tick: claimed=${summary.claimed} sent=${summary.sent} failed=${summary.failed} retry=${summary.skipped}`);
      }
      if (summary.claimed >= BATCH_LIMIT) {
        // Full batch — more rows are likely already due; drain quickly.
        nextDelay = MIN_SLEEP_MS;
      } else {
        nextDelay = await this.computeSleepUntilNextDue();
      }
    } catch (err) {
      log.warn("Sales-process tick failed", { err });
      nextDelay = MAX_SLEEP_MS;
    } finally {
      this.ticking = false;
      if (this.nudged) {
        this.nudged = false;
        nextDelay = MIN_SLEEP_MS;
      }
      this.schedule(nextDelay);
    }
  }

  private async computeSleepUntilNextDue(): Promise<number> {
    const next = await storage.getNextDueAutoTaskAt();
    if (!next) return MAX_SLEEP_MS;
    const delta = next.getTime() - Date.now();
    if (delta <= 0) return MIN_SLEEP_MS;
    return Math.min(Math.max(delta, MIN_SLEEP_MS), MAX_SLEEP_MS);
  }
}

export const salesProcessCron = new SalesProcessCron();
