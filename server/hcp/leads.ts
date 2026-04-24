import { logger } from '../utils/logger';
import { HcpBaseClient, extractHcpList } from './base-client';
import type { HousecallProEstimate, HousecallProResponse } from './types';

const log = logger('HcpService');

export class HcpLeadsModule extends HcpBaseClient {
  async createLead(tenantId: string, leadData: {
    customer_id: string;
    job_type_id?: string;
    note?: string;
    address_id?: string;
    lead_source?: string;
  }): Promise<HousecallProResponse<{ id: string; customer_id: string; created_at?: string }>> {
    return this.makeRequest('/leads', tenantId, 'POST', leadData);
  }

  async getLeadSources(tenantId: string): Promise<HousecallProResponse<string[]>> {
    const allNames: string[] = [];
    let page = 1;
    const pageSize = 100;
    let totalPages = 1;

    log.info('[HCP] Fetching all lead sources with pagination...');

    while (page <= totalPages) {
      const result = await this.makeRequest<any>(
        `/lead_sources?page=${page}&page_size=${pageSize}`,
        tenantId,
        'GET',
        undefined,
        3,
        'application/json'
      );

      if (!result.success || !result.data) {
        if (page === 1) {
          return { success: false, error: result.error };
        }
        break;
      }

      const responseData = result.data;
      if (responseData.total_pages) {
        totalPages = responseData.total_pages;
      }

      const items = extractHcpList<{ name?: string; id?: string }>(responseData, 'lead_sources');
      const names = items.map(item => item.name).filter((n): n is string => typeof n === 'string' && n.length > 0);
      log.info(`[HCP] Lead sources page ${page}/${totalPages}: fetched ${names.length} items`);
      allNames.push(...names);

      page++;

      if (page > 50) {
        log.warn('[HCP] Reached page limit (50 pages), stopping lead source pagination');
        break;
      }
    }

    log.info(`[HCP] Total lead sources fetched: ${allNames.length}`);
    return { success: true, data: allNames };
  }

  async getLead(tenantId: string, leadId: string): Promise<HousecallProResponse<any>> {
    return this.makeRequest(`/leads/${leadId}`, tenantId);
  }

  /**
   * Attaches a free-form note to an existing HCP lead. HCP carries lead notes
   * forward into the converted estimate's notes feed, which is the most reliable
   * way to ensure booker-typed notes land on the resulting estimate (the
   * post-convert `POST /estimates/{id}/notes` race is documented in
   * server/scheduling/hcp-estimate.ts).
   *
   * Mirrors the shape of `addEstimateNote` (POST /estimates/{id}/notes).
   */
  async addLeadNote(
    tenantId: string,
    leadId: string,
    content: string,
  ): Promise<HousecallProResponse<unknown>> {
    return this.makeRequest<unknown>(
      `/leads/${leadId}/notes`,
      tenantId,
      'POST',
      { content },
    );
  }

  async convertLead(tenantId: string, leadId: string, options: {
    employee_id?: string;
  } = {}): Promise<HousecallProResponse<HousecallProEstimate>> {
    log.info(`[HCP] Converting lead ${leadId} to estimate`);
    return this.makeRequest<HousecallProEstimate>(
      `/leads/${leadId}/convert`,
      tenantId,
      'POST',
      { type: 'estimate', ...options },
      3,
      'application/json'
    );
  }
}
