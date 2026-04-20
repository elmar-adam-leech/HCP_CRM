import { HcpBaseClient } from './base-client';
import type { HousecallProCustomer, HousecallProResponse } from './types';

export class HcpCustomersModule extends HcpBaseClient {
  async getCustomers(tenantId: string): Promise<HousecallProResponse<HousecallProCustomer[]>> {
    return this.makeRequest<HousecallProCustomer[]>('/customers', tenantId);
  }

  async searchCustomers(tenantId: string, searchParams: {
    email?: string;
    phone?: string;
  }): Promise<HousecallProResponse<HousecallProCustomer[]>> {
    return this.makeRequest<HousecallProCustomer[]>('/customers/search', tenantId, 'POST', searchParams);
  }

  async createCustomer(tenantId: string, customerData: {
    first_name?: string;
    last_name?: string;
    company?: string;
    email?: string;
    mobile_number?: string;
    home_number?: string;
    work_number?: string;
    lead_source?: string;
    notes?: string;
    notifications_enabled?: boolean;
    tags?: string[];
    addresses?: Array<{
      street?: string;
      street_line_2?: string;
      city?: string;
      state?: string;
      zip?: string;
      country?: string;
      type?: 'service' | 'billing' | 'mailing';
    }>;
  }): Promise<HousecallProResponse<{ id: string; first_name?: string; last_name?: string; email?: string }>> {
    return this.makeRequest('/customers', tenantId, 'POST', customerData);
  }

  async getCustomer(tenantId: string, customerId: string): Promise<HousecallProResponse<HousecallProCustomer>> {
    return this.makeRequest<HousecallProCustomer>(`/customers/${customerId}`, tenantId);
  }

  async updateCustomer(tenantId: string, customerId: string, customerData: {
    first_name?: string;
    last_name?: string;
    company?: string;
    email?: string;
    mobile_number?: string;
    notes?: string;
    addresses?: Array<{
      id?: string;
      street?: string;
      city?: string;
      state?: string;
      zip?: string;
      type?: 'service' | 'billing' | 'mailing';
    }>;
  }): Promise<HousecallProResponse<any>> {
    return this.makeRequest(`/customers/${customerId}`, tenantId, 'PATCH', customerData);
  }

  async createCustomerAddress(tenantId: string, customerId: string, addressData: {
    street: string;
    city: string;
    state: string;
    zip: string;
    country?: string;
    type?: 'service' | 'billing' | 'mailing';
  }): Promise<HousecallProResponse<any>> {
    return this.makeRequest(
      `/customers/${customerId}/addresses`,
      tenantId,
      'POST',
      addressData
    );
  }

  /**
   * Updates an existing address record on an HCP customer using the dedicated
   * per-address endpoint. Unlike PATCH /customers/:id with an embedded
   * `addresses` array (which silently no-ops on the street field for existing
   * records), this endpoint reliably updates the address in place.
   */
  async updateCustomerAddress(tenantId: string, customerId: string, addressId: string, addressData: {
    street?: string;
    street_line_2?: string;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
    type?: 'service' | 'billing' | 'mailing';
  }): Promise<HousecallProResponse<any>> {
    return this.makeRequest(
      `/customers/${customerId}/addresses/${addressId}`,
      tenantId,
      'PATCH',
      addressData
    );
  }

  async deleteCustomerAddress(tenantId: string, customerId: string, addressId: string): Promise<HousecallProResponse<any>> {
    return this.makeRequest(
      `/customers/${customerId}/addresses/${addressId}`,
      tenantId,
      'DELETE'
    );
  }
}
