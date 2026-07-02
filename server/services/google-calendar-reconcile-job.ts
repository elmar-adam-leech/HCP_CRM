import { BackgroundJob } from "./background-job";
import { reconcileGoogleCalendarBookings } from "../sync/google-calendar-reconciliation";
import { logger } from "../utils/logger";

const log = logger("GoogleCalendarReconcileJob");

// Reverse-sync CRM bookings against Google Calendar every 15 minutes so a rep's
// reschedule / cancellation made directly in Google is reflected on the booking
// within a bounded window. The reconciliation query is a single indexed lookup
// that short-circuits when no connected bookings exist, so an idle instance
// does negligible work.
const INTERVAL_MS = 15 * 60 * 1000;

export class GoogleCalendarReconcileJob extends BackgroundJob {
  constructor() {
    super(INTERVAL_MS);
  }

  protected async runOnce(): Promise<void> {
    try {
      await reconcileGoogleCalendarBookings();
    } catch (err) {
      log.error(`Google Calendar reconcile tick failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
