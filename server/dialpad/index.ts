/**
 * Dialpad module — unified singleton and backward-compatible exports.
 *
 * Module ownership:
 *   - types.ts      : All shared TypeScript interfaces (no logic).
 *   - client.ts     : getCredentials (env-var fallback preserved), dialpadFetch helper.
 *   - utils.ts      : Phone normalization, error mapping.
 *   - numbers.ts    : Phone number fetch, sync, and availability (withRetry on reads).
 *   - users.ts      : User and department fetch and sync (withRetry on reads).
 *   - messaging.ts  : sendSms, initiateCall, listRecentSms, getSmsById, sendText,
 *                     getCallDetails, checkConnection.
 *                     NO retry on any write operations (POST/DELETE).
 *   - permissions.ts: checkUserPhonePermission, getUserAvailablePhoneNumbers.
 *   - webhooks/     : Webhook and subscription management, split into
 *                     lifecycle, sms-subscriptions, call-subscriptions, and
 *                     orchestrator concerns (with an index.ts barrel).
 *                     NO retry on any write operations (POST/DELETE).
 *   - index.ts      : DialpadEnhancedService class wrapping all modules,
 *                     syncDialpadDataToCache (legacy full-sync path),
 *                     isConfigured check, singleton export, backward-compat aliases.
 *
 * Retry policy summary:
 *   - Read operations use withRetry (via dialpadFetch) to handle transient 429/5xx.
 *   - Write operations (POST, DELETE) never use withRetry — retrying risks duplicate
 *     messages, duplicate calls, or duplicate webhook registrations.
 */

import { credentialService } from '../credential-service';
import { storage } from '../storage';
import { logger } from '../utils/logger';
import { maskEmail, maskPhone } from '../utils/pii-redactor';

import { getCredentials } from './client';
import {
  fetchDialpadUsers,
  fetchDialpadDepartments,
  syncUsers,
  syncDepartments,
  getCompanyUsers,
  getDepartments,
  getCompanyOffices,
} from './users';
import {
  fetchDialpadNumbers,
  getPhoneNumberDetails,
  syncPhoneNumbers,
  getCompanyNumbers,
  getAvailablePhoneNumbers,
} from './numbers';
import {
  sendSms,
  initiateCall,
  listRecentSms,
  getSmsById,
  sendText,
  getCallDetails,
  checkConnection,
} from './messaging';
import {
  checkUserPhonePermission,
  getUserAvailablePhoneNumbers,
} from './permissions';
import {
  createWebhook,
  createSmsSubscription,
  createWebhookWithSubscription,
  reregisterCallSubscriptions,
  deleteWebhook,
  deleteSmsSubscription,
  listWebhooks,
  listCallSubscriptions,
  listSmsSubscriptions,
} from './webhooks';

export type {
  DialpadUser,
  DialpadNumber,
  DialpadDepartment,
  DialpadApiResponse,
  LegacyDialpadUser,
  LegacyDialpadDepartment,
  LegacyDialpadPhoneNumber,
  LegacyDialpadResponse,
  LegacyDialpadCallResponse,
} from './types';

const log = logger('DialpadEnhancedService');

/**
 * DialpadEnhancedService — facade class wrapping all dialpad/* module functions.
 *
 * The class exists to provide a familiar OOP interface for callers and to host
 * syncDialpadDataToCache (the legacy full-sync path that coordinates users +
 * phone numbers + a SyncJob record in a single transaction-like flow).
 *
 * New code should prefer importing from the individual modules directly.
 */
export class DialpadEnhancedService {
  async getCredentials(contractorId: string) {
    return getCredentials(contractorId);
  }

  async fetchDialpadUsers(...args: Parameters<typeof fetchDialpadUsers>) {
    return fetchDialpadUsers(...args);
  }

  async fetchDialpadNumbers(...args: Parameters<typeof fetchDialpadNumbers>) {
    return fetchDialpadNumbers(...args);
  }

  async fetchDialpadDepartments(...args: Parameters<typeof fetchDialpadDepartments>) {
    return fetchDialpadDepartments(...args);
  }

  async getPhoneNumberDetails(...args: Parameters<typeof getPhoneNumberDetails>) {
    return getPhoneNumberDetails(...args);
  }

  async syncPhoneNumbers(...args: Parameters<typeof syncPhoneNumbers>) {
    return syncPhoneNumbers(...args);
  }

  async syncUsers(...args: Parameters<typeof syncUsers>) {
    return syncUsers(...args);
  }

  async syncDepartments(...args: Parameters<typeof syncDepartments>) {
    return syncDepartments(...args);
  }

  async checkUserPhonePermission(...args: Parameters<typeof checkUserPhonePermission>) {
    return checkUserPhonePermission(...args);
  }

  async getUserAvailablePhoneNumbers(...args: Parameters<typeof getUserAvailablePhoneNumbers>) {
    return getUserAvailablePhoneNumbers(...args);
  }

  async listRecentSms(...args: Parameters<typeof listRecentSms>) {
    return listRecentSms(...args);
  }

  async getSmsById(...args: Parameters<typeof getSmsById>) {
    return getSmsById(...args);
  }

  async sendSms(...args: Parameters<typeof sendSms>) {
    return sendSms(...args);
  }

  async initiateCall(...args: Parameters<typeof initiateCall>) {
    return initiateCall(...args);
  }

  async createWebhook(...args: Parameters<typeof createWebhook>) {
    return createWebhook(...args);
  }

  async createWebhookWithSubscription(...args: Parameters<typeof createWebhookWithSubscription>) {
    return createWebhookWithSubscription(...args);
  }

  async reregisterCallSubscriptions(...args: Parameters<typeof reregisterCallSubscriptions>) {
    return reregisterCallSubscriptions(...args);
  }

  async createSmsSubscription(...args: Parameters<typeof createSmsSubscription>) {
    return createSmsSubscription(...args);
  }

  async deleteWebhook(...args: Parameters<typeof deleteWebhook>) {
    return deleteWebhook(...args);
  }

  async deleteSmsSubscription(...args: Parameters<typeof deleteSmsSubscription>) {
    return deleteSmsSubscription(...args);
  }

  async listWebhooks(...args: Parameters<typeof listWebhooks>) {
    return listWebhooks(...args);
  }

  async listCallSubscriptions(...args: Parameters<typeof listCallSubscriptions>) {
    return listCallSubscriptions(...args);
  }

  async listSmsSubscriptions(...args: Parameters<typeof listSmsSubscriptions>) {
    return listSmsSubscriptions(...args);
  }

  async sendText(...args: Parameters<typeof sendText>) {
    return sendText(...args);
  }

  async getCompanyNumbers(...args: Parameters<typeof getCompanyNumbers>) {
    return getCompanyNumbers(...args);
  }

  async getCompanyUsers(...args: Parameters<typeof getCompanyUsers>) {
    return getCompanyUsers(...args);
  }

  async getDepartments(...args: Parameters<typeof getDepartments>) {
    return getDepartments(...args);
  }

  async getAvailablePhoneNumbers(...args: Parameters<typeof getAvailablePhoneNumbers>) {
    return getAvailablePhoneNumbers(...args);
  }

  async getCompanyOffices(...args: Parameters<typeof getCompanyOffices>) {
    return getCompanyOffices(...args);
  }

  async getCallDetails(...args: Parameters<typeof getCallDetails>) {
    return getCallDetails(...args);
  }

  async checkConnection(...args: Parameters<typeof checkConnection>) {
    return checkConnection(...args);
  }

  /**
   * Return true if Dialpad credentials are configured for the given tenant.
   */
  async isConfigured(tenantId?: string): Promise<boolean> {
    try {
      const credentials = tenantId
        ? await credentialService.getCredentialsWithFallback(tenantId, 'dialpad')
        : { api_key: process.env.DIALPAD_API_KEY };
      return !!credentials.api_key;
    } catch {
      return false;
    }
  }

  /**
   * Sync all Dialpad data (users + phone numbers) to the local database cache.
   * This is the legacy full-sync path used by some routes/jobs.
   * Manages a DialpadSyncJob record for observability.
   */
  async syncDialpadDataToCache(tenantId: string): Promise<{ success: boolean; message: string }> {
    try {
      const syncJob = await storage.createDialpadSyncJob({
        contractorId: tenantId,
        syncType: 'full',
        status: 'in_progress',
        startedAt: new Date(),
        recordsProcessed: 0,
        recordsSuccess: 0,
        recordsError: 0,
      });

      let totalProcessed = 0;
      let totalSuccess = 0;
      let totalErrors = 0;

      try {
        const users = await getCompanyUsers(tenantId);
        for (const user of users) {
          try {
            const existingUser = await storage.getDialpadUserByDialpadId(user.id.toString(), tenantId);
            if (existingUser) {
              await storage.updateDialpadUser(existingUser.id, {
                email: user.email,
                firstName: user.first_name,
                lastName: user.last_name,
                fullName: `${user.first_name} ${user.last_name}`.trim(),
                department: typeof user.department === 'string' ? user.department : user.department?.toString() || null,
                phoneNumbers: user.phone_numbers ? user.phone_numbers.map((p: any) => p.number || p.toString()) : [],
                lastSyncAt: new Date(),
                isActive: true,
              });
            } else {
              await storage.createDialpadUser({
                contractorId: tenantId,
                dialpadUserId: user.id.toString(),
                email: user.email,
                firstName: user.first_name,
                lastName: user.last_name,
                fullName: `${user.first_name} ${user.last_name}`.trim(),
                department: typeof user.department === 'string' ? user.department : user.department?.toString() || null,
                phoneNumbers: user.phone_numbers ? user.phone_numbers.map((p: any) => p.number || p.toString()) : [],
                isActive: true,
                lastSyncAt: new Date(),
              });
            }
            totalSuccess++;
          } catch (error) {
            log.error(`Error syncing user ${maskEmail(user.email)}:`, error);
            totalErrors++;
          }
          totalProcessed++;
        }
        log.info(`Synced ${users.length} users for tenant ${tenantId}`);
      } catch (error) {
        log.error('Error fetching users from Dialpad v2 API:', error);
        totalErrors++;
      }

      try {
        const phoneNumbers = await getCompanyNumbers(tenantId);
        for (const number of phoneNumbers) {
          try {
            const existingNumber = await storage.getDialpadPhoneNumberByNumber(tenantId, number.number);
            if (existingNumber) {
              await storage.updateDialpadPhoneNumber(existingNumber.id, {
                displayName: number.display_name || number.number,
                department: typeof number.department === 'string' ? number.department : number.department?.toString() || null,
                canSendSms: number.sms_enabled || false,
                canMakeCalls: true,
                lastSyncAt: new Date(),
                isActive: number.state === 'active',
              });
            } else {
              await storage.createDialpadPhoneNumber({
                contractorId: tenantId,
                phoneNumber: number.number,
                dialpadId: number.id?.toString(),
                displayName: number.display_name || number.number,
                department: typeof number.department === 'string' ? number.department : number.department?.toString() || null,
                canSendSms: number.sms_enabled || false,
                canMakeCalls: true,
                isActive: number.state === 'active',
                lastSyncAt: new Date(),
              });
            }
            totalSuccess++;
          } catch (error) {
            log.error(`Error syncing phone number ${maskPhone(number.number)}:`, error);
            totalErrors++;
          }
          totalProcessed++;
        }
        log.info(`Synced ${phoneNumbers.length} phone numbers for tenant ${tenantId}`);
      } catch (error) {
        log.error('Error fetching phone numbers from Dialpad v2 API:', error);
        totalErrors++;
      }

      await storage.updateDialpadSyncJob(syncJob.id, {
        status: totalErrors > 0 ? 'failed' : 'completed',
        completedAt: new Date(),
        recordsProcessed: totalProcessed,
        recordsSuccess: totalSuccess,
        recordsError: totalErrors,
        lastSuccessfulSyncAt: totalErrors === 0 ? new Date() : undefined,
        errorMessage: totalErrors > 0 ? `${totalErrors} errors occurred during sync` : undefined,
      });

      return {
        success: totalErrors === 0,
        message: `Sync completed: ${totalSuccess} successful, ${totalErrors} errors`,
      };
    } catch (error) {
      log.error('Error during Dialpad sync:', error);
      return {
        success: false,
        message: `Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }
}

export const dialpadEnhancedService = new DialpadEnhancedService();

/**
 * Backward-compatibility aliases so callers that previously imported from
 * `dialpad-enhanced-service.ts` or `dialpad-service.ts` continue to work.
 */
export { DialpadEnhancedService as DialpadService };
export const dialpadService = dialpadEnhancedService;
