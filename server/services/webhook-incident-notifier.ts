import { db } from "../db";
import { notifications, webhookIncidents } from "@shared/schema";
import { eq } from "drizzle-orm";
import { storage } from "../storage";
import { broadcastToContractor } from "../websocket";
import { logger } from "../utils/logger";
import { formatDbError } from "../utils/db-error";
import { getLastAlertedAt, stampAlertThrottle } from "./webhook-alert-throttle";

const log = logger('WebhookIncidentNotifier');

// Task #710 / #712 — per-(contractor, service, kind) cooldown for incident
// paging. At most one email + one in-app notification per kind per
// contractor every 24 hours, even if the underlying incident keeps opening
// and closing (the flap pattern that was paging contractors every 5
// minutes). Single window applies to BOTH the HCP and Dialpad notifiers.
export const ALERT_THROTTLE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface NotifyWebhookIncidentParams {
  contractorId: string;
  incidentId: string;
  /** e.g. 'housecall-pro' or 'dialpad' — keyed into webhook_incident_alert_throttle.service. */
  service: string;
  /** e.g. 'staleness' | 'rejection' | 'health-check-failure' | 'subscription-missing' | 'poller-failure' | 'backlog' | 'failed-events' */
  kind: string;
  title: string;
  message: string;
  /** Deep-link surfaced on the in-app notification row. Defaults to /settings/integrations. */
  link?: string;
  /**
   * Service-specific email sender. Must return { sent, attempted } with the
   * same semantics as sendHcpIncidentEmail:
   *   - attempted = number of distinct admin recipients we tried to deliver to
   *   - sent      = number of those recipients for which the underlying API
   *                 call resolved successfully
   * MUST never throw — the notifier defends with a try/catch but a clean
   * { sent: 0, attempted: 0 } from a misconfigured channel is the
   * "no-recipients" sentinel that lets the in-app channel still consume the
   * cooldown.
   */
  sendEmail: () => Promise<{ sent: number; attempted: number }>;
}

/**
 * Single point of truth for "an incident just opened — page everyone."
 *
 * Behaviour mirrors the original HCP-only implementation (see
 * server/services/hcp-webhook-health.ts comments for the long-form
 * design notes). The only generalisation is that `service` is now an
 * input, so the same cooldown table covers both Housecall Pro and
 * Dialpad — keyed independently per (contractor, service, kind), which
 * is what gives us cross-service isolation: an HCP staleness cooldown
 * does NOT suppress a Dialpad staleness alert and vice versa.
 */
export async function notifyWebhookIncidentOpened(
  params: NotifyWebhookIncidentParams,
): Promise<void> {
  const { contractorId, incidentId, service, kind, title, message, link, sendEmail } = params;

  // Cooldown gate. If we've successfully paged this (contractor, service,
  // kind) within the throttle window, suppress BOTH email + in-app +
  // websocket. We still mark the incident notified so subsequent ticks
  // don't keep retrying the notify path. Lookup is BEFORE email so we
  // don't spam SendGrid either.
  try {
    const lastAlertedAt = await getLastAlertedAt(contractorId, service, kind);
    if (lastAlertedAt) {
      const elapsedMs = Date.now() - lastAlertedAt.getTime();
      if (elapsedMs < ALERT_THROTTLE_WINDOW_MS) {
        const nextEligibleAt = new Date(lastAlertedAt.getTime() + ALERT_THROTTLE_WINDOW_MS);
        log.warn(
          `Suppressing ${service}/${kind} alert for contractor ${contractorId} (cooldown active) — ` +
          `lastAlertedAt=${lastAlertedAt.toISOString()} nextEligibleAt=${nextEligibleAt.toISOString()} ` +
          `suppressedChannels=[email,in-app]`
        );
        await markIncidentNotified(incidentId, `${service}/${kind} (suppressed)`);
        return;
      }
    }
  } catch (err) {
    // Throttle lookup failure must NOT block the alert — fall through
    // to the normal notify path. Worst case we send an extra alert; the
    // cooldown self-heals on the next successful page.
    log.warn(
      `Throttle lookup failed for ${contractorId}/${service}/${kind}; ` +
      `proceeding without cooldown: ${formatDbError(err)}`
    );
  }

  // 1. Out-of-band email FIRST — this is the channel that has to land
  //    for an incident to count as "notified" for dedup purposes.
  let emailResult: { sent: number; attempted: number } = { sent: 0, attempted: 0 };
  try {
    emailResult = await sendEmail();
  } catch (err) {
    // sendEmail callbacks are documented to never throw, but defend anyway.
    log.error(`Unexpected throw from sendEmail for ${contractorId} (${service}/${kind})`, err);
    emailResult = { sent: 0, attempted: 1 };
  }

  // 2. Transient delivery failure → bail and let the next tick retry.
  if (emailResult.attempted > 0 && emailResult.sent === 0) {
    log.warn(
      `${service}/${kind} email delivery failed for ${contractorId} (0/${emailResult.attempted} sent) — ` +
      `deferring in-app notify + dedup so the next tick can retry`
    );
    return;
  }

  // 3. Email succeeded (or impossible): in-app + websocket + dedup stamp.
  let adminCount = 0;
  let inAppInsertedCount = 0;
  try {
    const contractorUsers = await storage.getContractorUsers(contractorId);
    const adminUsers = contractorUsers.filter(uc =>
      uc.role === 'admin' || uc.role === 'super_admin'
    );
    adminCount = adminUsers.length;
    for (const admin of adminUsers) {
      try {
        await db.insert(notifications).values({
          userId: admin.userId,
          contractorId,
          type: 'system',
          title,
          message,
          link: link ?? '/settings/integrations',
        });
        inAppInsertedCount += 1;
      } catch (err) {
        log.warn(
          `Failed to insert in-app notification for admin ${admin.userId} ` +
          `(${service}/${kind}): ${formatDbError(err)}`
        );
      }
    }
  } catch (err) {
    log.error(
      `Failed to enumerate admins for ${service}/${kind} in-app notification on ` +
      `${contractorId}: ${formatDbError(err)}`
    );
  }

  try {
    if (inAppInsertedCount > 0) {
      broadcastToContractor(contractorId, { type: 'notification_updated' });
    }
  } catch (err) {
    log.warn(`Websocket broadcast failed for ${contractorId} (${service}/${kind}): ${formatDbError(err)}`);
  }

  await markIncidentNotified(incidentId, `${service}/${kind}`);

  // Only stamp the throttle row when at least one channel actually
  // delivered something the user will see. A SendGrid send to ≥1 recipient
  // OR an in-app row inserted for ≥1 admin counts. If both failed (and
  // email was attempted), the cooldown is NOT consumed so the next tick
  // retries; the email-only-failure case is already short-circuited above.
  if (emailResult.sent > 0 || inAppInsertedCount > 0) {
    await stampAlertThrottle(contractorId, service, kind).catch(err =>
      log.warn(`Failed to stamp alert throttle for ${contractorId}/${service}/${kind}: ${formatDbError(err)}`)
    );
  }

  log.info(
    `Notified ${inAppInsertedCount}/${adminCount} admin(s) in-app + ` +
    `${emailResult.sent}/${emailResult.attempted} via email about ` +
    `${service}/${kind} incident on contractor ${contractorId}`
  );
}

async function markIncidentNotified(incidentId: string, label: string): Promise<void> {
  try {
    await db.update(webhookIncidents)
      .set({ notifiedAt: new Date() })
      .where(eq(webhookIncidents.id, incidentId));
  } catch (err) {
    log.warn(`Failed to mark ${label} incident ${incidentId} notified: ${formatDbError(err)}`);
  }
}
