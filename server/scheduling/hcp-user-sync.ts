import { db } from '../db';
import { users, userContractors } from '@shared/schema';
import { eq, and, sql } from 'drizzle-orm';
import { housecallProService } from '../hcp/index';
import { logger } from '../utils/logger';
import { maskEmail } from '../utils/pii-redactor';

const log = logger('HcpSchedulingService');

/**
 * Housecall Pro employee object shape as returned by the HCP API.
 *
 * The HCP API is not strictly typed in our codebase (no SDK). This interface
 * captures the fields we actually use. Any additional fields returned by HCP
 * are simply ignored. If the HCP API changes field names, update this interface
 * and the usages below — the TypeScript compiler will highlight every call-site.
 *
 * Fields marked optional reflect uncertainty about whether HCP always returns them
 * (the API docs are inconsistent). Runtime guards (|| null) are used at each access.
 */
export interface HCPEmployee {
  id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  /** `true` if the employee is active. HCP returns this field inconsistently — some
   *  responses use `is_active`, others `active`. Both are checked at usage sites. */
  is_active?: boolean;
  active?: boolean;
  /** Working day schedule data — format varies by HCP account configuration. */
  working_days?: number[];
  work_days?: number[];
  schedule?: {
    working_days?: number[];
    start_time?: string;
    end_time?: string;
  };
  working_hours_start?: string;
  working_hours_end?: string;
  work_start_time?: string;
  work_end_time?: string;
  /** Average rating for the employee, used in salesperson scoring. */
  average_rating?: number;
  /** Total number of jobs completed, used in salesperson scoring. */
  total_jobs?: number;
}

export async function syncHousecallUsers(
  tenantId: string
): Promise<{ synced: number; created: number; updated: number; errors: string[]; hcpUsersFound: number }> {
  const result = { synced: 0, created: 0, updated: 0, errors: [] as string[], hcpUsersFound: 0 };

  try {
    log.info(`[scheduling-sync] Fetching HCP employees for tenant: ${tenantId}`);
    const hcpUsersResponse = await housecallProService.getEmployees(tenantId);

    if (!hcpUsersResponse.success || !hcpUsersResponse.data) {
      log.info(`[scheduling-sync] Failed to fetch HCP users: ${hcpUsersResponse.error}`);
      result.errors.push('Failed to fetch Housecall Pro users: ' + (hcpUsersResponse.error || 'Unknown error'));
      return result;
    }

    const hcpUsers = hcpUsersResponse.data as HCPEmployee[];
    result.hcpUsersFound = hcpUsers.length;
    log.info(`[scheduling-sync] Found ${hcpUsers.length} HCP users: ${hcpUsers.map((u) => maskEmail(u.email)).join(', ')}`);

    for (const hcpUser of hcpUsers) {
      log.info(`[scheduling-sync] Processing HCP user: ${maskEmail(hcpUser.email)} is_active: ${hcpUser.is_active} active: ${hcpUser.active}`);

      // Skip users without email. Only skip if is_active is explicitly false (not undefined)
      const isActive = hcpUser.is_active !== false && hcpUser.active !== false;
      if (!hcpUser.email) {
        log.info('[scheduling-sync] Skipping emailless user:', hcpUser.first_name);
        continue;
      }
      if (!isActive) {
        log.info('[scheduling-sync] Skipping inactive user:', maskEmail(hcpUser.email));
        continue;
      }

      try {
        const email = hcpUser.email.toLowerCase().trim();
        const userName = `${hcpUser.first_name || ''} ${hcpUser.last_name || ''}`.trim() || email.split('@')[0];

        // Try to find existing user by email for THIS contractor only (tenant-scoped query)
        // This prevents cross-tenant data access by only looking at users already associated with this contractor
        const contractorUsers = await db.select({ user: users })
          .from(users)
          .innerJoin(userContractors, eq(users.id, userContractors.userId))
          .where(and(
            eq(userContractors.contractorId, tenantId),
            sql`LOWER(${users.email}) = ${email}`
          ))
          .limit(1);
        const existingUser = contractorUsers[0]?.user;

        let userId: string;

        if (existingUser) {
          // Update existing user
          userId = existingUser.id;
          log.info(`[scheduling-sync] Found existing user: ${maskEmail(email)} - updating`);

          // Build update data - always set contractorId if it's null
          const updateData: any = {
            name: userName || existingUser.name,
          };

          // Set contractorId if not already set
          if (!existingUser.contractorId) {
            updateData.contractorId = tenantId;
          }

          await db.update(users)
            .set(updateData)
            .where(eq(users.id, userId));

          result.updated++;
        } else {
          // Create new user for this HCP employee
          log.info('[scheduling-sync] Creating new user for HCP employee:', maskEmail(email));

          // Generate a username from email
          const username = email.split('@')[0].replace(/[^a-z0-9]/gi, '_').toLowerCase();

          // Create the user with a cryptographically secure random password (they can reset later)
          const bcrypt = await import('bcrypt');
          const { randomBytes } = await import('node:crypto');
          const randomPassword = randomBytes(16).toString('hex');
          const hashedPassword = await bcrypt.hash(randomPassword, 10);

          const [newUser] = await db.insert(users).values({
            username: username,
            email: email,
            name: userName,
            password: hashedPassword,
            role: 'user',
            contractorId: tenantId, // Associate user with the contractor that synced them
          }).returning();

          userId = newUser.id;
          result.created++;
          log.info(`[scheduling-sync] Created new user: ${maskEmail(email)} with ID: ${userId}`);
        }

        // Now handle user_contractors relationship
        const existingUC = await db.select()
          .from(userContractors)
          .where(and(
            eq(userContractors.userId, userId),
            eq(userContractors.contractorId, tenantId)
          ))
          .limit(1);

        // Extract working hours from HCP employee if available.
        // HCP provides schedule data in multiple possible field locations depending
        // on the account configuration and API version — the HCPEmployee interface
        // documents all known variants. Fall back to null if none are present.
        const nonEmptyArray = (arr: unknown): number[] | null =>
          Array.isArray(arr) && arr.length > 0 ? arr : null;
        const hcpWorkingDays = nonEmptyArray(hcpUser.working_days) ?? nonEmptyArray(hcpUser.work_days) ??
          nonEmptyArray(hcpUser.schedule?.working_days);
        const hcpWorkingHoursStart = hcpUser.working_hours_start ||
          hcpUser.schedule?.start_time || hcpUser.work_start_time || null;
        const hcpWorkingHoursEnd = hcpUser.working_hours_end ||
          hcpUser.schedule?.end_time || hcpUser.work_end_time || null;

        // Default working hours if not provided by HCP (Mon-Fri, 8AM-5PM)
        const defaultWorkingDays = [1, 2, 3, 4, 5]; // Monday to Friday
        const defaultWorkingHoursStart = "08:00";
        const defaultWorkingHoursEnd = "17:00";

        if (existingUC.length > 0) {
          // Only update HCP linkage and working hours (if not custom) - preserve isSalesperson setting
          const updateData: any = {
            housecallProUserId: hcpUser.id,
            // Do NOT overwrite isSalesperson - preserve existing setting
          };

          // Respect hasCustomSchedule flag - don't overwrite custom settings
          if (!existingUC[0].hasCustomSchedule) {
            updateData.workingDays = hcpWorkingDays ?? (Array.isArray(existingUC[0].workingDays) && existingUC[0].workingDays.length > 0 ? existingUC[0].workingDays : null) ?? defaultWorkingDays;
            updateData.workingHoursStart = hcpWorkingHoursStart || existingUC[0].workingHoursStart || defaultWorkingHoursStart;
            updateData.workingHoursEnd = hcpWorkingHoursEnd || existingUC[0].workingHoursEnd || defaultWorkingHoursEnd;
          }

          await db.update(userContractors)
            .set(updateData)
            .where(eq(userContractors.id, existingUC[0].id));
        } else {
          await db.insert(userContractors).values({
            userId: userId,
            contractorId: tenantId,
            housecallProUserId: hcpUser.id,
            isSalesperson: true,
            role: 'user',
            workingDays: hcpWorkingDays ?? defaultWorkingDays,
            workingHoursStart: hcpWorkingHoursStart || defaultWorkingHoursStart,
            workingHoursEnd: hcpWorkingHoursEnd || defaultWorkingHoursEnd,
            hasCustomSchedule: false,
          });
        }

        result.synced++;
      } catch (userError: any) {
        log.error(`[scheduling-sync] Error syncing user: ${maskEmail(hcpUser.email)}`, userError);
        result.errors.push(`Error syncing user ${maskEmail(hcpUser.email)}: ${userError.message}`);
      }
    }

    log.info('[scheduling-sync] Sync complete:', result);
    return result;
  } catch (error: any) {
    log.error('[scheduling-sync] Sync failed:', error);
    result.errors.push(`Sync failed: ${error.message}`);
    return result;
  }
}
