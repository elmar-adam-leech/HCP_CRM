/**
 * server/sync/hcp-calendar-events.ts — HCP calendar events sync.
 *
 * Fetches all calendar events from the HCP /events API and stores them
 * in the local `hcp_calendar_events` table so that the availability
 * calculator can query the DB entirely — no live HCP API calls on every
 * booking page load.
 *
 * Called as part of the daily HCP sync (syncHousecallPro).
 */
import { db } from '../db';
import { hcpCalendarEvents } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { housecallProService } from '../hcp/index';
import { logger } from '../utils/logger';
import type { HousecallProEvent, HcpPageEnvelope } from '../hcp/types';
import { extractHcpList } from '../hcp/base-client';

const log = logger('HcpCalendarEventsSync');

/** Statuses that indicate a cancelled / inactive event — skip these. */
const CANCELLED_STATUSES = ['cancelled', 'canceled', 'inactive', 'deleted'];

function resolveEventTime(evt: HousecallProEvent, field: 'start' | 'end'): string | undefined {
  if (field === 'start') {
    return evt.schedule?.start_time
      || evt.start_time
      || evt.starts_at
      || evt.start_at
      || (typeof evt.start === 'string' ? evt.start : undefined)
      || evt.scheduled_start;
  }
  return evt.schedule?.end_time
    || evt.end_time
    || evt.ends_at
    || evt.end_at
    || (typeof evt.end === 'string' ? evt.end : undefined)
    || evt.scheduled_end;
}

export async function syncHcpCalendarEvents(tenantId: string): Promise<void> {
  log.info(`[HcpCalendarEventsSync] Starting calendar events sync for tenant ${tenantId}`);

  const pageSize = 100;
  let page = 1;
  let totalPages = 1;
  const allEvents: HousecallProEvent[] = [];

  // HCP /events does not support date-range or employee_id query filters.
  // We must fetch all pages and filter in memory.
  //
  // PAGE CAP: The HCP /events endpoint is intended for calendar-style blocks
  // (out-of-office, breaks, recurring time-off), not job scheduling. In
  // practice, tenants have dozens to low-hundreds of these events. We cap at
  // 20 pages × 100 events = 2,000 events as a safety limit. If a tenant
  // exceeds this, the excess events will simply not block availability — a
  // minor under-blocking risk vs the risk of unbounded API calls stalling sync.
  // If this limit is hit in production, increase PAGE_LIMIT and file a support
  // request with HCP to add date-range filtering on the /events endpoint.
  const PAGE_LIMIT = 20;
  let fetchFailed = false;

  while (page <= totalPages) {
    const result = await housecallProService.makeRequest<unknown>(
      `/events?page=${page}&page_size=${pageSize}&sort_by=created_at&sort_direction=desc`,
      tenantId,
    );

    if (!result.success || !result.data) {
      log.warn(`[HcpCalendarEventsSync] Failed to fetch events page ${page} for tenant ${tenantId}: ${result.error}`);
      fetchFailed = true;
      break;
    }

    const envelope = result.data as HcpPageEnvelope<HousecallProEvent>;
    if (typeof envelope.total_pages === 'number') {
      totalPages = envelope.total_pages;
    }

    const pageEvents: HousecallProEvent[] = extractHcpList<HousecallProEvent>(result.data, 'events');
    allEvents.push(...pageEvents);

    page++;
    if (page > PAGE_LIMIT) {
      log.error(`[HcpCalendarEventsSync] SYNC_TRUNCATED: tenant ${tenantId} has more than ${PAGE_LIMIT * pageSize} calendar events. Pagination stopped at page ${PAGE_LIMIT}. Fetched ${allEvents.length} events so far. Some calendar blocks are NOT stored — availability may be under-blocked until PAGE_LIMIT is increased.`);
      break;
    }
  }

  // Abort write if pagination failed mid-way — preserve existing rows rather
  // than replacing them with an incomplete dataset that would under-block
  // availability until the next successful sync.
  if (fetchFailed) {
    log.warn(`[HcpCalendarEventsSync] Aborting DB write for tenant ${tenantId} due to mid-pagination fetch failure; existing rows retained.`);
    return;
  }

  log.info(`[HcpCalendarEventsSync] Fetched ${allEvents.length} raw events for tenant ${tenantId}`);

  // Expand each active event into per-employee rows.
  const rows: {
    contractorId: string;
    hcpEventId: string;
    hcpEmployeeId: string;
    startTime: Date;
    endTime: Date;
    title: string | null;
    status: string | null;
  }[] = [];

  for (const evt of allEvents) {
    const status = (evt.status || '').toLowerCase();
    if (CANCELLED_STATUSES.some(s => status.includes(s))) continue;

    const start = resolveEventTime(evt, 'start');
    const end = resolveEventTime(evt, 'end');
    if (!start || !end) continue;

    const assignedList = evt.assigned_employees ?? evt.employees;
    if (!Array.isArray(assignedList) || assignedList.length === 0) continue;

    for (const emp of assignedList) {
      rows.push({
        contractorId: tenantId,
        hcpEventId: evt.id,
        hcpEmployeeId: emp.id,
        startTime: new Date(start),
        endTime: new Date(end),
        title: (evt.title ?? evt.name ?? null) as string | null,
        status: evt.status ?? null,
      });
    }
  }

  log.info(`[HcpCalendarEventsSync] ${rows.length} event-employee rows to store for tenant ${tenantId}`);

  // Full replace inside a transaction so a failed insert cannot leave the tenant
  // with an empty table (which would silently under-block availability until the
  // next successful sync).
  await db.transaction(async (tx) => {
    await tx.delete(hcpCalendarEvents).where(eq(hcpCalendarEvents.contractorId, tenantId));
    if (rows.length > 0) {
      const BATCH = 500;
      for (let i = 0; i < rows.length; i += BATCH) {
        await tx.insert(hcpCalendarEvents).values(rows.slice(i, i + BATCH));
      }
    }
  });

  log.info(`[HcpCalendarEventsSync] Stored ${rows.length} calendar event rows for tenant ${tenantId}`);
}
