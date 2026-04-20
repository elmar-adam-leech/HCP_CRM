/**
 * Dialpad module — phone permission checking and available number resolution.
 *
 * Permission model:
 *   - Admins and managers have implicit access to all phone numbers.
 *   - Regular users require an explicit UserPhoneNumberPermission row.
 */

import { storage } from '../storage';
import { logger } from '../utils/logger';
import type { DialpadPhoneNumber } from '@shared/schema';

const log = logger('DialpadPermissions');

/**
 * Check if a user has permission to use a specific phone number for the given action.
 */
export async function checkUserPhonePermission(
  userId: string,
  phoneNumberId: string,
  action: 'sms' | 'call'
): Promise<{ hasPermission: boolean; reason?: string }> {
  try {
    const user = await storage.getUser(userId);

    if (!user) {
      return { hasPermission: false, reason: 'User not found' };
    }

    if (user.role === 'admin' || user.role === 'manager') {
      return { hasPermission: true };
    }

    const permission = await storage.getUserPhoneNumberPermission(userId, phoneNumberId);

    if (!permission || !permission.isActive) {
      return {
        hasPermission: false,
        reason: 'No permission assigned for this phone number',
      };
    }

    if (action === 'sms' && !permission.canSendSms) {
      return {
        hasPermission: false,
        reason: 'SMS permission not granted for this phone number',
      };
    }

    if (action === 'call' && !permission.canMakeCalls) {
      return {
        hasPermission: false,
        reason: 'Call permission not granted for this phone number',
      };
    }

    return { hasPermission: true };
  } catch (err) {
    return { hasPermission: false, reason: 'Error checking permissions' };
  }
}

/**
 * Get available phone numbers for a user based on their permissions and the number's own capabilities.
 *
 * All org members can use any capable company number; the filter is on the number's
 * own SMS/call capability flag, not on per-user permission rows.
 *
 * Falls back to the org's configured default number if no SMS-capable numbers
 * are found (common when Dialpad API doesn't return capability flags for
 * department/shared numbers).
 */
export async function getUserAvailablePhoneNumbers(
  userId: string,
  contractorId: string,
  action: 'sms' | 'call'
): Promise<DialpadPhoneNumber[]> {
  try {
    log.info(`getUserAvailablePhoneNumbers called with userId: ${userId}, contractorId: ${contractorId}, action: ${action}`);

    const allPhoneNumbers = await storage.getDialpadPhoneNumbers(contractorId);
    log.info(`Found ${allPhoneNumbers.length} total phone numbers for contractor`);

    const capable =
      action === 'sms'
        ? allPhoneNumbers.filter(n => n.canSendSms)
        : allPhoneNumbers.filter(n => n.canMakeCalls);

    log.info(
      `User ${userId} sees ${capable.length}/${allPhoneNumbers.length} phone numbers for action=${action} (filtered by number capability)`
    );

    if (capable.length === 0 && action === 'sms') {
      const contractor = await storage.getContractor(contractorId);
      const orgDefault = contractor?.defaultDialpadNumber;
      if (orgDefault) {
        const existing = allPhoneNumbers.find(n => n.phoneNumber === orgDefault);
        if (existing) {
          log.info(`[sms-fallback] No SMS-capable numbers found; surfacing org default ${orgDefault} from synced list`);
          return [{ ...existing, canSendSms: true }];
        }
        log.info(`[sms-fallback] No SMS-capable numbers found; injecting org default ${orgDefault} as synthetic entry`);
        return [
          {
            id: 'org-default',
            contractorId,
            phoneNumber: orgDefault,
            displayName: orgDefault,
            dialpadId: null,
            department: null,
            canSendSms: true,
            canReceiveSms: true,
            canMakeCalls: false,
            canReceiveCalls: false,
            isActive: true,
            lastSyncAt: new Date(),
          } as DialpadPhoneNumber,
        ];
      }
    }

    return capable;
  } catch (err) {
    log.error('Error getting user available phone numbers:', err);
    return [];
  }
}
