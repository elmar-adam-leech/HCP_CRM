import { housecallProService } from '../hcp/index';
import { storage } from '../storage';
import type { HcpEmployee } from './hcp-types';
import { logger } from '../utils/logger';

const log = logger('HcpEmployeesSync');

export async function syncHousecallProEmployees(tenantId: string): Promise<void> {
  log.info(`Syncing employees from Housecall Pro for tenant ${tenantId}`);

  try {
    const employeesResult = await housecallProService.getEmployees(tenantId);
    if (!employeesResult.success) {
      log.error(`Failed to fetch employees: ${employeesResult.error}`);
      return;
    }

    const housecallProEmployees = employeesResult.data || [];
    log.info(`Fetched ${housecallProEmployees.length} employees from Housecall Pro`);

    if (housecallProEmployees.length === 0) {
      return;
    }

    const employeeData = (housecallProEmployees as HcpEmployee[]).map((hcpEmployee) => ({
      externalSource: 'housecall-pro' as const,
      externalId: hcpEmployee.id,
      firstName: hcpEmployee.first_name || '',
      lastName: hcpEmployee.last_name || '',
      email: hcpEmployee.email,
      isActive: hcpEmployee.is_active,
      externalRole: hcpEmployee.role,
      roles: [] as string[],
    }));

    const upsertedEmployees = await storage.upsertEmployees(employeeData, tenantId);
    log.info(`Upserted ${upsertedEmployees.length} employees`);
  } catch (error) {
    log.error('Error syncing employees', error);
  }
}
