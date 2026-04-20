import type { Express, Response } from "express";
import { housecallProService } from "../../hcp/index";
import { type AuthedRequest } from "../../auth-service";
import { asyncHandler } from "../../utils/async-handler";
import { isIntegrationEnabledCached } from "../../services/cache";
import { logger } from "../../utils/logger";
import { CredentialService } from "../../credential-service";
import { syncHcpLeadSources } from "../../sync/housecall-pro";
import { z } from "zod";
import { parseBody } from "../../utils/validate-body";

const log = logger('HousecallPro');

export function registerHousecallProRoutes(app: Express): void {
  app.get("/api/housecall-pro/status", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const isIntegrationEnabled = await isIntegrationEnabledCached(req.user.contractorId, 'housecall-pro');
    if (!isIntegrationEnabled) {
      res.status(403).json({
        message: "Housecall Pro integration is not enabled for this tenant. Please enable it first.",
        integrationDisabled: true
      });
      return;
    }

    const isConfigured = await housecallProService.isConfigured(req.user.contractorId);
    if (!isConfigured) {
      res.json({ configured: false, connected: false });
      return;
    }

    const connection = await housecallProService.checkConnection(req.user.contractorId);
    res.json({
      configured: true,
      connected: connection.connected,
      error: connection.error
    });
  }));

  app.get("/api/housecall-pro/employees", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const isIntegrationEnabled = await isIntegrationEnabledCached(req.user.contractorId, 'housecall-pro');
    if (!isIntegrationEnabled) {
      res.status(403).json({
        message: "Housecall Pro integration is not enabled for this tenant. Please enable it first.",
        integrationDisabled: true
      });
      return;
    }

    const result = await housecallProService.getEmployees(req.user.contractorId);
    if (!result.success) {
      res.status(400).json({ message: result.error });
      return;
    }
    res.json(result.data);
  }));

  app.get("/api/housecall-pro/availability", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const isIntegrationEnabled = await isIntegrationEnabledCached(req.user.contractorId, 'housecall-pro');
    if (!isIntegrationEnabled) {
      res.status(403).json({
        message: "Housecall Pro integration is not enabled for this tenant. Please enable it first.",
        integrationDisabled: true
      });
      return;
    }

    const { date, estimatorIds } = req.query;

    if (!date || typeof date !== 'string') {
      res.status(400).json({ message: "Date parameter is required (YYYY-MM-DD format)" });
      return;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ message: "Invalid date format. Use YYYY-MM-DD" });
      return;
    }

    let estimatorIdArray: string[] | undefined;
    if (estimatorIds) {
      if (typeof estimatorIds === 'string') {
        estimatorIdArray = estimatorIds.split(',').filter(id => id.trim());
      } else if (Array.isArray(estimatorIds)) {
        estimatorIdArray = (estimatorIds as string[]).filter(id => typeof id === 'string' && id.trim());
      }
    }

    const result = await housecallProService.getEstimatorAvailability(
      req.user.contractorId,
      date,
      estimatorIdArray
    );

    if (!result.success) {
      res.status(400).json({ message: result.error });
      return;
    }

    res.json(result.data);
  }));

  app.get("/api/housecall/employee-estimates", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { employeeId, date } = req.query;

    if (!employeeId || !date) {
      res.status(400).json({ message: "employeeId and date are required" });
      return;
    }

    const startOfDay = new Date(`${date}T00:00:00`);
    const endOfDay = new Date(`${date}T23:59:59`);

    const result = await housecallProService.getEmployeeScheduledEstimates(
      req.user.contractorId,
      employeeId as string,
      startOfDay,
      endOfDay
    );

    if (!result.success) {
      log.error('Failed to fetch employee estimates:', result.error);
      res.json([]);
      return;
    }

    const scheduledEstimates: Array<{id: string, scheduled_start: string, scheduled_end: string}> = [];

    for (const est of (result.data || [])) {
      if (est.scheduled_start && est.scheduled_end) {
        scheduledEstimates.push({ id: est.id, scheduled_start: est.scheduled_start, scheduled_end: est.scheduled_end });
      }
      if (est.schedule?.scheduled_start && est.schedule?.scheduled_end) {
        scheduledEstimates.push({ id: est.id, scheduled_start: est.schedule.scheduled_start, scheduled_end: est.schedule.scheduled_end });
      }
      if (est.options && Array.isArray(est.options)) {
        for (const opt of est.options) {
          if (opt.schedule?.start_time && opt.schedule?.end_time) {
            scheduledEstimates.push({ id: est.id, scheduled_start: opt.schedule.start_time, scheduled_end: opt.schedule.end_time });
          }
          if (opt.scheduled_start && opt.scheduled_end) {
            scheduledEstimates.push({ id: est.id, scheduled_start: opt.scheduled_start, scheduled_end: opt.scheduled_end });
          }
        }
      }
    }

    res.json(scheduledEstimates);
  }));

  app.get("/api/integrations/housecall-pro/lead-source", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const creds = await CredentialService.getCredentialsWithFallback(req.user.contractorId, 'housecall-pro');
    res.json({ leadSource: creds.lead_source || null });
  }));

  app.post("/api/integrations/housecall-pro/lead-source", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const schema = z.object({ leadSource: z.string() });
    const parsed = parseBody(schema, req, res);
    if (!parsed) return;
    const { leadSource } = parsed;
    if (leadSource.trim()) {
      await CredentialService.setCredential(req.user.contractorId, 'housecall-pro', 'lead_source', leadSource.trim());
    } else {
      await CredentialService.setCredential(req.user.contractorId, 'housecall-pro', 'lead_source', '');
    }
    res.json({ success: true });
  }));

  app.get("/api/integrations/housecall-pro/lead-sources", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const creds = await CredentialService.getServiceCredentials(req.user.contractorId, 'housecall-pro');
    let sources: string[] = [];
    if (creds.lead_sources_cache) {
      try {
        sources = JSON.parse(creds.lead_sources_cache);
      } catch {
        sources = [];
      }
    }
    if (sources.length === 0) {
      await syncHcpLeadSources(req.user.contractorId);
      const freshCreds = await CredentialService.getServiceCredentials(req.user.contractorId, 'housecall-pro');
      if (freshCreds.lead_sources_cache) {
        try { sources = JSON.parse(freshCreds.lead_sources_cache); } catch { sources = []; }
      }
    }
    res.json({ sources });
  }));

  app.post("/api/integrations/housecall-pro/lead-sources/refresh", asyncHandler(async (req: AuthedRequest, res: Response) => {
    await syncHcpLeadSources(req.user.contractorId);
    const freshCreds = await CredentialService.getServiceCredentials(req.user.contractorId, 'housecall-pro');
    let sources: string[] = [];
    if (freshCreds.lead_sources_cache) {
      try { sources = JSON.parse(freshCreds.lead_sources_cache); } catch { sources = []; }
    }
    res.json({ sources });
  }));

  app.get("/api/settings/hcp-lead-source-mapping", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const creds = await CredentialService.getServiceCredentials(req.user.contractorId, 'housecall-pro');
    let mapping: Record<string, string> = {};
    if (creds.lead_source_mapping) {
      try { mapping = JSON.parse(creds.lead_source_mapping); } catch { mapping = {}; }
    }
    const defaultLeadSource = creds.lead_source || null;
    res.json({ mapping, defaultLeadSource });
  }));

  app.patch("/api/settings/hcp-lead-source-mapping", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const schema = z.object({
      mapping: z.record(z.string()).optional(),
      defaultLeadSource: z.string().nullable().optional(),
    });
    const parsed = parseBody(schema, req, res);
    if (!parsed) return;
    if (parsed.mapping !== undefined) {
      await CredentialService.setCredential(
        req.user.contractorId,
        'housecall-pro',
        'lead_source_mapping',
        JSON.stringify(parsed.mapping),
      );
    }
    if (parsed.defaultLeadSource !== undefined) {
      await CredentialService.setCredential(
        req.user.contractorId,
        'housecall-pro',
        'lead_source',
        parsed.defaultLeadSource ?? '',
      );
    }
    res.json({ success: true });
  }));
}
