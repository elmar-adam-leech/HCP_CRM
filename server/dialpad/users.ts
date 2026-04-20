/**
 * Dialpad module — user and department fetch and sync.
 *
 * Retry policy:
 *   - withRetry is applied to read operations (getCompanyUsers, getDepartments).
 *   - Sync upsert DB writes do NOT use withRetry.
 */

import { getCredentials, dialpadFetch } from './client';
import { extractErrorMessage } from './utils';
import { storage } from '../storage';
import { withRetry } from '../utils/retry';
import { logger } from '../utils/logger';
import { maskEmail } from '../utils/pii-redactor';
import type {
  DialpadUser,
  DialpadDepartment,
  DialpadApiResponse,
  LegacyDialpadUser,
  LegacyDialpadDepartment,
  LegacyDialpadApiResponse,
} from './types';

const log = logger('DialpadUsers');

/**
 * Fetch all active users from Dialpad.
 * withRetry is applied — this is a read-only operation.
 */
export async function fetchDialpadUsers(contractorId: string): Promise<DialpadUser[]> {
  const { apiKey, baseUrl } = await getCredentials(contractorId);

  const response = await withRetry(
    () => dialpadFetch(`${baseUrl}/users?state=active&limit=100`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }),
    'Dialpad fetchDialpadUsers'
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch Dialpad users: ${response.status}`);
  }

  const data: DialpadApiResponse<DialpadUser> = await response.json();
  return data.items || [];
}

/**
 * Fetch departments for an office.
 * withRetry is applied — this is a read-only operation.
 */
export async function fetchDialpadDepartments(
  contractorId: string,
  officeId: string
): Promise<DialpadDepartment[]> {
  const { apiKey, baseUrl } = await getCredentials(contractorId);

  const response = await withRetry(
    () => dialpadFetch(`${baseUrl}/offices/${officeId}/departments`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }),
    'Dialpad fetchDialpadDepartments'
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch Dialpad departments: ${response.status}`);
  }

  const data: DialpadApiResponse<DialpadDepartment> = await response.json();
  return data.items || [];
}

/**
 * Sync users from Dialpad to local database.
 */
export async function syncUsers(contractorId: string): Promise<{
  fetched: number;
  synced: number;
  users: unknown[];
  errors: string[];
}> {
  const errors: string[] = [];
  let synced = 0;

  const dialpadUsers = await fetchDialpadUsers(contractorId);
  const users: unknown[] = [];
  const totalFetched = dialpadUsers.length;

  for (const dialpadUser of dialpadUsers) {
    try {
      const userData = {
        contractorId,
        dialpadUserId: dialpadUser.id,
        email: dialpadUser.emails?.[0] || '',
        firstName: dialpadUser.display_name.split(' ')[0] || '',
        lastName: dialpadUser.display_name.split(' ').slice(1).join(' ') || '',
        displayName: dialpadUser.display_name,
        department: dialpadUser.department || null,
        role: dialpadUser.role || null,
        extension: dialpadUser.extension || null,
        isActive: dialpadUser.state === 'active',
        lastSyncAt: new Date(),
      };

      const existing = await storage.getDialpadUserByDialpadId(dialpadUser.id, contractorId);
      let user;

      if (existing) {
        user = await storage.updateDialpadUser(existing.id, {
          ...userData,
          lastSyncAt: new Date(),
        });
      } else {
        user = await storage.createDialpadUser(userData);
      }

      users.push(user);
      synced++;
    } catch (err) {
      errors.push(`Failed to sync user ${dialpadUser.display_name}: ${extractErrorMessage(err)}`);
    }
  }

  return { fetched: totalFetched, synced, users, errors };
}

/**
 * Sync departments from Dialpad to local database.
 * Uses getDepartments (withRetry) for the fetch leg.
 */
export async function syncDepartments(contractorId: string): Promise<{
  fetched: number;
  synced: number;
  departments: unknown[];
  errors: string[];
}> {
  const errors: string[] = [];
  let synced = 0;

  const dialpadDepartments = await getDepartments(contractorId);
  const departments: unknown[] = [];
  const totalFetched = dialpadDepartments.length;

  for (const dialpadDepartment of dialpadDepartments) {
    try {
      const departmentData = {
        contractorId,
        dialpadDepartmentId: dialpadDepartment.id.toString(),
        name: dialpadDepartment.name,
        description: '',
        isActive: true,
        lastSyncAt: new Date(),
      };

      const existing = await storage.getDialpadDepartmentByDialpadId(
        dialpadDepartment.id.toString(),
        contractorId
      );
      let department;

      if (existing) {
        department = await storage.updateDialpadDepartment(existing.id, {
          ...departmentData,
          lastSyncAt: new Date(),
        });
      } else {
        department = await storage.createDialpadDepartment(departmentData);
      }

      departments.push(department);
      synced++;
    } catch (err) {
      errors.push(`Failed to sync department ${dialpadDepartment.name}: ${extractErrorMessage(err)}`);
    }
  }

  return { fetched: totalFetched, synced, departments, errors };
}

/**
 * Get users from Dialpad API v2 using withRetry for resilience.
 * Returns the legacy LegacyDialpadUser shape used by cache-sync paths.
 */
export async function getCompanyUsers(tenantId: string): Promise<LegacyDialpadUser[]> {
  try {
    const { apiKey, baseUrl } = await getCredentials(tenantId);

    const response = await withRetry(
      () => dialpadFetch(`${baseUrl}/users?state=active&limit=100`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }),
      'Dialpad getCompanyUsers'
    );

    if (response.ok) {
      const result = await response.json();
      const users = result.items || result.data || result;
      if (Array.isArray(users)) {
        log.info(`Dialpad v2/users API Success: retrieved ${users.length} users`);

        return users.map((user: any) => {
          log.info(`Processing user ${maskEmail(user.email)}: department=${user.department}, dept_name=${user.dept_name}`);
          return {
            id: user.id,
            email: user.email,
            first_name: user.first_name,
            last_name: user.last_name,
            display_name: user.display_name || `${user.first_name} ${user.last_name}`.trim(),
            state: user.state || 'active',
            department: user.department || user.dept_name || null,
            phone_numbers: user.phone_numbers || [],
          };
        });
      }
    } else {
      log.error(`Dialpad v2/users API Error: ${response.status} ${await response.text()}`);
    }

    return [];
  } catch (error) {
    log.error('Error fetching Dialpad v2 users:', error);
    return [];
  }
}

/**
 * Get departments from Dialpad API using withRetry for resilience.
 */
export async function getDepartments(tenantId: string): Promise<LegacyDialpadDepartment[]> {
  try {
    const { apiKey, baseUrl } = await getCredentials(tenantId);

    const response = await withRetry(
      () => dialpadFetch(`${baseUrl}/departments`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }),
      'Dialpad getDepartments'
    );

    if (!response.ok) {
      log.error(`Dialpad Get Departments API Error: ${response.status} ${await response.text()}`);
      return [];
    }

    const result: LegacyDialpadApiResponse<LegacyDialpadDepartment> = await response.json();
    return result.items || [];
  } catch (error) {
    log.error('Error fetching Dialpad departments:', error);
    return [];
  }
}

export interface DialpadOffice {
  id: number;
  office_id?: number;
  name: string;
  state?: string;
  is_primary_office?: boolean;
  phone_numbers?: string[];
}

export async function getCompanyOffices(tenantId: string): Promise<DialpadOffice[]> {
  try {
    const { apiKey, baseUrl } = await getCredentials(tenantId);
    const allOffices: DialpadOffice[] = [];
    let cursor: string | null = null;

    do {
      const url = cursor
        ? `${baseUrl}/offices?active_only=true&cursor=${encodeURIComponent(cursor)}`
        : `${baseUrl}/offices?active_only=true`;

      const response = await withRetry(
        () => dialpadFetch(url, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }),
        'Dialpad getCompanyOffices'
      );

      if (!response.ok) {
        log.error(`Dialpad Get Offices API Error: ${response.status} ${await response.text()}`);
        break;
      }

      const result = await response.json();
      const items = result.items || (Array.isArray(result) ? result : []);
      allOffices.push(...items);
      cursor = result.cursor || null;
    } while (cursor);

    log.info(`Fetched ${allOffices.length} offices from Dialpad`);
    return allOffices;
  } catch (error) {
    log.error('Error fetching Dialpad offices:', error);
    return [];
  }
}
