import { db } from "../db";
import { messages, activities, contractors, webhookEvents } from "@shared/schema";
import { and, isNull, isNotNull, sql, eq, lt } from "drizzle-orm";
import { logger } from "../utils/logger";
import { formatDbError } from "../utils/db-error";

const log = logger('MessageCleanup');

interface ContractorCleanupResult {
  contractorId: string;
  contractorName: string;
  deletedMessagesCount: number;
  deletedActivitiesCount: number;
}

class MessageCleanupService {
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly CLEANUP_DAYS = 7;
  private readonly CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

  start() {
    if (this.cleanupInterval) {
      log.info('Service already running');
      return;
    }

    log.info(`Starting cleanup service - will delete orphaned messages and activities older than ${this.CLEANUP_DAYS} days`);
    log.info('Safety criteria: Only deletes items with NULL foreign keys AND no userId');
    log.info('Tenant isolation: Cleanup is performed per-contractor for auditability');
    
    // Don't run cleanup immediately on startup - wait for first scheduled run
    // This prevents accidental data loss during development/testing
    log.info('First cleanup scheduled in 24 hours');
    
    // Schedule daily cleanup
    this.cleanupInterval = setInterval(() => {
      this.performCleanup();
    }, this.CHECK_INTERVAL);
  }

  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      log.info('Service stopped');
    }
  }

  /**
   * Perform cleanup for a specific contractor
   * This ensures tenant isolation by only deleting orphaned records within a single contractor's scope
   */
  private async performCleanupForContractor(contractorId: string, contractorName: string, cutoffDate: Date): Promise<ContractorCleanupResult> {
    // Delete SMS messages where:
    // - contractorId matches (tenant isolation)
    // - contactId is null AND
    // - estimateId is null AND
    // - userId is null (additional safety - messages with user association are preserved)
    // - created more than 30 days ago
    const messagesResult = await db.delete(messages)
      .where(
        and(
          eq(messages.contractorId, contractorId),
          isNull(messages.contactId),
          isNull(messages.estimateId),
          isNull(messages.userId),
          sql`${messages.createdAt} < ${cutoffDate}`
        )
      );

    const deletedMessagesCount = messagesResult.rowCount || 0;

    // Delete ALL orphaned activities where:
    // - contractorId matches (tenant isolation)
    // - contactId is null AND
    // - estimateId is null AND
    // - jobId is null AND
    // - userId is null (additional safety - activities with user association are preserved)
    // - created more than 30 days ago
    const activitiesResult = await db.delete(activities)
      .where(
        and(
          eq(activities.contractorId, contractorId),
          isNull(activities.contactId),
          isNull(activities.estimateId),
          isNull(activities.jobId),
          isNull(activities.userId),
          sql`${activities.createdAt} < ${cutoffDate}`
        )
      );

    const deletedActivitiesCount = activitiesResult.rowCount || 0;

    return {
      contractorId,
      contractorName,
      deletedMessagesCount,
      deletedActivitiesCount
    };
  }

  /**
   * Delete webhook_events rows according to tiered retention rules:
   *   - Processed (no error): deleted after 7 days
   *   - Errored (error_message set): deleted after 30 days
   *   - Unprocessed and older than 30 days: purged as a safety valve for permanently
   *     stuck events (these should be surfaced as alerts, not kept forever)
   *
   * Each case runs as a separate DELETE so log output clearly shows how many rows
   * each rule removed.
   */
  private async cleanupWebhookEvents(): Promise<number> {
    const cutoff7d = new Date();
    cutoff7d.setDate(cutoff7d.getDate() - 7);

    const cutoff30d = new Date();
    cutoff30d.setDate(cutoff30d.getDate() - 30);

    // Case 1: processed events with no error older than 7 days
    const processedResult = await db.delete(webhookEvents)
      .where(
        and(
          eq(webhookEvents.processed, true),
          isNull(webhookEvents.errorMessage),
          lt(webhookEvents.createdAt, cutoff7d)
        )
      );
    const processedDeleted = processedResult.rowCount || 0;
    log.info(`Webhook events cleanup — processed (no error) older than 7 days: ${processedDeleted} row(s) deleted`);

    // Case 2: errored events (error_message set) older than 30 days
    const erroredResult = await db.delete(webhookEvents)
      .where(
        and(
          isNotNull(webhookEvents.errorMessage),
          lt(webhookEvents.createdAt, cutoff30d)
        )
      );
    const erroredDeleted = erroredResult.rowCount || 0;
    log.info(`Webhook events cleanup — errored (error_message set) older than 30 days: ${erroredDeleted} row(s) deleted`);

    // Case 3: unprocessed events older than 30 days (permanently stuck — safety valve)
    const stuckResult = await db.delete(webhookEvents)
      .where(
        and(
          eq(webhookEvents.processed, false),
          isNull(webhookEvents.errorMessage),
          lt(webhookEvents.createdAt, cutoff30d)
        )
      );
    const stuckDeleted = stuckResult.rowCount || 0;
    log.info(`Webhook events cleanup — unprocessed (stuck) older than 30 days: ${stuckDeleted} row(s) deleted`);

    return processedDeleted + erroredDeleted + stuckDeleted;
  }

  async performCleanup() {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.CLEANUP_DAYS);

      log.info(`Starting tenant-isolated cleanup for orphaned items older than ${cutoffDate.toISOString()}`);

      // Get all contractors for per-tenant cleanup
      const allContractors = await db.select({ id: contractors.id, name: contractors.name }).from(contractors);
      
      if (allContractors.length === 0) {
        log.info('No contractors found, skipping cleanup');
        return { 
          success: true, 
          deletedMessagesCount: 0,
          deletedActivitiesCount: 0,
          totalDeleted: 0,
          contractorResults: []
        };
      }

      const contractorResults: ContractorCleanupResult[] = [];
      let totalMessagesDeleted = 0;
      let totalActivitiesDeleted = 0;

      // Process contractors in batches of 5 to bound DB concurrency.
      // Firing all tenants in parallel would open one connection per contractor,
      // which can exhaust the connection pool when the tenant count grows large.
      const BATCH_SIZE = 5;
      const settled: PromiseSettledResult<ContractorCleanupResult>[] = [];
      for (let i = 0; i < allContractors.length; i += BATCH_SIZE) {
        const batch = allContractors.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.allSettled(
          batch.map(c => this.performCleanupForContractor(c.id, c.name, cutoffDate))
        );
        settled.push(...batchResults);
      }

      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') {
          const result = outcome.value;
          if (result.deletedMessagesCount > 0 || result.deletedActivitiesCount > 0) {
            contractorResults.push(result);
            totalMessagesDeleted += result.deletedMessagesCount;
            totalActivitiesDeleted += result.deletedActivitiesCount;
            log.info(`Contractor "${result.contractorName}" (${result.contractorId}): Deleted ${result.deletedMessagesCount} message(s), ${result.deletedActivitiesCount} activity(ies)`);
          }
        } else {
          log.error(`Contractor cleanup failed: ${formatDbError(outcome.reason)}`);
        }
      }

      if (totalMessagesDeleted === 0 && totalActivitiesDeleted === 0) {
        log.info('No orphaned messages or activities to clean up across all contractors');
      } else {
        log.info(`Total cleanup: ${totalMessagesDeleted} message(s), ${totalActivitiesDeleted} activity(ies) across ${contractorResults.length} contractor(s)`);
      }

      // Clean up webhook events per tiered retention: 7d processed, 30d errored/stuck
      let deletedWebhookEventsCount = 0;
      try {
        deletedWebhookEventsCount = await this.cleanupWebhookEvents();
        if (deletedWebhookEventsCount > 0) {
          log.info(`Webhook events cleanup total: ${deletedWebhookEventsCount} row(s) deleted`);
        } else {
          log.info('No webhook events to clean up');
        }
      } catch (err) {
        log.error(`Failed to clean up webhook events: ${formatDbError(err)}`);
      }

      return { 
        success: true, 
        deletedMessagesCount: totalMessagesDeleted,
        deletedActivitiesCount: totalActivitiesDeleted,
        totalDeleted: totalMessagesDeleted + totalActivitiesDeleted + deletedWebhookEventsCount,
        contractorResults
      };
    } catch (error) {
      log.error(`Error during cleanup: ${formatDbError(error)}`);
      return { success: false, error };
    }
  }

  /**
   * Perform cleanup for a specific contractor only (admin use)
   * Useful for targeted cleanup without affecting other tenants
   */
  async forceCleanupForContractor(contractorId: string): Promise<{ success: boolean; result?: ContractorCleanupResult; error?: unknown }> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.CLEANUP_DAYS);

      // Get contractor name for logging
      const contractorResult = await db.select({ name: contractors.name }).from(contractors).where(eq(contractors.id, contractorId)).limit(1);
      const contractorName = contractorResult[0]?.name || 'Unknown';

      log.info(`Manual cleanup triggered for contractor "${contractorName}" (${contractorId})`);
      
      const result = await this.performCleanupForContractor(contractorId, contractorName, cutoffDate);
      
      log.info(`Contractor "${contractorName}": Deleted ${result.deletedMessagesCount} message(s), ${result.deletedActivitiesCount} activity(ies)`);
      
      return { success: true, result };
    } catch (error) {
      log.error(`Error during cleanup for contractor ${contractorId}: ${formatDbError(error)}`);
      return { success: false, error };
    }
  }

  // Manual cleanup for admin use - requires explicit call (cleans all contractors)
  async forceCleanup(): Promise<{ success: boolean; deletedMessagesCount?: number; deletedActivitiesCount?: number; totalDeleted?: number; contractorResults?: ContractorCleanupResult[]; error?: unknown }> {
    log.info('Manual cleanup triggered by admin (all contractors)');
    return this.performCleanup();
  }

  getCleanupDays(): number {
    return this.CLEANUP_DAYS;
  }
}

export const messageCleanupService = new MessageCleanupService();
