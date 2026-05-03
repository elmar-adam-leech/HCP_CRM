import { db } from "../db";
import { webhookIncidentAlertThrottle } from "@shared/schema";
import { and, eq } from "drizzle-orm";

/**
 * Per-(contractor, service, kind) cooldown table for incident paging.
 * Sibling to `webhook_incidents` because the cooldown must span
 * multiple open/close cycles — a flap that opens and closes the
 * incident on every health-check tick would otherwise re-page on
 * every cycle.
 *
 * The notifier consults `getLastAlertedAt` BEFORE sending; on a real
 * delivery (email or in-app) it calls `stampAlertThrottle` to refresh
 * the cooldown. The cooldown is never explicitly cleared — it expires
 * naturally after `ALERT_THROTTLE_WINDOW_MS`, which is the sole
 * enforcement mechanism for the "at most one alert every 24 hours"
 * guarantee across open/close cycles.
 */

export async function getLastAlertedAt(
  contractorId: string,
  service: string,
  kind: string,
): Promise<Date | null> {
  const rows = await db.select({ lastAlertedAt: webhookIncidentAlertThrottle.lastAlertedAt })
    .from(webhookIncidentAlertThrottle)
    .where(and(
      eq(webhookIncidentAlertThrottle.contractorId, contractorId),
      eq(webhookIncidentAlertThrottle.service, service),
      eq(webhookIncidentAlertThrottle.kind, kind),
    ))
    .limit(1);
  return rows[0]?.lastAlertedAt ?? null;
}

/**
 * UPSERT the cooldown row. Idempotent and safe under racing health-check
 * ticks thanks to the unique index on (contractor_id, service, kind).
 */
export async function stampAlertThrottle(
  contractorId: string,
  service: string,
  kind: string,
): Promise<void> {
  const now = new Date();
  await db.insert(webhookIncidentAlertThrottle)
    .values({ contractorId, service, kind, lastAlertedAt: now })
    .onConflictDoUpdate({
      target: [
        webhookIncidentAlertThrottle.contractorId,
        webhookIncidentAlertThrottle.service,
        webhookIncidentAlertThrottle.kind,
      ],
      set: { lastAlertedAt: now },
    });
}
