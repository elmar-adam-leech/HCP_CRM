import type { Express } from "express";
import { storage } from "../../storage";
import { isIntegrationEnabledCached } from "../../services/cache";
import { housecallProService } from "../../hcp/index";
import { requireAdmin } from "../../auth-service";
import { syncStatus, setSyncStatus, lastSyncLoaded } from "../../sync-status-store";
import { mapHcpEstimateStatus } from "../../sync/housecall-pro";
import { extractHcpAmount, resolveHcpEstimateStatus } from "../../sync/hcp-mappers";
import type { HcpOptionEntry } from "@shared/schema";
import { broadcastToContractor } from "../../websocket";
import { logger } from "../../utils/logger";
import { syncScheduler } from "../../sync-scheduler";
import { CredentialService } from "../../credential-service";
import crypto from "crypto";
import { asyncHandler } from "../../utils/async-handler";
import { db } from "../../db";
import { estimates as estimatesTable } from "@shared/schema";
import { and, eq } from "drizzle-orm";

const log = logger('HcpSync');

export function registerHcpSyncRoutes(app: Express): void {
  app.post("/api/housecall-pro/sync", asyncHandler(async (req, res) => {
    const contractorId = req.user.contractorId;
    const syncType = (req.query.type as string) || 'all';

    const isIntegrationEnabled = await isIntegrationEnabledCached(contractorId, 'housecall-pro');
    if (!isIntegrationEnabled) {
      res.status(403).json({
        message: "Housecall Pro integration is not enabled for this tenant. Please enable it first.",
        integrationDisabled: true
      });
      return;
    }

    setSyncStatus(contractorId, {
      isRunning: true,
      progress: 'Starting sync...',
      error: null,
      lastSync: null,
      startTime: new Date()
    });

    log.info(`Starting manual sync (type=${syncType}) for tenant ${contractorId}`);

    const syncStartDate = await storage.getHousecallProSyncStartDate(contractorId);
    log.info(`Using sync start date filter: ${syncStartDate ? syncStartDate.toISOString() : 'none'}`);

    res.status(202).json({ message: 'Sync started' });

    void (async () => {
      let newEstimates = 0;
      let updatedEstimates = 0;
      let newJobs = 0;

      try {
        if (syncType === 'estimates' || syncType === 'all') {
          setSyncStatus(contractorId, {
            isRunning: true,
            progress: 'Syncing estimates...',
            error: null,
            lastSync: null,
            startTime: new Date()
          });

          const baseEstimatesParams = syncStartDate ? {
            modified_since: syncStartDate.toISOString(),
            sort_by: 'created_at',
            sort_direction: 'desc',
            page_size: 100
          } : {
            sort_by: 'created_at',
            sort_direction: 'desc',
            page_size: 100
          };

          let allHousecallProEstimates: any[] = [];
          let page = 1;
          let keepGoing = true;
          const maxRunTime = 5 * 60 * 1000;
          const startTime = Date.now();

          while (keepGoing) {
            if (Date.now() - startTime > maxRunTime) {
              log.warn(`Time limit reached at page ${page}, aborting pagination`);
              break;
            }

            const estimatesParams = { ...baseEstimatesParams, page };
            log.info(`Fetching estimates page ${page}...`);

            setSyncStatus(contractorId, {
              isRunning: true,
              progress: `Fetching estimates page ${page}...`,
              error: null,
              lastSync: null,
              startTime: new Date()
            });

            const estimatesResult = await housecallProService.getEstimates(contractorId, estimatesParams);
            if (!estimatesResult.success) {
              log.error(`Failed to fetch estimates page ${page}: ${estimatesResult.error}`);
              setSyncStatus(contractorId, {
                isRunning: false,
                progress: null,
                error: `Failed to fetch estimates: ${estimatesResult.error}`,
                lastSync: null,
                startTime: null
              });
              return;
            }

            const pageEstimates = estimatesResult.data || [];
            log.info(`Page ${page}: fetched ${pageEstimates.length} estimates`);

            if (!pageEstimates.length) {
              log.info(`No more estimates found, stopping pagination`);
              break;
            }

            allHousecallProEstimates = allHousecallProEstimates.concat(pageEstimates);

            if (pageEstimates.length < baseEstimatesParams.page_size) {
              log.info(`Page ${page} returned ${pageEstimates.length} estimates (< ${baseEstimatesParams.page_size}), stopping pagination`);
              keepGoing = false;
            } else {
              page++;
            }
          }

          log.info(`Fetched ${allHousecallProEstimates.length} total estimates from Housecall Pro across ${page} pages`);

          const extractPhone = (customer?: any) => {
            if (!customer) return '';
            return customer.phone_numbers?.[0]?.phone_number ||
                   customer.mobile_number ||
                   customer.home_number ||
                   customer.work_number ||
                   customer.phone ||
                   customer.primary_phone ||
                   customer.contact_phone ||
                   customer.phone_number ||
                   '';
          };

          const extractAddress = (location?: any) => {
            if (!location) return '';
            const addr = location.service_location || location.address || location;
            if (!addr) return '';
            return `${addr.street || ''}, ${addr.city || ''}, ${addr.state || ''} ${addr.zip || ''}`.replace(/^,\s*/, '').trim();
          };

          for (const hcpEstimate of allHousecallProEstimates) {
            try {
              const existingEstimate = await storage.getEstimateByHousecallProEstimateId(hcpEstimate.id, contractorId);

              if (existingEstimate) {
                const syncedOptions: HcpOptionEntry[] | undefined = hcpEstimate.options?.filter((o: any) => o.id).map((o: any) => ({
                  id: o.id, name: o.name, option_number: o.option_number, total_amount: o.total_amount, approval_status: o.approval_status,
                }));
                const mappedStatus = mapHcpEstimateStatus(hcpEstimate);
                const resolvedStatus = resolveHcpEstimateStatus(
                  mappedStatus,
                  existingEstimate.status,
                  existingEstimate.statusManuallySet ?? false,
                );
                const updateData: Record<string, any> = {
                  status: resolvedStatus,
                  amount: extractHcpAmount(hcpEstimate).toFixed(2),
                  description: hcpEstimate.description || '',
                  scheduledStart: hcpEstimate.schedule?.scheduled_start ? new Date(hcpEstimate.schedule.scheduled_start) : null,
                  ...(syncedOptions && syncedOptions.length > 0 ? { hcpOptions: syncedOptions } : {}),
                };
                if (!existingEstimate.housecallProEstimateId) updateData.housecallProEstimateId = hcpEstimate.id;
                if (!existingEstimate.housecallProCustomerId && hcpEstimate.customer?.id) {
                  updateData.housecallProCustomerId = hcpEstimate.customer.id;
                }

                await storage.updateEstimate(existingEstimate.id, updateData, contractorId);
                broadcastToContractor(contractorId, { type: 'estimate_updated', estimateId: existingEstimate.id });
                updatedEstimates++;
                log.info(`Updated estimate ${existingEstimate.id} from HCP ${hcpEstimate.id}`);
              } else {
                const customerData = hcpEstimate.customer;
                if (!customerData) {
                  log.warn(`Skipping estimate ${hcpEstimate.id} - no customer data`);
                  continue;
                }

                if (customerData.id) {
                  const excluded = await storage.isHcpCustomerExcluded(contractorId, customerData.id);
                  if (excluded) {
                    log.info(`Skipping estimate ${hcpEstimate.id} - HCP customer ${customerData.id} is excluded`);
                    continue;
                  }
                }

                let localCustomer = await storage.getContactByExternalId(customerData.id, 'housecall-pro', contractorId);

                if (!localCustomer) {
                  const extractEmail = (customer?: any) => {
                    if (!customer) return '';
                    return customer.email || customer.email_address || customer.primary_email || customer.contact_email || '';
                  };

                  const extractedEmail = extractEmail(customerData);
                  const extractedPhone = extractPhone(customerData);

                  const newCustomerData = {
                    id: crypto.randomUUID(),
                    name: `${customerData.first_name || ''} ${customerData.last_name || ''}`.trim() || 'Unknown Customer',
                    type: 'customer' as const,
                    emails: extractedEmail ? [extractedEmail] : [],
                    phones: extractedPhone ? [extractedPhone] : [],
                    address: extractAddress(hcpEstimate),
                    housecallProCustomerId: customerData.id,
                    externalId: customerData.id,
                    externalSource: 'housecall-pro' as const,
                    createdAt: hcpEstimate.created_at ? new Date(hcpEstimate.created_at) : new Date(),
                    updatedAt: hcpEstimate.modified_at ? new Date(hcpEstimate.modified_at) : new Date(),
                  };

                  localCustomer = await storage.createContact(newCustomerData, contractorId);
                  broadcastToContractor(contractorId, { type: 'contact_created', contactId: localCustomer.id });
                  log.info(`Created customer ${localCustomer.id} from embedded data in estimate ${hcpEstimate.id}`);
                }

                const amountInDollars = extractHcpAmount(hcpEstimate).toFixed(2);

                let estimateTitle = 'Estimate from Housecall Pro';
                if (hcpEstimate.number) {
                  estimateTitle = `Estimate #${hcpEstimate.number}`;
                } else if (hcpEstimate.estimate_number) {
                  estimateTitle = `Estimate #${hcpEstimate.estimate_number}`;
                } else if (hcpEstimate.name) {
                  estimateTitle = hcpEstimate.name;
                } else if (hcpEstimate.id) {
                  estimateTitle = `Estimate #${hcpEstimate.id}`;
                }

                const estimateData = {
                  id: crypto.randomUUID(),
                  contactId: localCustomer.id,
                  title: estimateTitle,
                  description: hcpEstimate.description || '',
                  amount: amountInDollars,
                  status: mapHcpEstimateStatus(hcpEstimate),
                  createdAt: hcpEstimate.created_at ? new Date(hcpEstimate.created_at) : new Date(),
                  updatedAt: hcpEstimate.modified_at ? new Date(hcpEstimate.modified_at) : new Date(),
                  validUntil: hcpEstimate.expires_at ? new Date(hcpEstimate.expires_at) :
                             hcpEstimate.expiry_date ? new Date(hcpEstimate.expiry_date) :
                             hcpEstimate.valid_until ? new Date(hcpEstimate.valid_until) : null,
                  scheduledStart: hcpEstimate.schedule?.scheduled_start ? new Date(hcpEstimate.schedule.scheduled_start) : null,
                  externalId: hcpEstimate.id,
                  externalSource: 'housecall-pro' as const,
                  housecallProEstimateId: hcpEstimate.id,
                  housecallProCustomerId: customerData?.id || undefined,
                  hcpOptions: hcpEstimate.options?.filter((o: any) => o.id).map((o: any) => ({
                    id: o.id, name: o.name, option_number: o.option_number, total_amount: o.total_amount, approval_status: o.approval_status,
                  })) || undefined,
                };

                await storage.createEstimate(estimateData, contractorId);
                broadcastToContractor(contractorId, { type: 'estimate_created', estimateId: estimateData.id });
                newEstimates++;
                log.info(`Created estimate ${estimateData.id} from HCP ${hcpEstimate.id}`);
              }
            } catch (itemError) {
              log.error(`Failed to process estimate ${hcpEstimate.id}:`, itemError);
            }
          }
        }

        if (syncType === 'jobs' || syncType === 'all') {
          setSyncStatus(contractorId, {
            isRunning: true,
            progress: 'Syncing jobs...',
            error: null,
            lastSync: null,
            startTime: new Date()
          });

          log.info(`Starting jobs sync for tenant ${contractorId}`);

          const jobsCountBefore = await storage.getJobsCount(contractorId);

          await syncScheduler.syncHousecallProJobs(contractorId);

          const jobsCountAfter = await storage.getJobsCount(contractorId);
          newJobs = Math.max(0, jobsCountAfter - jobsCountBefore);

          log.info(`Jobs sync complete. New jobs: ${newJobs}`);
        }

        log.info(`Sync (type=${syncType}) completed for tenant ${contractorId}: ${newEstimates} new, ${updatedEstimates} updated estimates, ${newJobs} new jobs`);

        const now = new Date().toISOString();

        await CredentialService.setCredential(contractorId, 'housecall-pro', 'last_sync_at', now);
        await storage.updateSyncSchedule(contractorId, 'housecall-pro', { lastSyncAt: new Date() });

        setSyncStatus(contractorId, {
          isRunning: false,
          progress: null,
          error: null,
          lastSync: now,
          startTime: null
        });
      } catch (err: any) {
        log.error(`Background sync failed for tenant ${contractorId}:`, err);
        setSyncStatus(contractorId, {
          isRunning: false,
          progress: null,
          error: err.message || 'Sync failed unexpectedly',
          lastSync: null,
          startTime: null
        });
      }
    })().catch(err => log.error('Unhandled error in background sync IIFE', err));
  }));

  app.get("/api/sync-status", asyncHandler(async (req, res) => {
    const contractorId = req.user.contractorId;
    const status = syncStatus.get(contractorId) || {
      isRunning: false,
      progress: null,
      error: null,
      lastSync: null,
      startTime: null
    };

    // Fall back to DB-persisted timestamp when in-memory state was cleared (e.g. server restart)
    let lastSync = status.lastSync;
    if (lastSync === null && !status.isRunning && !lastSyncLoaded.has(contractorId)) {
      lastSync = await CredentialService.getCredential(contractorId, 'housecall-pro', 'last_sync_at') ?? null;
      lastSyncLoaded.add(contractorId);
      syncStatus.set(contractorId, { ...status, lastSync });
    }

    res.json({
      isRunning: status.isRunning,
      progress: status.progress,
      error: status.error,
      lastSync,
    });
  }));

  app.get("/api/housecall-pro/sync-start-date", requireAdmin, asyncHandler(async (req, res) => {
    const syncStartDate = await storage.getHousecallProSyncStartDate(req.user.contractorId);
    res.json({ syncStartDate: syncStartDate ? syncStartDate.toISOString() : null });
  }));

  app.post("/api/housecall-pro/sync-start-date", requireAdmin, asyncHandler(async (req, res) => {
    const { syncStartDate } = req.body;
    const parsedDate = syncStartDate ? new Date(syncStartDate) : null;
    await storage.setHousecallProSyncStartDate(req.user.contractorId, parsedDate);
    res.json({
      message: "Sync start date updated successfully",
      syncStartDate: parsedDate ? parsedDate.toISOString() : null
    });
  }));

  /**
   * POST /api/admin/backfill-estimate-statuses
   *
   * Idempotent recovery: re-fetches every HCP-synced estimate currently in the
   * 'scheduled' bucket and re-runs the mapper with the corrected merge rules
   * (`resolveHcpEstimateStatus`). Estimates whose true HCP state is now sent /
   * in_progress / approved / rejected are moved into that bucket. Estimates
   * the user has manually overridden are skipped. Estimates whose HCP state is
   * still genuinely 'scheduled' are surfaced in the response so the user can
   * decide whether to set them by hand.
   *
   * Never downgrades a non-scheduled estimate back to scheduled.
   */
  app.post("/api/admin/backfill-estimate-statuses", requireAdmin, asyncHandler(async (req, res) => {
    const contractorId = req.user.contractorId;

    const isIntegrationEnabled = await isIntegrationEnabledCached(contractorId, 'housecall-pro');
    if (!isIntegrationEnabled) {
      res.status(403).json({ message: "Housecall Pro integration is not enabled." });
      return;
    }

    // Optional safety cap; default is "no cap" so the one-time recovery
    // processes the entire affected (scheduled) population in a single run.
    const requestedLimit = req.body?.limit ?? req.query?.limit;
    const parsedLimit = requestedLimit === undefined || requestedLimit === null || requestedLimit === ''
      ? null
      : Number(requestedLimit);
    const limit = parsedLimit !== null && Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.floor(parsedLimit)
      : null;

    log.info(`[backfill] Starting estimate status backfill for tenant ${contractorId}${limit ? ` (limit ${limit})` : ' (no limit)'}`);
    let processed = 0;
    let updatedCount = 0;
    let failedCount = 0;
    let unchangedCount = 0;
    let manuallySetSkipped = 0;
    let noHcpIdSkipped = 0;
    const updatedRows: Array<{ id: string; hcpId: string; title: string; from: string; to: string }> = [];
    const stillScheduled: Array<{ id: string; hcpId: string; title: string }> = [];
    const failures: Array<{ id: string; hcpId: string; title: string; error: string }> = [];

    try {
      // Target only the regression-affected population: HCP-synced estimates
      // currently stuck in `scheduled`. Other statuses (sent / in_progress /
      // approved / rejected) are not at risk of being silently regressed by
      // the historical bug, so we deliberately exclude them to avoid any
      // unintended rewrites during the recovery run.
      const baseQuery = db.select()
        .from(estimatesTable)
        .where(and(
          eq(estimatesTable.contractorId, contractorId),
          eq(estimatesTable.externalSource, 'housecall-pro'),
          eq(estimatesTable.status, 'scheduled'),
        ));
      const candidates = limit !== null
        ? await baseQuery.limit(limit)
        : await baseQuery;

      log.info(`[backfill] Evaluating ${candidates.length} HCP-synced estimates`);

      for (const estimate of candidates) {
        processed++;
        const hcpId = estimate.housecallProEstimateId || estimate.externalId;
        if (!hcpId) {
          noHcpIdSkipped++;
          continue;
        }
        if (estimate.statusManuallySet) {
          manuallySetSkipped++;
          continue;
        }

        try {
          const fetchResult = await housecallProService.getEstimate(contractorId, hcpId);
          if (!fetchResult.success || !fetchResult.data) {
            failedCount++;
            failures.push({ id: estimate.id, hcpId, title: estimate.title, error: 'fetch failed or empty payload' });
            continue;
          }

          const mapped = mapHcpEstimateStatus(fetchResult.data);
          const newStatus = resolveHcpEstimateStatus(mapped, estimate.status, false);
          if (newStatus !== estimate.status) {
            await storage.updateEstimate(estimate.id, { status: newStatus, syncedAt: new Date() }, contractorId);
            broadcastToContractor(contractorId, { type: 'estimate_updated', estimateId: estimate.id });
            log.info(`[backfill] Updated estimate ${estimate.id} (HCP ${hcpId}): ${estimate.status} -> ${newStatus}`);
            updatedCount++;
            updatedRows.push({ id: estimate.id, hcpId, title: estimate.title, from: estimate.status, to: newStatus });
          } else {
            unchangedCount++;
            if (estimate.status === 'scheduled') {
              stillScheduled.push({ id: estimate.id, hcpId, title: estimate.title });
            }
          }
        } catch (itemErr: any) {
          log.error(`[backfill] Failed to re-evaluate estimate ${estimate.id} (HCP ${hcpId}):`, itemErr);
          failedCount++;
          failures.push({ id: estimate.id, hcpId, title: estimate.title, error: String(itemErr?.message ?? itemErr) });
        }
      }

      log.info(`[backfill] Complete: processed=${processed} updated=${updatedCount} unchanged=${unchangedCount} manuallySetSkipped=${manuallySetSkipped} noHcpIdSkipped=${noHcpIdSkipped} failed=${failedCount} stillScheduled=${stillScheduled.length}`);

      res.json({
        ok: true,
        limit,
        summary: {
          processed,
          updated: updatedCount,
          unchanged: unchangedCount,
          manuallySetSkipped,
          noHcpIdSkipped,
          failed: failedCount,
          stillScheduled: stillScheduled.length,
        },
        updated: updatedRows.slice(0, 200),
        stillScheduled: stillScheduled.slice(0, 200),
        failures: failures.slice(0, 50),
      });
    } catch (err: any) {
      log.error(`[backfill] Backfill failed for tenant ${contractorId}:`, err);
      res.status(500).json({ ok: false, error: String(err?.message ?? err) });
    }
  }));
}
