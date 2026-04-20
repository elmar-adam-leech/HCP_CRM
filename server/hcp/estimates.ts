import { HcpBaseClient, extractHcpList } from './base-client';
import type { HousecallProEstimate, HousecallProResponse } from './types';

/** HCP estimates endpoints return plain JSON (not JSON:API). */
const ESTIMATES_ACCEPT = 'application/json';

export class HcpEstimatesModule extends HcpBaseClient {
  async getEstimates(tenantId: string, params?: {
    modified_since?: string;
    scheduled_start_min?: string;
    scheduled_start_max?: string;
    customer_id?: string;
    work_status?: string;
    page_size?: number;
    page?: number;
    sort_by?: string;
    sort_direction?: string;
  }): Promise<HousecallProResponse<HousecallProEstimate[]>> {
    const queryParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          queryParams.append(key, value.toString());
        }
      });
    }
    
    const endpoint = `/estimates${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
    const response = await this.makeRequest<unknown>(endpoint, tenantId, 'GET', undefined, 3, ESTIMATES_ACCEPT);
    
    if (response.success && response.data) {
      const estimates = extractHcpList<HousecallProEstimate>(response.data, 'estimates');
      return { success: true, data: estimates };
    }
    
    return response as HousecallProResponse<HousecallProEstimate[]>;
  }

  async createEstimate(tenantId: string, estimateData: {
    customer_id: string;
    employee_id?: string;
    message?: string;
    options: Array<{
      name: string;
      message?: string;
      total_amount?: string;
      schedule?: {
        scheduled_start?: string;
        scheduled_end?: string;
        arrival_window?: number;
        dispatched_employees?: Array<{ employee_id: string }>;
      };
      line_items?: Array<{
        name: string;
        description?: string;
        quantity: number;
        unit_cost: number;
      }>;
    }>;
    address?: {
      street: string;
      street_line_2?: string;
      city: string;
      state: string;
      zip: string;
      country?: string;
    };
  }): Promise<HousecallProResponse<HousecallProEstimate>> {
    return this.makeRequest<HousecallProEstimate>('/estimates', tenantId, 'POST', estimateData, 3, ESTIMATES_ACCEPT);
  }

  async updateEstimate(
    tenantId: string,
    estimateId: string,
    estimateData: Partial<HousecallProEstimate>
  ): Promise<HousecallProResponse<HousecallProEstimate>> {
    return this.makeRequest<HousecallProEstimate>(`/estimates/${estimateId}`, tenantId, 'PUT', estimateData, 3, ESTIMATES_ACCEPT);
  }

  async updateEstimateOptionSchedule(
    tenantId: string,
    estimateId: string,
    optionId: string,
    scheduleData: {
      start_time: string;
      end_time?: string;
      arrival_window_in_minutes?: number;
      notify?: boolean;
      notify_pro?: boolean;
      dispatched_employees?: Array<{ employee_id: string }>;
    }
  ): Promise<HousecallProResponse<unknown>> {
    return this.makeRequest<unknown>(
      `/estimates/${estimateId}/options/${optionId}/schedule`,
      tenantId,
      'PUT',
      scheduleData,
      3,
      ESTIMATES_ACCEPT
    );
  }

  async getEstimate(tenantId: string, estimateId: string): Promise<HousecallProResponse<HousecallProEstimate>> {
    return this.makeRequest<HousecallProEstimate>(`/estimates/${estimateId}`, tenantId, 'GET', undefined, 3, ESTIMATES_ACCEPT);
  }

  async addEstimateNote(
    tenantId: string,
    estimateId: string,
    content: string
  ): Promise<HousecallProResponse<unknown>> {
    return this.makeRequest<unknown>(
      `/estimates/${estimateId}/notes`,
      tenantId,
      'POST',
      { content },
      3,
      ESTIMATES_ACCEPT
    );
  }
}
