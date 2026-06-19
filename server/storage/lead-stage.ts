import { sql, type SQL } from "drizzle-orm";

/**
 * Task #805 — shared "effective stage" derivation for a lead-type contact.
 *
 * Pipeline state is a derived projection of lead facts, NOT a raw
 * `contacts.status` read. With one row per person, the displayed stage comes
 * from the contact's MOST RECENT OPEN lead (plus booking state), so a fresh
 * inbound lead for an existing customer correctly resolves to "new".
 *
 * Rules (single source of truth, reused by the Leads list filter and the
 * status-counts query):
 *  - most recent OPEN lead (not archived, status in new/contacted/qualified):
 *      - contact booked (is_scheduled = true) -> 'scheduled'
 *      - open status in (contacted, qualified) -> 'contacted'
 *      - else -> 'new'
 *  - no open lead: most recent TERMINAL lead (disqualified/lost) -> that status
 *  - no open AND no terminal lead (no lead rows, or only converted): fall back
 *    to `contacts.status` so manually-created lead-contacts without lead rows
 *    still classify, and historical rows are handled without a backfill.
 *
 * The expression references the `"contacts"` table alias and is index-backed by
 * `leads_contact_archived_status_created_idx`. All branches are cast to text so
 * the CASE never mixes the `lead_status` and `contact_status` enum types.
 */
export function effectiveStageSql(contractorId: string): SQL<string> {
  return sql<string>`(
    CASE
      WHEN (
        SELECT ls.status FROM leads ls
        WHERE ls.contact_id = "contacts"."id" AND ls.contractor_id = ${contractorId}
          AND ls.archived = false AND ls.status IN ('new', 'contacted', 'qualified')
        ORDER BY ls.created_at DESC LIMIT 1
      ) IS NULL THEN
        COALESCE(
          (
            SELECT ls2.status::text FROM leads ls2
            WHERE ls2.contact_id = "contacts"."id" AND ls2.contractor_id = ${contractorId}
              AND ls2.status IN ('disqualified', 'lost')
            ORDER BY ls2.created_at DESC LIMIT 1
          ),
          "contacts"."status"::text
        )
      WHEN "contacts"."is_scheduled" = true THEN 'scheduled'
      WHEN (
        SELECT ls.status::text FROM leads ls
        WHERE ls.contact_id = "contacts"."id" AND ls.contractor_id = ${contractorId}
          AND ls.archived = false AND ls.status IN ('new', 'contacted', 'qualified')
        ORDER BY ls.created_at DESC LIMIT 1
      ) IN ('contacted', 'qualified') THEN 'contacted'
      ELSE 'new'
    END
  )`;
}
