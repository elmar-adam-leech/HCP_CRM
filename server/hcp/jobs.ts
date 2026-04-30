import { HcpBaseClient } from './base-client';
import type { HousecallProJob, HousecallProResponse } from './types';

export class HcpJobsModule extends HcpBaseClient {
  async getJobs(tenantId: string, params?: {
    modified_since?: string;
    sort_by?: string;
    sort_direction?: string;
    page_size?: number;
    page?: number;
    include?: string;
  }): Promise<HousecallProResponse<HousecallProJob[]>> {
    const queryParams = new URLSearchParams();
    
    if (params?.modified_since) {
      queryParams.append('modified_since', params.modified_since);
    }
    if (params?.sort_by) {
      queryParams.append('sort_by', params.sort_by);
    }
    if (params?.sort_direction) {
      queryParams.append('sort_direction', params.sort_direction);
    }
    if (params?.page_size) {
      queryParams.append('page_size', params.page_size.toString());
    }
    if (params?.page) {
      queryParams.append('page', params.page.toString());
    }
    if (params?.include) {
      queryParams.append('include', params.include);
    }

    const endpoint = `/jobs${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
    const response = await this.makeRequest<any>(endpoint, tenantId);
    
    if (response.success && response.data) {
      const jobs = Array.isArray(response.data.data) ? response.data.data : 
                  Array.isArray(response.data.jobs) ? response.data.jobs :
                  Array.isArray(response.data) ? response.data : [];
      return {
        success: true,
        data: jobs,
      };
    }
    
    return response;
  }

  async getJob(jobId: string, tenantId: string): Promise<HousecallProResponse<HousecallProJob>> {
    const response = await this.makeRequest<any>(`/jobs/${jobId}`, tenantId);

    if (response.success && response.data) {
      const job = response.data.data || response.data;
      return { success: true, data: job };
    }

    return response;
  }
}
