import type { Express } from "express";
import { asyncHandler } from "../utils/async-handler";
import { parseBody } from "../utils/validate-body";
import { storage } from "../storage";
import { isIntegrationEnabledCached } from "../services/cache";
import { insertEstimateSchema, estimateStatusEnum } from "@shared/schema";
import { requireManagerOrAdmin } from "../auth-service";
import { workflowEngine } from "../workflow-engine";
import { broadcastToContractor } from "../websocket";
import { createActivityAndBroadcast } from "../utils/activity";
import { housecallProService } from "../hcp/index";
import { toWorkflowEvent } from "../utils/workflow/entity-adapter";
import { logger } from "../utils/logger";
import { auditLog } from "../utils/audit-log";
import { normalizePhoneForHcp } from "../utils/phone-normalizer";
import { z } from "zod";

const log = logger('EstimateRoutes');

/**
 * Resolves (or creates) a HouseCall Pro customer ID for the given local contact,
 * then pushes the estimate to HCP and patches the local estimate record with the
 * resulting external ID.
 *
 * This is intentionally fire-and-forget from the route handler — any HCP errors
 * are logged but do not fail the local estimate creation.
 */
async function syncEstimateToHcp(
  contractorId: string,
  estimate: Awaited<ReturnType<typeof storage.createEstimate>>
): Promise<Awaited<ReturnType<typeof storage.createEstimate>>> {
  if (!estimate.contactId) return estimate;

  const contact = await storage.getContact(estimate.contactId, contractorId);
  if (!contact) return estimate;

  // Resolve HCP customer ID: use cached value, search by email/phone, or create new.
  let hcpCustomerId: string | undefined = contact.externalId || contact.housecallProCustomerId || undefined;

  if (!hcpCustomerId) {
    const contactEmail = contact.emails?.[0];
    const contactPhone = contact.phones?.[0];
    // HCP requires `mobile_number` to be exactly 10 digits with no formatting.
    const hcpPhone = normalizePhoneForHcp(contactPhone);

    if (contactEmail || contactPhone) {
      const searchResult = await housecallProService.searchCustomers(contractorId, {
        email: contactEmail,
        phone: hcpPhone,
      });
      if (searchResult.success && searchResult.data && searchResult.data.length > 0) {
        hcpCustomerId = searchResult.data[0].id;
      }
    }

    if (!hcpCustomerId) {
      const nameParts = contact.name.split(' ');
      const customerResult = await housecallProService.createCustomer(contractorId, {
        first_name: nameParts[0] || contact.name,
        last_name: nameParts.slice(1).join(' ') || '',
        email: contact.emails?.[0] || '',
        mobile_number: hcpPhone,
      });
      if (customerResult.success && customerResult.data?.id) {
        hcpCustomerId = customerResult.data.id;
      }
    }

    if (hcpCustomerId) {
      await storage.updateContact(
        contact.id,
        { externalId: hcpCustomerId, externalSource: 'housecall-pro', housecallProCustomerId: hcpCustomerId },
        contractorId
      );
    }
  }

  if (!hcpCustomerId) return estimate;

  let hcpAddress: { street: string; city: string; state: string; zip: string; country: string } | undefined;
  if (contact.address) {
    const parts = contact.address.split(',').map((s: string) => s.trim());
    const stateZip = (parts[2] || '').trim().split(' ');
    hcpAddress = {
      street: parts[0] || contact.address,
      city: parts[1] || '',
      state: stateZip[0] || '',
      zip: stateZip[1] || '',
      country: 'US',
    };
  }

  const hcpResult = await housecallProService.createEstimate(contractorId, {
    customer_id: hcpCustomerId,
    message: estimate.description || undefined,
    options: [{
      name: estimate.title,
      total_amount: estimate.amount && estimate.amount !== '0.00' ? estimate.amount : undefined,
    }],
    address: hcpAddress,
  });

  if (hcpResult.success && hcpResult.data?.id) {
    const updated = await storage.updateEstimate(
      estimate.id,
      { externalId: hcpResult.data.id, externalSource: 'housecall-pro' },
      contractorId
    );
    log.info(`Created HCP estimate: ${hcpResult.data.id} for estimate: ${estimate.id}`);
    return updated ?? estimate;
  } else {
    log.warn('Failed to create HCP estimate', hcpResult.error);
    return estimate;
  }
}

export function registerEstimateRoutes(app: Express): void {
  app.get("/api/estimates", asyncHandler(async (req, res) => {
    const estimates = await storage.getEstimates(req.user.contractorId);
    res.json(estimates);
  }));

  app.get("/api/estimates/paginated", asyncHandler(async (req, res) => {
    const cursor = req.query.cursor as string | undefined;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    const status = req.query.status as string | undefined;
    const search = req.query.search as string | undefined;
    const dateFrom = req.query.dateFrom as string | undefined;
    const dateTo = req.query.dateTo as string | undefined;
    const includeArchived = req.query.includeArchived === 'true';

    let archiveDays: number | undefined;
    if (!includeArchived) {
      const contractor = await storage.getContractor(req.user.contractorId);
      archiveDays = contractor?.estimateArchiveDays ?? undefined;
    }

    const result = await storage.getEstimatesPaginated(req.user.contractorId, { cursor, offset, limit, status, search, dateFrom, dateTo, archiveDays });
    // SAFE: `result` is a plain object returned by a storage function; adding an extra
    // field for the client is safe. The alternative is a new return type that adds
    // archiveDays to PaginatedEstimates, but that would widen the IStorage interface
    // for a view-layer concern. Casting to `any` here is narrowly scoped.
    (result as any).archiveDays = archiveDays ?? null;
    res.json(result);
  }));

  app.get("/api/estimates/status-counts", asyncHandler(async (req, res) => {
    const search = req.query.search as string | undefined;
    const dateFrom = req.query.dateFrom as string | undefined;
    const dateTo = req.query.dateTo as string | undefined;
    const includeArchived = req.query.includeArchived === 'true';

    let archiveDays: number | undefined;
    if (!includeArchived) {
      const contractor = await storage.getContractor(req.user.contractorId);
      archiveDays = contractor?.estimateArchiveDays ?? undefined;
    }

    const counts = await storage.getEstimatesStatusCounts(req.user.contractorId, { search, dateFrom, dateTo, archiveDays });
    res.json(counts);
  }));

  app.get("/api/estimates/follow-ups", asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 200, 500);
    const estimatesList = await storage.getEstimatesWithFollowUp(req.user.contractorId, limit);
    res.json(estimatesList);
  }));

  app.get("/api/estimates/:id", asyncHandler(async (req, res) => {
    const estimate = await storage.getEstimate(req.params.id, req.user.contractorId);
    if (!estimate) {
      res.status(404).json({ message: "Estimate not found" });
      return;
    }
    res.json(estimate);
  }));

  // Schema for estimate creation: contractorId comes from the session, not the body.
  // `amount` already accepts string|number via the shared insertEstimateSchema extension.
  const createEstimateSchema = insertEstimateSchema.omit({ contractorId: true });

  app.post("/api/estimates", asyncHandler(async (req, res) => {
    const body = parseBody(createEstimateSchema, req, res);
    if (!body) return;
    let estimate: Awaited<ReturnType<typeof storage.createEstimate>>;
    try {
      estimate = await storage.createEstimate(body, req.user.contractorId);
    } catch (err) {
      if (err instanceof Error && err.message.includes('Customer not found')) {
        res.status(400).json({ message: err.message });
        return;
      }
      throw err;
    }

    const hcpEnabled = await isIntegrationEnabledCached(req.user.contractorId, 'housecall-pro');
    if (hcpEnabled) {
      try {
        estimate = await syncEstimateToHcp(req.user.contractorId, estimate);
      } catch (hcpErr) {
        log.error('Error syncing estimate to HCP', hcpErr);
      }
    }

    broadcastToContractor(req.user.contractorId, { type: 'estimate_created', estimateId: estimate.id });
    workflowEngine.triggerWorkflowsForEvent('estimate_created', toWorkflowEvent(estimate), req.user.contractorId).catch(error => {
      log.error('Error triggering workflows for estimate creation', error);
      auditLog({
        contractorId: req.user.contractorId,
        action: 'workflow.trigger_failure',
        entityType: 'estimate',
        entityId: estimate.id,
        after: { event: 'estimate_created', error: error instanceof Error ? error.message : String(error) },
      }).catch(auditErr => log.error('Failed to write audit log for workflow trigger failure', auditErr));
    });
    res.status(201).json(estimate);
  }));

  app.patch("/api/estimates/:id/status", asyncHandler(async (req, res) => {
    const { status } = req.body ?? {};
    const validStatuses = estimateStatusEnum.enumValues;
    if (!status || !validStatuses.includes(status)) {
      res.status(400).json({ message: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
      return;
    }
    const existingEstimate = await storage.getEstimate(req.params.id, req.user.contractorId);
    if (!existingEstimate) {
      res.status(404).json({ message: "Estimate not found" });
      return;
    }

    // Status-only updates are allowed even on HCP-synced estimates. The
    // `statusManuallySet` flag (set below) ensures the next sync from HCP will
    // not overwrite the user's choice.
    const estimate = await storage.updateEstimate(
      req.params.id,
      { status, statusManuallySet: true },
      req.user.contractorId,
    );
    if (!estimate) {
      res.status(404).json({ message: "Estimate not found" });
      return;
    }

    broadcastToContractor(req.user.contractorId, { type: 'estimate_updated', estimateId: estimate.id });
    workflowEngine.triggerWorkflowsForEvent('estimate_updated', toWorkflowEvent(estimate), req.user.contractorId).catch(error => {
      log.error('Error triggering workflows for estimate status update', error);
      auditLog({
        contractorId: req.user.contractorId,
        action: 'workflow.trigger_failure',
        entityType: 'estimate',
        entityId: estimate.id,
        after: { event: 'estimate_updated', error: error instanceof Error ? error.message : String(error) },
      }).catch(auditErr => log.error('Failed to write audit log for workflow trigger failure', auditErr));
    });

    if (existingEstimate.status !== estimate.status) {
      workflowEngine.triggerWorkflowsForEvent('estimate_status_changed', toWorkflowEvent(estimate), req.user.contractorId).catch(error => {
        log.error('Error triggering workflows for estimate status change', error);
        auditLog({
          contractorId: req.user.contractorId,
          action: 'workflow.trigger_failure',
          entityType: 'estimate',
          entityId: estimate.id,
          after: { event: 'estimate_status_changed', error: error instanceof Error ? error.message : String(error) },
        }).catch(auditErr => log.error('Failed to write audit log for workflow trigger failure', auditErr));
      });
    }

    res.json(estimate);
  }));

  app.put("/api/estimates/:id", asyncHandler(async (req, res) => {
    const existingEstimate = await storage.getEstimate(req.params.id, req.user.contractorId);
    if (!existingEstimate) {
      res.status(404).json({ message: "Estimate not found" });
      return;
    }
    if (existingEstimate.externalSource === 'housecall-pro') {
      res.status(403).json({
        message: "Cannot edit Housecall Pro estimates - they are read-only for tracking lead value. Status updates are managed in Housecall Pro."
      });
      return;
    }
    const updateData = parseBody(insertEstimateSchema.omit({ contractorId: true, contactId: true }).partial(), req, res);
    if (!updateData) return;
    const estimate = await storage.updateEstimate(req.params.id, updateData, req.user.contractorId);
    if (!estimate) {
      res.status(404).json({ message: "Estimate not found" });
      return;
    }

    broadcastToContractor(req.user.contractorId, { type: 'estimate_updated', estimateId: estimate.id });
    workflowEngine.triggerWorkflowsForEvent('estimate_updated', toWorkflowEvent(estimate), req.user.contractorId).catch(error => {
      log.error('Error triggering workflows for estimate update', error);
      auditLog({
        contractorId: req.user.contractorId,
        action: 'workflow.trigger_failure',
        entityType: 'estimate',
        entityId: estimate.id,
        after: { event: 'estimate_updated', error: error instanceof Error ? error.message : String(error) },
      }).catch(auditErr => log.error('Failed to write audit log for workflow trigger failure', auditErr));
    });

    if (updateData.status) {
      workflowEngine.triggerWorkflowsForEvent('estimate_status_changed', toWorkflowEvent(estimate), req.user.contractorId).catch(error => {
        log.error('Error triggering workflows for estimate status change', error);
        auditLog({
          contractorId: req.user.contractorId,
          action: 'workflow.trigger_failure',
          entityType: 'estimate',
          entityId: estimate.id,
          after: { event: 'estimate_status_changed', error: error instanceof Error ? error.message : String(error) },
        }).catch(auditErr => log.error('Failed to write audit log for workflow trigger failure', auditErr));
      });
    }

    res.json(estimate);
  }));

  app.patch("/api/estimates/:id/follow-up", asyncHandler(async (req, res) => {
    const existingEstimate = await storage.getEstimate(req.params.id, req.user.contractorId);
    if (!existingEstimate) {
      res.status(404).json({ message: "Estimate not found" });
      return;
    }
    const followUpSchema = z.object({
      followUpDate: z.preprocess(
        (val) => {
          if (val === null || val === undefined || val === '') return null;
          const date = new Date(val as string);
          return isNaN(date.getTime()) ? undefined : date;
        },
        z.date().nullable()
      )
    });
    const parsed = parseBody(followUpSchema, req, res);
    if (!parsed) return;
    const { followUpDate } = parsed;
    const estimate = await storage.updateEstimate(req.params.id, { followUpDate }, req.user.contractorId);
    if (!estimate) {
      res.status(404).json({ message: "Estimate not found" });
      return;
    }

    try {
      const activityContent = followUpDate
        ? `Follow-up date set to ${new Date(followUpDate).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`
        : 'Follow-up date cleared';

      await createActivityAndBroadcast(
        req.user.contractorId,
        { type: 'follow_up', title: 'Follow-up Date Updated', content: activityContent, estimateId: req.params.id, userId: req.user.userId },
        { type: 'new_activity', estimateId: req.params.id }
      );
    } catch (activityError) {
      log.error('Failed to create activity for estimate follow-up update', activityError);
    }

    broadcastToContractor(req.user.contractorId, { type: 'estimate_updated', estimateId: estimate.id });
    res.json(estimate);
  }));

  app.delete("/api/estimates/:id", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const existingEstimate = await storage.getEstimate(req.params.id, req.user.contractorId);
    if (!existingEstimate) {
      res.status(404).json({ message: "Estimate not found" });
      return;
    }

    const deleted = await storage.deleteEstimate(req.params.id, req.user.contractorId);
    if (!deleted) {
      res.status(404).json({ message: "Estimate not found" });
      return;
    }

    broadcastToContractor(req.user.contractorId, { type: 'estimate_deleted', estimateId: req.params.id });
    res.json({ message: "Estimate deleted successfully" });
  }));
}
