import { HcpBaseClient } from './base-client';
import type { HousecallProResponse } from './types';

export type HousecallProServiceItem = {
  id: string;
  name?: string;
  description?: string;
  unit_price?: number;
  unit_cost?: number;
  taxable?: boolean;
  kind?: string;
  sku?: string;
  category?: string;
  updated_at?: string;
  created_at?: string;
  [key: string]: unknown;
};

export class HcpServiceItemsModule extends HcpBaseClient {
  async getServiceItem(
    serviceItemId: string,
    tenantId: string,
  ): Promise<HousecallProResponse<HousecallProServiceItem>> {
    const response = await this.makeRequest<any>(
      `/price_book/service_items/${encodeURIComponent(serviceItemId)}`,
      tenantId,
    );

    if (response.success && response.data) {
      const item = response.data.data || response.data;
      return { success: true, data: item };
    }

    return response;
  }
}
