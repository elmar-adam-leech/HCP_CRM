import { logger } from '../utils/logger';
import { HcpBaseClient } from './base-client';
import type { HousecallProEmployee, HousecallProResponse } from './types';

const log = logger('HcpService');

export class HcpEmployeesModule extends HcpBaseClient {
  async getEmployees(tenantId: string): Promise<HousecallProResponse<HousecallProEmployee[]>> {
    const allEmployees: HousecallProEmployee[] = [];
    let page = 1;
    const pageSize = 100;
    let totalPages = 1;
    
    log.info('[HCP] Fetching all employees with pagination...');
    
    while (page <= totalPages) {
      const response = await this.makeRequest<any>(`/employees?page=${page}&page_size=${pageSize}`, tenantId);
      
      if (!response.success || !response.data) {
        if (page === 1) {
          return response;
        }
        break;
      }
      
      const responseData = response.data;
      if (responseData.total_pages) {
        totalPages = responseData.total_pages;
      }
      if (responseData.total_items) {
        log.info(`[HCP] Total employees in HCP: ${responseData.total_items}`);
      }
      
      const employees = Array.isArray(responseData) ? responseData :
                       Array.isArray(responseData.employees) ? responseData.employees :
                       Array.isArray(responseData.data) ? responseData.data :
                       [];
      
      log.info(`[HCP] Page ${page}/${totalPages}: fetched ${employees.length} employees`);
      allEmployees.push(...employees);
      
      page++;
      
      if (page > 50) {
        log.warn('[HCP] Reached page limit (50 pages), stopping pagination');
        break;
      }
    }
    
    log.info(`[HCP] Total employees fetched: ${allEmployees.length}`);
    return {
      success: true,
      data: allEmployees,
    };
  }

  filterEstimators(employees: HousecallProEmployee[], estimatorIds?: string[]): HousecallProEmployee[] {
    return employees.filter(emp => {
      const isEstimator = emp.role.toLowerCase().includes('estimator') || emp.role.toLowerCase().includes('sales');
      const isSpecific = !estimatorIds || estimatorIds.includes(emp.id);
      return emp.is_active && isEstimator && isSpecific;
    });
  }
}
