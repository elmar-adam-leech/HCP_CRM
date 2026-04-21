import { storage } from "../storage";
import { BackgroundJob } from "./background-job";
import { providerService } from "../providers/provider-service";
import { gmailService } from "../gmail-service";
import type { SalesProcessTaskInstance, SalesProcessStep } from "@shared/schema";
import { logger } from "../utils/logger";

const log = logger("SalesProcessCron");

const TICK_MS = 60_000;
const BATCH_LIMIT = 25;
const MAX_ATTEMPTS = 5;
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

async function buildVariablesForLead(contractorId: string, leadId: string): Promise<{
  contactId: string | null;
  email: string | null;
  phone: string | null;
  vars: Record<string, string>;
}> {
  const lead = await storage.getLead(leadId, contractorId);
  if (!lead) return { contactId: null, email: null, phone: null, vars: {} };
  const contact = await storage.getContact(lead.contactId, contractorId);
  if (!contact) return { contactId: lead.contactId, email: null, phone: null, vars: {} };
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
      // Per spec: lead_source is a first-class template var so managers can
      // write "Thanks for reaching out via {{lead_source}}!".
      lead_source: lead.source ?? '',
    },
  };
}

// Look up the step for an instance via the by-process fetch.
async function resolveStepForInstance(
  instance: SalesProcessTaskInstance,
): Promise<SalesProcessStep | null> {
  const { steps } = await storage.getSalesProcessWithSteps(instance.contractorId);
  return steps.find(s => s.id === instance.stepId) ?? null;
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

  const { contactId, email, phone, vars } = await buildVariablesForLead(
    instance.contractorId,
    instance.leadId,
  );
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
        log.info(`sales_process instance_retry_scheduled tenantId=${inst.contractorId} leadId=${inst.leadId} stepId=${inst.stepId} instanceId=${inst.id} attempt=${liveAttempt} delayMin=${delayMin} reason=${result.error}`);
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

export class SalesProcessCron extends BackgroundJob {
  constructor(intervalMs: number = TICK_MS) {
    super(intervalMs);
  }

  protected async runOnce(): Promise<void> {
    const summary = await runDueAutoTasksOnce({ limit: BATCH_LIMIT });
    if (summary.claimed > 0) {
      log.info(`Sales-process tick: claimed=${summary.claimed} sent=${summary.sent} failed=${summary.failed} retry=${summary.skipped}`);
    }
  }
}

export const salesProcessCron = new SalesProcessCron();
