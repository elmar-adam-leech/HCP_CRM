import type { Express } from "express";
import { asyncHandler } from "../utils/async-handler";
import { parseBody, parseIntParam } from "../utils/validate-body";
import { storage } from "../storage";
import { createRateLimiter } from "../middleware/rate-limiter";
import { auditLog } from "../utils/audit-log";
import { db } from "../db";
import { consentLogs, messages, estimates, jobs, scheduledBookings } from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";
import { sql as drizzleSql } from "drizzle-orm";
import { isIntegrationEnabledCached } from "../services/cache";
import { insertContactSchema, contactStatusEnum, type InsertLead, type Contact } from "@shared/schema";
import type { UpdateContact } from "../storage-types";
import { requireManagerOrAdmin, requireAdmin } from "../auth-service";
import { workflowEngine } from "../workflow-engine";
import { broadcastToContractor } from "../websocket";
import { createActivityAndBroadcast } from "../utils/activity";
import { housecallProService } from "../hcp/index";
import { toWorkflowEvent } from "../utils/workflow/entity-adapter";
import { logger } from "../utils/logger";
import { resolveHcpLeadSource } from "../utils/hcp-helpers";
import { markHcpCustomerPushed } from "../utils/hcp-echo-suppression";
import { facebookService } from "../services/facebook-service";
import { z } from "zod";
import { logConsent, hashIp } from "../utils/consent-log";
import { buildFormattedAddress, parseAddressString } from "../utils/address";
import { markContactScheduled } from "../services/contact-status";
import { normalizePhoneForHcp } from "../utils/phone-normalizer";

const log = logger('ContactRoutes');

export function registerContactRoutes(app: Express): void {
  // Legacy endpoint: bounded to 100 rows by default.
  // Prefer /api/contacts/paginated for any paginated or search-driven UI.
  // This endpoint is kept for backwards compat with cache-invalidation queryKeys
  // that fire after mutations (they re-fetch the current page, not a full dump).
  app.get("/api/contacts", asyncHandler(async (req, res) => {
    const { type, search, limit } = req.query;
    const contactType = type as 'lead' | 'customer' | 'inactive' | undefined;
    const pageLimit = parseIntParam(limit as string | undefined, 100, 100);
    if (pageLimit === null) {
      res.status(400).json({ message: "Invalid 'limit' parameter: must be a number" });
      return;
    }
    const result = await storage.getContactsPaginated(req.user.contractorId, {
      type: contactType,
      search: search as string | undefined,
      limit: pageLimit,
      includeAll: true,
    });
    res.json(result.data);
  }));

  app.get("/api/contacts/paginated", asyncHandler(async (req, res) => {
    const { cursor, offset, limit, type, status, search, includeAll, archived, aged, assignedTo, dateFrom, dateTo, retentionFlagged, sortField, sortOrder } = req.query;
    const parsedOffset = offset !== undefined ? parseIntParam(offset as string | undefined, 0) : undefined;
    if (parsedOffset === null) {
      res.status(400).json({ message: "Invalid 'offset' parameter: must be a number" });
      return;
    }
    const parsedLimit = parseIntParam(limit as string | undefined, 50);
    if (parsedLimit === null) {
      res.status(400).json({ message: "Invalid 'limit' parameter: must be a number" });
      return;
    }
    // `type` accepts a single value (e.g. `customer`) or a comma-separated
    // list (e.g. `customer,inactive`). The multi-value form is collapsed to
    // `types` so the storage layer emits a `contacts.type IN (...)` predicate
    // instead of forcing the caller to issue one request per type.
    const VALID_TYPES = ['lead', 'customer', 'inactive'] as const;
    type ContactType = typeof VALID_TYPES[number];
    const typeRaw = type as string | undefined;
    const parsedTypes = (typeRaw ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter((t): t is ContactType => (VALID_TYPES as readonly string[]).includes(t));
    const singleType = parsedTypes.length === 1 ? parsedTypes[0] : undefined;
    const multiTypes = parsedTypes.length > 1 ? parsedTypes : undefined;
    const options = {
      cursor: cursor as string | undefined,
      offset: parsedOffset,
      limit: parsedLimit,
      type: singleType,
      types: multiTypes,
      status: status as string | undefined,
      search: search as string | undefined,
      includeAll: includeAll === "true",
      archived: archived === "true" ? true : archived === "false" ? false : undefined,
      aged: aged === "true" ? true : aged === "false" ? false : undefined,
      assignedTo: assignedTo as string | undefined,
      dateFrom: dateFrom as string | undefined,
      dateTo: dateTo as string | undefined,
      retentionFlagged: retentionFlagged === "true" ? true : undefined,
      sortField: sortField === "createdDate" ? "createdDate" : sortField === "lastActivity" ? "lastActivity" : undefined,
      sortOrder: sortOrder === "asc" ? "asc" : sortOrder === "desc" ? "desc" : undefined,
    };
    const paginatedContacts = await storage.getContactsPaginated(req.user.contractorId, options);
    res.json(paginatedContacts);
  }));

  app.get("/api/contacts/status-counts", asyncHandler(async (req, res) => {
    const { search, type, assignedTo, dateFrom, dateTo, archived, aged } = req.query;
    const counts = await storage.getContactsStatusCounts(req.user.contractorId, {
      search: search as string | undefined,
      type: type as 'lead' | 'customer' | 'inactive' | undefined,
      assignedTo: assignedTo as string | undefined,
      dateFrom: dateFrom as string | undefined,
      dateTo: dateTo as string | undefined,
      archived: archived === 'true' ? true : archived === 'false' ? false : undefined,
      aged: aged === 'true' ? true : aged === 'false' ? false : undefined,
    });
    res.json(counts);
  }));

  // Returns sorted distinct tags across all contacts for the current contractor.
  // Used by workflow conditional builder tag picker.
  app.get("/api/contacts/tags", asyncHandler(async (req, res) => {
    const rows = await db.execute<{ tag: string }>(drizzleSql`
      SELECT DISTINCT trim(tag) AS tag
      FROM contacts c, unnest(c.tags) AS tag
      WHERE c.contractor_id = ${req.user.contractorId}
        AND tag IS NOT NULL
        AND trim(tag) <> ''
      ORDER BY tag ASC
    `);
    res.json(rows.rows.map((r) => r.tag));
  }));

  app.get("/api/contacts/follow-ups", asyncHandler(async (req, res) => {
    const limit = parseIntParam(req.query.limit as string | undefined, 200, 500);
    if (limit === null) {
      res.status(400).json({ message: "Invalid 'limit' parameter: must be a number" });
      return;
    }
    const contacts = await storage.getContactsWithFollowUp(req.user.contractorId, limit);
    res.json(contacts);
  }));

  app.get("/api/follow-ups/unified", asyncHandler(async (req, res) => {
    const widgetMode = req.query.widget === "true";
    // Per-page max of 200 (was a soft 500 cap with silent truncation).
    // Default page size of 50 keeps first paint focused even on tenants
    // with thousands of open follow-ups.
    const parsedLimit = parseIntParam(req.query.limit as string | undefined, 50, 200);
    if (parsedLimit === null || parsedLimit < 1) {
      res.status(400).json({ message: "Invalid 'limit' parameter: must be a positive number" });
      return;
    }
    const parsedOffset = parseIntParam(req.query.offset as string | undefined, 0);
    if (parsedOffset === null || parsedOffset < 0) {
      res.status(400).json({ message: "Invalid 'offset' parameter: must be a non-negative number" });
      return;
    }
    const limit = widgetMode ? 5 : parsedLimit;
    const offset = widgetMode ? 0 : parsedOffset;
    const fromRaw = typeof req.query.from === "string" ? new Date(req.query.from) : undefined;
    const toRaw = typeof req.query.to === "string" ? new Date(req.query.to) : undefined;
    const fromDate = fromRaw && !isNaN(fromRaw.getTime()) ? fromRaw : undefined;
    const toDate = toRaw && !isNaN(toRaw.getTime()) ? toRaw : undefined;
    const contractorId = req.user.contractorId;

    type FollowUpItem = {
      id: string;
      type: "lead" | "estimate" | "job";
      name: string;
      title?: string;
      followUpDate: string;
      followUpReason: string;
      email?: string;
      phone?: string;
      address?: string;
      value?: number;
      notes?: string;
      source?: string;
      status?: string;
      contactId?: string;
      stepActionType?: "call" | "text" | "email";
      stepGuidance?: string | null;
      stepCallScript?: string | null;
      stepMessageTemplate?: string | null;
    };

    type UnionRow = {
      id: string;
      row_type: "lead" | "estimate" | "job";
      name: string | null;
      title: string | null;
      follow_up_date: Date;
      email: string | null;
      phone: string | null;
      address: string | null;
      value: string | null;
      notes: string | null;
      source: string | null;
      status: string | null;
      contact_id: string | null;
      step_action_type: "call" | "text" | "email" | null;
      step_guidance: string | null;
      step_call_script: string | null;
      step_message_template: string | null;
    };

    // Server-side filter on follow_up_date so the UI can scope to a
    // bucket (Past Due / Today / This Week / Upcoming) without paging
    // through irrelevant rows. The same window applies to all three
    // legs of the UNION.
    const fromClause = fromDate
      ? drizzleSql`AND follow_up_date >= ${fromDate}`
      : drizzleSql``;
    const toClause = toDate
      ? drizzleSql`AND follow_up_date < ${toDate}`
      : drizzleSql``;

    // Single UNION ALL query — each leg explicitly filters on contractor_id to
    // maintain multi-tenant isolation even if a future refactor removes the
    // outer guard. The lead leg LATERAL-joins the next pending sales-process
    // step task to attach optional rep coaching (call script / message
    // template / guidance, task #729). Results are sorted and limited in SQL
    // to avoid in-process sorting. We run a parallel COUNT query (same UNION
    // + filters) so an out-of-range offset still reports the true total
    // instead of 0 — important for shared deep links where the page index
    // outlives the data set.
    const allFollowupsCte = drizzleSql`
      all_followups AS (
        SELECT
          c.id,
          'lead'::text         AS row_type,
          c.name               AS name,
          NULL::text           AS title,
          c.follow_up_date     AS follow_up_date,
          c.emails[1]          AS email,
          c.phones[1]          AS phone,
          c.address            AS address,
          NULL::text           AS value,
          c.notes              AS notes,
          c.source             AS source,
          c.status::text       AS status,
          NULL::text           AS contact_id,
          coaching.action_type::text AS step_action_type,
          coaching.guidance          AS step_guidance,
          coaching.call_script       AS step_call_script,
          coaching.message_template  AS step_message_template
        FROM contacts c
        LEFT JOIN LATERAL (
          SELECT s.action_type, s.guidance, s.call_script, s.message_template
          FROM sales_process_task_instances ti
          JOIN sales_process_steps s ON s.id = ti.step_id
          WHERE ti.contractor_id = ${contractorId}
            AND ti.lead_id = c.id
            AND ti.status = 'pending'
          ORDER BY ti.due_at ASC
          LIMIT 1
        ) coaching ON true
        WHERE c.contractor_id = ${contractorId}
          AND c.follow_up_date IS NOT NULL

        UNION ALL

        SELECT
          e.id,
          'estimate'::text                                            AS row_type,
          COALESCE(ct.name, e.title)                                  AS name,
          e.title                                                     AS title,
          e.follow_up_date                                            AS follow_up_date,
          ct.emails[1]                                                AS email,
          ct.phones[1]                                                AS phone,
          ct.address                                                  AS address,
          e.amount::text                                              AS value,
          e.description                                               AS notes,
          NULL::text                                                  AS source,
          e.status::text                                              AS status,
          e.contact_id                                                AS contact_id,
          coaching.action_type::text                                  AS step_action_type,
          coaching.guidance                                           AS step_guidance,
          coaching.call_script                                        AS step_call_script,
          coaching.message_template                                   AS step_message_template
        FROM estimates e
        LEFT JOIN contacts ct ON ct.id = e.contact_id
        LEFT JOIN LATERAL (
          SELECT s.action_type, s.guidance, s.call_script, s.message_template
          FROM sales_process_task_instances ti
          JOIN sales_process_steps s ON s.id = ti.step_id
          WHERE ti.contractor_id = ${contractorId}
            AND ti.estimate_id = e.id
            AND ti.status = 'pending'
          ORDER BY ti.due_at ASC
          LIMIT 1
        ) coaching ON true
        WHERE e.contractor_id = ${contractorId}
          AND e.follow_up_date IS NOT NULL

        UNION ALL

        SELECT
          j.id,
          'job'::text                                                  AS row_type,
          COALESCE(ct.name, j.title)                                   AS name,
          j.title                                                      AS title,
          j.follow_up_date                                             AS follow_up_date,
          ct.emails[1]                                                 AS email,
          ct.phones[1]                                                 AS phone,
          ct.address                                                   AS address,
          j.value::text                                                AS value,
          j.notes                                                      AS notes,
          NULL::text                                                   AS source,
          j.status::text                                               AS status,
          j.contact_id                                                 AS contact_id,
          NULL::text                                                   AS step_action_type,
          NULL::text                                                   AS step_guidance,
          NULL::text                                                   AS step_call_script,
          NULL::text                                                   AS step_message_template
        FROM jobs j
        LEFT JOIN contacts ct ON ct.id = j.contact_id
        WHERE j.contractor_id = ${contractorId}
          AND j.follow_up_date IS NOT NULL
      ),
      filtered AS (
        SELECT * FROM all_followups
        WHERE TRUE
          ${fromClause}
          ${toClause}
      )
    `;

    const [pageResult, countResult] = await Promise.all([
      db.execute<UnionRow>(drizzleSql`
        WITH ${allFollowupsCte}
        SELECT * FROM filtered
        ORDER BY follow_up_date ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `),
      db.execute<{ total_count: number }>(drizzleSql`
        WITH ${allFollowupsCte}
        SELECT COUNT(*)::int AS total_count FROM filtered
      `),
    ]);
    const rows = pageResult;

    const formatDate = (d: Date | string) => {
      const date = typeof d === "string" ? new Date(d) : d;
      return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    };

    const toIso = (d: Date | string) =>
      typeof d === "string" ? d : d.toISOString();

    const items: FollowUpItem[] = rows.rows.map((row) => ({
      id: row.id,
      type: row.row_type,
      name: row.name ?? row.title ?? "",
      title: row.title ?? undefined,
      followUpDate: toIso(row.follow_up_date),
      followUpReason: `Follow up on ${formatDate(row.follow_up_date)}`,
      email: row.email ?? undefined,
      phone: row.phone ?? undefined,
      address: row.address ?? undefined,
      value: row.value != null ? parseFloat(row.value) : undefined,
      notes: row.notes ?? undefined,
      source: row.source ?? undefined,
      status: row.status ?? undefined,
      contactId: row.contact_id ?? undefined,
      stepActionType: row.step_action_type ?? undefined,
      stepGuidance: row.step_guidance,
      stepCallScript: row.step_call_script,
      stepMessageTemplate: row.step_message_template,
    }));

    const total = countResult.rows[0]?.total_count ?? 0;
    res.json({
      items,
      total,
      hasMore: offset + items.length < total,
    });
  }));

  app.get("/api/contacts/lead-trend", asyncHandler(async (req, res) => {
    const days = parseIntParam(req.query.days as string | undefined, 30, 90);
    if (days === null) {
      res.status(400).json({ message: "Invalid 'days' parameter: must be a number" });
      return;
    }
    const since = new Date();
    since.setDate(since.getDate() - days);
    const rows = await storage.getLeadTrend(req.user.contractorId, since);
    res.json(rows);
  }));

  app.get("/api/leads/csv-template", asyncHandler(async (_req, res) => {
    const csvHeaders = ['name', 'email', 'phone', 'address', 'source', 'notes', 'followUpDate'];
    const csvTemplate = csvHeaders.join(',') + '\n' +
      'John Smith,john@example.com,555-123-4567,"123 Main St, City, State 12345",Website Contact Form,"Interested in HVAC installation",2024-01-15\n' +
      'Jane Doe,jane@example.com,555-987-6543,"456 Oak Ave, City, State 12345",Referral,"Needs AC repair",2024-01-20';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="leads_template.csv"');
    res.send(csvTemplate);
  }));

  app.get("/api/contacts/with-counts", asyncHandler(async (req, res) => {
    const { search, cursor, limit, offset } = req.query;
    const parsedLimit = parseIntParam(limit as string | undefined, 50);
    if (parsedLimit === null) {
      res.status(400).json({ message: "Invalid 'limit' parameter: must be a number" });
      return;
    }
    const parsedOffset = offset !== undefined ? parseIntParam(offset as string | undefined, 0) : undefined;
    if (parsedOffset === null) {
      res.status(400).json({ message: "Invalid 'offset' parameter: must be a number" });
      return;
    }
    const result = await storage.getContactsWithCounts(req.user.contractorId, {
      search: search as string | undefined,
      cursor: cursor as string | undefined,
      limit: parsedLimit,
      offset: parsedOffset,
    });
    res.json(result);
  }));

  app.get("/api/contacts/:id", asyncHandler(async (req, res) => {
    const contact = await storage.getContact(req.params.id, req.user.contractorId);
    if (!contact) {
      res.status(404).json({ message: "Contact not found" });
      return;
    }
    res.json(contact);
  }));

  app.get("/api/contacts/:contactId/leads", asyncHandler(async (req, res) => {
    const leads = await storage.getLeadsByContact(req.params.contactId, req.user.contractorId);
    res.json(leads);
  }));

  app.get("/api/contacts/:contactId/bookings", asyncHandler(async (req, res) => {
    const bookings = await db.select()
      .from(scheduledBookings)
      .where(and(
        eq(scheduledBookings.contactId, req.params.contactId),
        eq(scheduledBookings.contractorId, req.user.contractorId)
      ))
      .orderBy(desc(scheduledBookings.startTime));
    res.json(bookings);
  }));

  app.post("/api/contacts", asyncHandler(async (req, res) => {
    const contactSchema = insertContactSchema
      .omit({ contractorId: true })
      .extend({ followUpDate: z.coerce.date().nullable().optional() });
    const contactData = parseBody(contactSchema, req, res);
    if (!contactData) return;

    // Regenerate formatted address from structured fields whenever any are provided,
    // so address always equals the formatted structured value when structured fields are present.
    if (contactData.street || contactData.city || contactData.state || contactData.zip) {
      const computed = buildFormattedAddress(
        contactData.street || undefined,
        contactData.city || undefined,
        contactData.state || undefined,
        contactData.zip || undefined,
      );
      if (computed) contactData.address = computed;
    }

    if (
      (contactData.phones && contactData.phones.length > 0) ||
      (contactData.emails && contactData.emails.length > 0)
    ) {
      const matchedId = await storage.findMatchingContact(
        req.user.contractorId,
        contactData.emails ?? [],
        contactData.phones ?? []
      );

      if (matchedId) {
        const existing = await storage.getContact(matchedId, req.user.contractorId);
        if (existing) {
          const existingPhones = existing.phones ?? [];
          const newPhones = (contactData.phones ?? []).filter(p => !existingPhones.includes(p));
          const mergedPhones = [...existingPhones, ...newPhones];

          const existingEmailsLower = (existing.emails ?? []).map(e => e.toLowerCase());
          const newEmails = (contactData.emails ?? []).filter(e => !existingEmailsLower.includes(e.toLowerCase()));
          const mergedEmails = [...(existing.emails ?? []), ...newEmails];

          const updatePayload: Partial<UpdateContact> = {};
          if (newPhones.length > 0) updatePayload.phones = mergedPhones;
          if (newEmails.length > 0) updatePayload.emails = mergedEmails;
          if (contactData.type && contactData.type !== existing.type) {
            updatePayload.type = contactData.type;
          }

          if (Object.keys(updatePayload).length === 0) {
            await storage.updateContact(matchedId, {}, req.user.contractorId);
            res.status(409).json({
              message: `A contact with this phone or email already exists`,
              duplicateContactId: existing.id,
              duplicateContactName: existing.name,
              isDuplicate: true,
            });
            return;
          }

          const updated = await storage.updateContact(matchedId, updatePayload, req.user.contractorId);
          res.status(200).json(updated);
          return;
        }
      }
    }

    const contact = await storage.createContact(contactData, req.user.contractorId);

    if (contact.type === 'lead') {
      try {
        const leadStatus = (contact.status && (contact.status !== 'inactive')) ? contact.status as InsertLead['status'] : 'new';
        await storage.createLead({ contactId: contact.id, status: leadStatus, archived: false }, req.user.contractorId);
      } catch (leadErr) {
        log.warn('Failed to create leads table entry for new lead contact', leadErr);
      }
    }

    const hcpIntegrationEnabled = await isIntegrationEnabledCached(req.user.contractorId, 'housecall-pro');
    if (hcpIntegrationEnabled) {
      try {
        const nameParts = contact.name.split(' ');
        const firstName = nameParts[0] || '';
        const lastName = nameParts.slice(1).join(' ') || '';

        const hcpLeadSourceForCustomer = await resolveHcpLeadSource(req.user.contractorId, contact.utmSource || contact.source);
        const hcpResult = await housecallProService.createCustomer(req.user.contractorId, {
          first_name: firstName,
          last_name: lastName,
          email: contact.emails?.[0],
          mobile_number: normalizePhoneForHcp(contact.phones?.[0]),
          lead_source: hcpLeadSourceForCustomer,
          notes: contact.notes || undefined,
          addresses: (contact.street || contact.address) ? [{
            ...(!contact.street && !contact.city && !contact.state && !contact.zip && contact.address
              ? parseAddressString(contact.address)
              : {
                  street: contact.street || '',
                  city: contact.city || '',
                  state: contact.state || '',
                  zip: contact.zip || '',
                }),
            type: 'service',
          }] : undefined
        });

        if (hcpResult.success && hcpResult.data?.id) {
          await storage.updateContact(contact.id, {
            housecallProCustomerId: hcpResult.data.id,
            externalId: hcpResult.data.id,
            externalSource: 'housecall-pro',
          }, req.user.contractorId);
          markHcpCustomerPushed(hcpResult.data.id);
          log.info(`Created HCP customer: ${hcpResult.data.id} for contact: ${contact.id}`);

          if (contact.type === 'lead') {
            try {
              const hcpLeadResult = await housecallProService.createLead(req.user.contractorId, {
                customer_id: hcpResult.data.id,
                lead_source: hcpLeadSourceForCustomer,
                note: contact.notes || undefined,
              });
              if (hcpLeadResult.success && hcpLeadResult.data?.id) {
                const leads = await storage.getLeadsByContact(contact.id, req.user.contractorId);
                if (leads.length > 0) {
                  await storage.updateLead(leads[0].id, { housecallProLeadId: hcpLeadResult.data.id }, req.user.contractorId);
                  log.info(`Created HCP lead: ${hcpLeadResult.data.id} for contact: ${contact.id}`);
                }
              } else {
                log.warn('Failed to create HCP lead', hcpLeadResult.error);
              }
            } catch (leadErr) {
              log.error('Error creating HCP lead', leadErr);
            }
          }
        } else {
          log.warn('Failed to create HCP customer', hcpResult.error);
        }
      } catch (hcpError) {
        log.error('Error creating customer in HCP', hcpError);
      }
    }

    broadcastToContractor(req.user.contractorId, {
      type: 'contact_created',
      contactId: contact.id,
      contactType: contact.type
    });

    if (contact.type === 'lead') {
      workflowEngine.triggerWorkflowsForEvent('contact_created', toWorkflowEvent(contact), req.user.contractorId).catch(error => {
        log.error('Error triggering workflows for contact creation', error);
        auditLog({
          contractorId: req.user.contractorId,
          action: 'workflow.trigger_failure',
          entityType: 'contact',
          entityId: contact.id,
          after: { event: 'contact_created', error: error instanceof Error ? error.message : String(error) },
        }).catch(auditErr => log.error('Failed to write audit log for workflow trigger failure', auditErr));
      });
    }

    logConsent({
      contractorId: req.user.contractorId,
      contactId: contact.id,
      userId: req.user.userId,
      source: contact.source || 'manual',
      optInType: 'implied',
      ipHash: hashIp(req.ip),
      metadata: { source: contact.source || 'manual', createdByUser: req.user.userId },
    }).catch(err => log.error('Consent log error (non-fatal):', err));

    res.status(201).json(contact);
  }));

  // Single handler shared by both PUT and PATCH.
  // The schema includes `followUpDate` coercion so that callers who send a date
  // string (common from form submissions) get it auto-converted to a Date.
  const contactUpdateSchema = insertContactSchema.omit({ contractorId: true }).partial().extend({
    followUpDate: z.coerce.date().nullable().optional(),
  });

  const handleContactUpdate = asyncHandler(async (req, res) => {
    const updateData = parseBody(contactUpdateSchema, req, res);
    if (!updateData) return;

    if (updateData.status === 'scheduled') {
      updateData.scheduledByUserId = req.user.userId;
    }

    // Regenerate formatted address whenever any structured address fields are provided.
    // We always recompute so that editing street/city/state/zip keeps `address` in sync,
    // even if the caller also sent the now-stale `address` value from the form state.
    if (updateData.street !== undefined || updateData.city !== undefined || updateData.state !== undefined || updateData.zip !== undefined) {
      const existing = await storage.getContact(req.params.id, req.user.contractorId);
      const street = updateData.street ?? existing?.street ?? '';
      const city = updateData.city ?? existing?.city ?? '';
      const state = updateData.state ?? existing?.state ?? '';
      const zip = updateData.zip ?? existing?.zip ?? '';
      const regenerated = buildFormattedAddress(street || undefined, city || undefined, state || undefined, zip || undefined);
      updateData.address = regenerated || updateData.address || undefined;
    }

    // Behavioral note — email unlinking:
    // When the emails array is explicitly included in the request body (i.e. the
    // caller is replacing the full email list), any email-activity records that
    // reference removed addresses must be de-associated so the activity log stays
    // accurate. This was previously only done for PUT (full-replace) requests.
    // Now that PUT and PATCH share this handler, the unlink runs whenever `emails`
    // is present in the body, which is correct for both methods: a PATCH that
    // includes `emails` is also doing a full-array replacement of that field.
    const emailsPresent = Array.isArray(updateData.emails);

    const contact = await storage.updateContact(req.params.id, updateData, req.user.contractorId);
    if (!contact) {
      res.status(404).json({ message: "Contact not found" });
      return;
    }

    if (emailsPresent) {
      storage.unlinkOrphanedEmailActivities(contact.id, contact.emails || [], req.user.contractorId).catch(err => {
        log.error('Error unlinking orphaned email activities', err);
      });
    }

    if (contact.housecallProCustomerId) {
      isIntegrationEnabledCached(req.user.contractorId, 'housecall-pro').then(enabled => {
        if (!enabled) return;
        const nameParts = (contact.name || '').split(' ');
        // SAFE: guarded by the `if (contact.housecallProCustomerId)` check above.
        housecallProService.updateCustomer(req.user.contractorId, contact.housecallProCustomerId!, {
          first_name: nameParts[0] || '',
          last_name: nameParts.slice(1).join(' ') || '',
          email: contact.emails?.[0],
          mobile_number: normalizePhoneForHcp(contact.phones?.[0]),
          notes: contact.notes || undefined,
          addresses: (contact.street || contact.address) ? [{
            ...(!contact.street && !contact.city && !contact.state && !contact.zip && contact.address
              ? parseAddressString(contact.address)
              : {
                  street: contact.street || '',
                  city: contact.city || '',
                  state: contact.state || '',
                  zip: contact.zip || '',
                }),
            type: 'service' as const,
          }] : undefined,
        }).catch(err => log.error('Error pushing contact update to HCP', err));
      }).catch(err => log.error('Error checking HCP integration for contact update', err));
    }

    broadcastToContractor(req.user.contractorId, {
      type: 'contact_updated',
      contactId: contact.id,
      contactType: contact.type
    });

    if (contact.type === 'lead') {
      workflowEngine.triggerWorkflowsForEvent('contact_updated', toWorkflowEvent(contact), req.user.contractorId).catch(error => {
        log.error('Error triggering workflows for contact update', error);
        auditLog({
          contractorId: req.user.contractorId,
          action: 'workflow.trigger_failure',
          entityType: 'contact',
          entityId: contact.id,
          after: { event: 'contact_updated', error: error instanceof Error ? error.message : String(error) },
        }).catch(auditErr => log.error('Failed to write audit log for workflow trigger failure', auditErr));
      });
    }

    res.json(contact);
  });

  // PUT kept as an alias for backwards compatibility with clients that use it
  // for full-replace semantics. Both methods delegate to the same handler.
  app.put("/api/contacts/:id", handleContactUpdate);
  app.patch("/api/contacts/:id", handleContactUpdate);

  app.patch("/api/contacts/:id/status", asyncHandler(async (req, res) => {
    const statusSchema = z.object({
      status: z.enum(contactStatusEnum.enumValues)
    });
    const parsed = parseBody(statusSchema, req, res);
    if (!parsed) return;
    const { status } = parsed;

    const statusLabels: Record<string, string> = {
      'new': 'New', 'contacted': 'Contacted', 'scheduled': 'Scheduled',
      'active': 'Active', 'disqualified': 'Disqualified', 'inactive': 'Inactive', 'lost': 'Lost'
    };

    let contact: Contact;
    if (status === 'scheduled') {
      // Route through the centralized helper so the activity log, broadcast, and
      // contact_status_changed workflow trigger fire exactly once and stay in sync
      // with the in-app booking / public booking / HCP webhook code paths.
      const result = await markContactScheduled(req.params.id, req.user.contractorId, {
        source: 'manual_status_update',
        scheduledByUserId: req.user.userId,
        activityUserId: req.user.userId,
      });
      if (!result.contact) {
        res.status(404).json({ message: "Contact not found" });
        return;
      }
      contact = result.contact;
    } else {
      const updated = await storage.updateContact(req.params.id, { status }, req.user.contractorId);
      if (!updated) {
        res.status(404).json({ message: "Contact not found" });
        return;
      }
      contact = updated;

      try {
        await createActivityAndBroadcast(
          req.user.contractorId,
          { type: 'status_change', title: 'Status Changed', content: `Contact status changed to ${statusLabels[status]}`, contactId: req.params.id, userId: req.user.userId },
          { type: 'new_activity', contactId: req.params.id }
        );
      } catch (activityError) {
        log.error('Failed to create activity for status change', activityError);
      }

      broadcastToContractor(req.user.contractorId, {
        type: 'contact_updated',
        contactId: contact.id,
        contactType: contact.type
      });

      workflowEngine.triggerWorkflowsForEvent('contact_status_changed', toWorkflowEvent(contact), req.user.contractorId).catch(error => {
        log.error('Error triggering workflows for contact status change', error);
        auditLog({
          contractorId: req.user.contractorId,
          action: 'workflow.trigger_failure',
          entityType: 'contact',
          entityId: contact.id,
          after: { event: 'contact_status_changed', error: error instanceof Error ? error.message : String(error) },
        }).catch(auditErr => log.error('Failed to write audit log for workflow trigger failure', auditErr));
      });
    }

    void (async () => {
      try {
        const leads = await storage.getLeadsByContact(contact.id, req.user.contractorId);
        const latestLead = leads[0];
        if (latestLead) {
          await facebookService.sendConversionForStatus(req.user.contractorId, latestLead, contact, status);
        }
      } catch (fbErr) {
        log.error('Failed to fire Facebook conversion event (non-fatal)', fbErr);
      }
    })().catch(err => log.error('Unhandled error in Facebook conversion IIFE', err));

    res.json(contact);
  }));

  app.post("/api/contacts/bulk-status", asyncHandler(async (req, res) => {
    const bulkStatusSchema = z.object({
      ids: z.array(z.string().uuid()).min(1).max(100),
      status: z.enum(contactStatusEnum.enumValues),
    });
    const parsed = parseBody(bulkStatusSchema, req, res);
    if (!parsed) return;
    const { ids, status } = parsed;

    const statusLabels: Record<string, string> = {
      'new': 'New', 'contacted': 'Contacted', 'scheduled': 'Scheduled',
      'active': 'Active', 'disqualified': 'Disqualified', 'inactive': 'Inactive', 'lost': 'Lost'
    };

    const results: { succeeded: number; failed: number; errors: string[] } = {
      succeeded: 0, failed: 0, errors: [],
    };

    for (const id of ids) {
      try {
        let contact: Contact;
        if (status === 'scheduled') {
          // Centralized helper handles status flip, broadcast, activity log, and
          // workflow trigger dispatch (idempotent).
          const result = await markContactScheduled(id, req.user.contractorId, {
            source: 'bulk_status_update',
            scheduledByUserId: req.user.userId,
            activityUserId: req.user.userId,
          });
          if (!result.contact) {
            results.failed++;
            results.errors.push(`Contact ${id} not found`);
            continue;
          }
          contact = result.contact;
          results.succeeded++;
        } else {
          const updated = await storage.updateContact(id, { status }, req.user.contractorId);
          if (!updated) {
            results.failed++;
            results.errors.push(`Contact ${id} not found`);
            continue;
          }
          contact = updated;

          results.succeeded++;

          try {
            const activityContent = `Contact status changed to ${statusLabels[status]}`;
            await createActivityAndBroadcast(
              req.user.contractorId,
              { type: 'status_change', title: 'Status Changed', content: activityContent, contactId: id, userId: req.user.userId },
              { type: 'new_activity', contactId: id }
            );
          } catch (activityError) {
            log.error('Failed to create activity for bulk status change', activityError);
          }

          broadcastToContractor(req.user.contractorId, {
            type: 'contact_updated',
            contactId: contact.id,
            contactType: contact.type
          });

          workflowEngine.triggerWorkflowsForEvent('contact_status_changed', toWorkflowEvent(contact), req.user.contractorId).catch(error => {
            log.error('Error triggering workflows for bulk contact status change', error);
            auditLog({
              contractorId: req.user.contractorId,
              action: 'workflow.trigger_failure',
              entityType: 'contact',
              entityId: contact.id,
              after: { event: 'contact_status_changed', error: error instanceof Error ? error.message : String(error) },
            }).catch(auditErr => log.error('Failed to write audit log for workflow trigger failure', auditErr));
          });
        }

        void (async () => {
          try {
            const leads = await storage.getLeadsByContact(contact.id, req.user.contractorId);
            const latestLead = leads[0];
            if (latestLead) {
              await facebookService.sendConversionForStatus(req.user.contractorId, latestLead, contact, status);
            }
          } catch (fbErr) {
            log.error('Failed to fire Facebook conversion event (non-fatal)', fbErr);
          }
        })().catch(err => log.error('Unhandled error in Facebook conversion IIFE', err));
      } catch (err) {
        results.failed++;
        results.errors.push(`Contact ${id} failed to update`);
        log.error(`Failed to update contact ${id} in bulk status change`, err);
      }
    }

    res.json(results);
  }));

  app.post("/api/contacts/bulk-delete", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const bulkDeleteSchema = z.object({
      ids: z.array(z.string().uuid()).min(1).max(100),
    });
    const parsed = parseBody(bulkDeleteSchema, req, res);
    if (!parsed) return;
    const { ids } = parsed;

    const results: { succeeded: number; failed: number; errors: string[] } = {
      succeeded: 0, failed: 0, errors: [],
    };

    for (const id of ids) {
      try {
        const deleted = await storage.deleteContact(id, req.user.contractorId);
        if (!deleted) {
          results.failed++;
          results.errors.push(`Contact ${id} not found`);
          continue;
        }

        results.succeeded++;

        broadcastToContractor(req.user.contractorId, {
          type: 'contact_deleted',
          contactId: id
        });
      } catch (err) {
        results.failed++;
        results.errors.push(`Contact ${id} failed to delete`);
        log.error(`Failed to delete contact ${id} in bulk delete`, err);
      }
    }

    res.json(results);
  }));

  app.patch("/api/contacts/:id/follow-up", asyncHandler(async (req, res) => {
    // Derived from insertContactSchema — ensures followUpDate validation stays in sync with the schema
    const followUpSchema = insertContactSchema.pick({ followUpDate: true }).extend({
      followUpDate: z.string().nullable().optional().transform((val, ctx) => {
        if (!val) return null;
        const date = new Date(val);
        if (isNaN(date.getTime())) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid date format" });
          return z.NEVER;
        }
        return date;
      })
    });
    const parsed = parseBody(followUpSchema, req, res);
    if (!parsed) return;
    const { followUpDate } = parsed;

    const contact = await storage.updateContact(req.params.id, { followUpDate }, req.user.contractorId);
    if (!contact) {
      res.status(404).json({ message: "Contact not found" });
      return;
    }

    try {
      const activityContent = followUpDate
        ? `Follow-up date set to ${new Date(followUpDate).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`
        : 'Follow-up date cleared';

      await createActivityAndBroadcast(
        req.user.contractorId,
        { type: 'follow_up', title: 'Follow-up Date Updated', content: activityContent, contactId: req.params.id, userId: req.user.userId },
        { type: 'new_activity', contactId: req.params.id }
      );
    } catch (activityError) {
      log.error('Failed to create activity for follow-up update', activityError);
    }

    broadcastToContractor(req.user.contractorId, {
      type: 'contact_updated',
      contactId: contact.id,
      contactType: contact.type
    });

    res.json(contact);
  }));

  app.patch("/api/leads/bulk/archive", asyncHandler(async (req, res) => {
    const bulkArchiveSchema = z.object({
      ids: z.array(z.string().uuid()).min(1).max(100),
    });
    const parsed = parseBody(bulkArchiveSchema, req, res);
    if (!parsed) return;
    const { ids } = parsed;

    const results: { succeeded: number; failed: number; errors: string[] } = {
      succeeded: 0, failed: 0, errors: [],
    };

    for (const id of ids) {
      try {
        const lead = await storage.archiveLead(id, req.user.contractorId);
        if (!lead) {
          results.failed++;
          results.errors.push(`Lead ${id} not found`);
          continue;
        }
        results.succeeded++;
        broadcastToContractor(req.user.contractorId, { type: 'contact_updated', contactId: id });
      } catch (err) {
        results.failed++;
        results.errors.push(`Lead ${id} failed to archive`);
        log.error(`Failed to archive lead ${id} in bulk archive`, err);
      }
    }

    res.json(results);
  }));

  app.patch("/api/leads/bulk/restore", asyncHandler(async (req, res) => {
    const bulkRestoreSchema = z.object({
      ids: z.array(z.string().uuid()).min(1).max(100),
    });
    const parsed = parseBody(bulkRestoreSchema, req, res);
    if (!parsed) return;
    const { ids } = parsed;

    const results: { succeeded: number; failed: number; errors: string[] } = {
      succeeded: 0, failed: 0, errors: [],
    };

    for (const id of ids) {
      try {
        const lead = await storage.restoreLead(id, req.user.contractorId);
        if (!lead) {
          results.failed++;
          results.errors.push(`Lead ${id} not found`);
          continue;
        }
        results.succeeded++;
        broadcastToContractor(req.user.contractorId, { type: 'contact_updated', contactId: id });
      } catch (err) {
        results.failed++;
        results.errors.push(`Lead ${id} failed to restore`);
        log.error(`Failed to restore lead ${id} in bulk restore`, err);
      }
    }

    res.json(results);
  }));

  app.patch("/api/leads/:id/archive", asyncHandler(async (req, res) => {
    const lead = await storage.archiveLead(req.params.id, req.user.contractorId);
    if (!lead) {
      res.status(404).json({ message: "Lead not found" });
      return;
    }
    broadcastToContractor(req.user.contractorId, { type: 'contact_updated', contactId: req.params.id });
    res.json(lead);
  }));

  app.patch("/api/leads/:id/restore", asyncHandler(async (req, res) => {
    const lead = await storage.restoreLead(req.params.id, req.user.contractorId);
    if (!lead) {
      res.status(404).json({ message: "Lead not found" });
      return;
    }
    broadcastToContractor(req.user.contractorId, { type: 'contact_updated', contactId: req.params.id });
    res.json(lead);
  }));

  app.patch("/api/leads/bulk/age", asyncHandler(async (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ message: "ids array is required" });
      return;
    }
    const results = await Promise.all(
      ids.map((id: string) => storage.ageLead(id, req.user.contractorId))
    );
    for (const id of ids) {
      broadcastToContractor(req.user.contractorId, { type: 'contact_updated', contactId: id });
    }
    res.json({ success: true, count: results.filter(Boolean).length });
  }));

  app.patch("/api/leads/bulk/unage", asyncHandler(async (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ message: "ids array is required" });
      return;
    }
    const results = await Promise.all(
      ids.map((id: string) => storage.unageLead(id, req.user.contractorId))
    );
    for (const id of ids) {
      broadcastToContractor(req.user.contractorId, { type: 'contact_updated', contactId: id });
    }
    res.json({ success: true, count: results.filter(Boolean).length });
  }));

  app.patch("/api/leads/:id/age", asyncHandler(async (req, res) => {
    const lead = await storage.ageLead(req.params.id, req.user.contractorId);
    if (!lead) {
      res.status(404).json({ message: "Lead not found" });
      return;
    }
    broadcastToContractor(req.user.contractorId, { type: 'contact_updated', contactId: req.params.id });
    res.json(lead);
  }));

  app.patch("/api/leads/:id/unage", asyncHandler(async (req, res) => {
    const lead = await storage.unageLead(req.params.id, req.user.contractorId);
    if (!lead) {
      res.status(404).json({ message: "Lead not found" });
      return;
    }
    broadcastToContractor(req.user.contractorId, { type: 'contact_updated', contactId: req.params.id });
    res.json(lead);
  }));

  app.post("/api/contacts/merge", asyncHandler(async (req, res) => {
    const { primaryId, secondaryId } = req.body;
    if (!primaryId || !secondaryId || primaryId === secondaryId) {
      res.status(400).json({ message: "Two different contact IDs are required" });
      return;
    }
    try {
      const mergedContact = await storage.mergeContacts(primaryId, secondaryId, req.user.contractorId);
      broadcastToContractor(req.user.contractorId, { type: 'contact_updated', contactId: primaryId });
      broadcastToContractor(req.user.contractorId, { type: 'contact_deleted', contactId: secondaryId });
      res.json({ success: true, contact: mergedContact });
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "One or both contacts not found") {
        res.status(404).json({ message: err.message });
        return;
      }
      throw err;
    }
  }));

  app.delete("/api/contacts/:id", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const deleted = await storage.deleteContact(req.params.id, req.user.contractorId);
    if (!deleted) {
      res.status(404).json({ message: "Contact not found" });
      return;
    }

    broadcastToContractor(req.user.contractorId, {
      type: 'contact_deleted',
      contactId: req.params.id
    });

    res.status(200).json({ message: "Contact deleted successfully" });
  }));

  const exportRateLimiter = createRateLimiter({ windowMs: 60 * 1000, maxRequests: 5, keyPrefix: 'contact-export', useSessionId: true });

  app.get("/api/contacts/:id/export", requireAdmin, exportRateLimiter, asyncHandler(async (req, res) => {
    const contactId = req.params.id;
    const contractorId = req.user.contractorId;

    const contact = await storage.getContact(contactId, contractorId);
    if (!contact) {
      res.status(404).json({ message: "Contact not found" });
      return;
    }

    const [
      contactMessages,
      contactEstimates,
      contactJobs,
      contactConsentLogs,
      auditEntries,
    ] = await Promise.all([
      db.select().from(messages).where(and(eq(messages.contactId, contactId), eq(messages.contractorId, contractorId))),
      db.select().from(estimates).where(and(eq(estimates.contactId, contactId), eq(estimates.contractorId, contractorId))),
      db.select().from(jobs).where(and(eq(jobs.contactId, contactId), eq(jobs.contractorId, contractorId))),
      db.select().from(consentLogs).where(and(eq(consentLogs.contactId, contactId), eq(consentLogs.contractorId, contractorId))),
      db.execute(drizzleSql`SELECT * FROM audit_logs WHERE contractor_id = ${contractorId} AND entity_id = ${contactId} ORDER BY created_at DESC`),
    ]);

    const bundle = {
      exportedAt: new Date().toISOString(),
      contact,
      messages: contactMessages,
      estimates: contactEstimates,
      jobs: contactJobs,
      consentLogs: contactConsentLogs,
      auditLog: auditEntries.rows,
    };

    await auditLog({
      contractorId,
      userId: req.user.userId,
      action: 'contact.export',
      entityType: 'contact',
      entityId: contactId,
      ipAddress: req.ip,
    });

    res.json(bundle);
  }));

  app.post("/api/contacts/:id/erase", requireAdmin, asyncHandler(async (req, res) => {
    const eraseSchema = z.object({
      reason: z.string().max(1000).optional().default(""),
    });
    const parsed = parseBody(eraseSchema, req, res);
    if (!parsed) return;

    const contactId = req.params.id;
    const contractorId = req.user.contractorId;
    const { reason } = parsed;

    const contact = await storage.getContact(contactId, contractorId);
    if (!contact) {
      res.status(404).json({ message: "Contact not found" });
      return;
    }

    if (contact.anonymized) {
      res.status(400).json({ message: "Contact data has already been erased" });
      return;
    }

    const before = {
      name: contact.name,
      emails: contact.emails,
      phones: contact.phones,
      address: contact.address,
    };

    await storage.updateContact(contactId, {
      name: "Deleted User",
      emails: [],
      phones: [],
      address: null,
      notes: null,
      anonymized: true,
      erasedAt: new Date(),
    } as UpdateContact, contractorId);

    await db.execute(drizzleSql`UPDATE messages SET contact_id = NULL WHERE contact_id = ${contactId} AND contractor_id = ${contractorId}`);

    const after = { name: "Deleted User", emails: [], phones: [], address: null, anonymized: true };

    await auditLog({
      contractorId,
      userId: req.user.userId,
      action: 'contact.erasure',
      entityType: 'contact',
      entityId: contactId,
      before,
      after,
      reason,
      ipAddress: req.ip,
    });

    broadcastToContractor(contractorId, { type: 'contact_updated', contactId });
    res.json({ success: true, message: "Contact data erased successfully" });
  }));
}
