import { describe, it, expect, vi, beforeEach } from 'vitest';

const { hcp, state, updateSet } = vi.hoisted(() => {
  return {
    hcp: {
      getCustomer: vi.fn(),
      searchCustomers: vi.fn(),
      createCustomer: vi.fn(),
      createCustomerAddress: vi.fn(),
      updateCustomerAddress: vi.fn(),
      deleteCustomerAddress: vi.fn(),
    },
    state: { contact: null as null | Record<string, unknown> },
    updateSet: vi.fn<(values: Record<string, unknown>) => void>(),
  };
});

vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(state.contact ? [state.contact] : []),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updateSet(values);
        return {
          where: () => Promise.resolve(undefined),
        };
      },
    }),
  },
}));

vi.mock('../hcp/index', () => ({
  housecallProService: hcp,
}));

vi.mock('@shared/schema', () => ({ contacts: {} }));
vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));

import { resolveHcpCustomer } from '../scheduling/hcp-customer';
import type { BookingRequest } from '../types/scheduling';

const TENANT = 'tenant-1';
const ADDRESS = {
  street: '123 Main St',
  city: 'Phoenix',
  state: 'AZ',
  zip: '85001',
  country: 'US',
};

const REQUEST: BookingRequest = {
  customerAddressComponents: ADDRESS,
} as BookingRequest;

beforeEach(() => {
  Object.values(hcp).forEach((fn) => fn.mockReset());
  updateSet.mockReset();
  state.contact = null;
});

describe('resolveHcpCustomer / syncHcpCustomerAddress', () => {
  it('brand-new customer: POSTs createCustomer with address inline', async () => {
    state.contact = {
      id: 'c1',
      name: 'Jane Doe',
      address: null,
      street: null,
      city: null,
      state: null,
      zip: null,
      emails: [],
      phones: [],
      housecallProCustomerId: null,
    };

    hcp.createCustomer.mockResolvedValue({ success: true, data: { id: 'hcp-1' } });
    // After create, sync runs: getCustomer returns customer with the new address already verified.
    hcp.getCustomer.mockResolvedValue({
      success: true,
      data: { addresses: [{ id: 'addr-1', type: 'service', street: ADDRESS.street }] },
    });
    hcp.updateCustomerAddress.mockResolvedValue({ success: true, data: {} });

    const result = await resolveHcpCustomer(TENANT, 'c1', REQUEST);

    expect(result?.customerId).toBe('hcp-1');
    expect(result?.serviceAddressId).toBe('addr-1');
    expect(hcp.searchCustomers).not.toHaveBeenCalled();
    expect(hcp.createCustomer).toHaveBeenCalledTimes(1);
    const [tenantArg, payload] = hcp.createCustomer.mock.calls[0];
    expect(tenantArg).toBe(TENANT);
    expect(payload.first_name).toBe('Jane');
    expect(payload.last_name).toBe('Doe');
    expect(payload.addresses).toEqual([ADDRESS]);
    expect(updateSet).toHaveBeenCalledWith({ housecallProCustomerId: 'hcp-1' });
  });

  it('existing customer with no address record: POSTs new service address', async () => {
    state.contact = {
      id: 'c2',
      name: 'John Smith',
      housecallProCustomerId: 'hcp-2',
      emails: [],
      phones: [],
    };

    hcp.getCustomer.mockResolvedValue({ success: true, data: { addresses: [] } });
    hcp.createCustomerAddress.mockResolvedValue({ success: true, data: { id: 'addr-2' } });

    const result = await resolveHcpCustomer(TENANT, 'c2', REQUEST);

    expect(result?.customerId).toBe('hcp-2');
    expect(result?.serviceAddressId).toBe('addr-2');
    expect(hcp.updateCustomerAddress).not.toHaveBeenCalled();
    expect(hcp.deleteCustomerAddress).not.toHaveBeenCalled();
    expect(hcp.createCustomerAddress).toHaveBeenCalledTimes(1);
    const [tenantArg, custIdArg, payload] = hcp.createCustomerAddress.mock.calls[0];
    expect(tenantArg).toBe(TENANT);
    expect(custIdArg).toBe('hcp-2');
    expect(payload).toEqual({
      street: ADDRESS.street,
      city: ADDRESS.city,
      state: ADDRESS.state,
      zip: ADDRESS.zip,
      country: 'US',
      type: 'service',
    });
  });

  it('existing customer with partial address: per-address PATCH succeeds and verifies', async () => {
    state.contact = {
      id: 'c3',
      name: 'Jane Doe',
      housecallProCustomerId: 'hcp-3',
      emails: [],
      phones: [],
    };

    // First getCustomer: returns existing partial address record (no street).
    // Second getCustomer (verify): returns updated street.
    hcp.getCustomer
      .mockResolvedValueOnce({
        success: true,
        data: { addresses: [{ id: 'addr-3', type: 'service', street: '', city: 'Phoenix' }] },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { addresses: [{ id: 'addr-3', type: 'service', street: ADDRESS.street }] },
      });
    hcp.updateCustomerAddress.mockResolvedValue({ success: true, data: {} });

    await resolveHcpCustomer(TENANT, 'c3', REQUEST);

    expect(hcp.updateCustomerAddress).toHaveBeenCalledTimes(1);
    const [tenantArg, custIdArg, addressIdArg, payload] = hcp.updateCustomerAddress.mock.calls[0];
    expect(tenantArg).toBe(TENANT);
    expect(custIdArg).toBe('hcp-3');
    expect(addressIdArg).toBe('addr-3');
    expect(payload).toEqual({
      street: ADDRESS.street,
      city: ADDRESS.city,
      state: ADDRESS.state,
      zip: ADDRESS.zip,
      country: 'US',
      type: 'service',
    });
    expect(hcp.deleteCustomerAddress).not.toHaveBeenCalled();
    expect(hcp.createCustomerAddress).not.toHaveBeenCalled();
    expect(hcp.getCustomer).toHaveBeenCalledTimes(2);
  });

  it('per-address PATCH succeeds but street does not persist: deletes + recreates', async () => {
    state.contact = {
      id: 'c4',
      name: 'Jane Doe',
      housecallProCustomerId: 'hcp-4',
      emails: [],
      phones: [],
    };

    hcp.getCustomer
      .mockResolvedValueOnce({
        success: true,
        data: { addresses: [{ id: 'addr-4', type: 'service', street: 'old st' }] },
      })
      // Verify: street did NOT update.
      .mockResolvedValueOnce({
        success: true,
        data: { addresses: [{ id: 'addr-4', type: 'service', street: 'old st' }] },
      });
    hcp.updateCustomerAddress.mockResolvedValue({ success: true, data: {} });
    hcp.deleteCustomerAddress.mockResolvedValue({ success: true, data: {} });
    hcp.createCustomerAddress.mockResolvedValue({ success: true, data: { id: 'addr-4-new' } });

    await resolveHcpCustomer(TENANT, 'c4', REQUEST);

    expect(hcp.updateCustomerAddress).toHaveBeenCalledTimes(1);
    expect(hcp.deleteCustomerAddress).toHaveBeenCalledWith(TENANT, 'hcp-4', 'addr-4');
    expect(hcp.createCustomerAddress).toHaveBeenCalledTimes(1);
    expect(hcp.createCustomerAddress).toHaveBeenCalledWith(TENANT, 'hcp-4', {
      street: ADDRESS.street,
      city: ADDRESS.city,
      state: ADDRESS.state,
      zip: ADDRESS.zip,
      country: 'US',
      type: 'service',
    });
  });

  it('per-address PATCH fails: deletes + recreates without verifying', async () => {
    state.contact = {
      id: 'c5',
      name: 'Jane Doe',
      housecallProCustomerId: 'hcp-5',
      emails: [],
      phones: [],
    };

    hcp.getCustomer.mockResolvedValueOnce({
      success: true,
      data: { addresses: [{ id: 'addr-5', type: 'service', street: 'old st' }] },
    });
    hcp.updateCustomerAddress.mockResolvedValue({ success: false, error: 'boom' });
    hcp.deleteCustomerAddress.mockResolvedValue({ success: true, data: {} });
    hcp.createCustomerAddress.mockResolvedValue({ success: true, data: { id: 'addr-5-new' } });

    await resolveHcpCustomer(TENANT, 'c5', REQUEST);

    expect(hcp.updateCustomerAddress).toHaveBeenCalledTimes(1);
    expect(hcp.deleteCustomerAddress).toHaveBeenCalledWith(TENANT, 'hcp-5', 'addr-5');
    expect(hcp.createCustomerAddress).toHaveBeenCalledTimes(1);
    // Verify path should NOT have run a second getCustomer
    expect(hcp.getCustomer).toHaveBeenCalledTimes(1);
    expect(hcp.createCustomerAddress).toHaveBeenCalledWith(TENANT, 'hcp-5', {
      street: ADDRESS.street,
      city: ADDRESS.city,
      state: ADDRESS.state,
      zip: ADDRESS.zip,
      country: 'US',
      type: 'service',
    });
  });
});
