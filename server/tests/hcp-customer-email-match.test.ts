import { describe, it, expect, vi, beforeEach } from 'vitest';

const getContactByExternalId = vi.fn();
const getContactByPhone = vi.fn();
const findMatchingContact = vi.fn();
const getContact = vi.fn();
const updateContact = vi.fn();
const createContact = vi.fn();
const isHcpCustomerExcluded = vi.fn();
const broadcastToContractor = vi.fn();
const triggerWorkflowsForEvent = vi.fn().mockResolvedValue(undefined);

vi.mock('../storage', () => ({
  storage: {
    getContactByExternalId: (...args: any[]) => getContactByExternalId(...args),
    getContactByPhone: (...args: any[]) => getContactByPhone(...args),
    findMatchingContact: (...args: any[]) => findMatchingContact(...args),
    getContact: (...args: any[]) => getContact(...args),
    updateContact: (...args: any[]) => updateContact(...args),
    createContact: (...args: any[]) => createContact(...args),
    isHcpCustomerExcluded: (...args: any[]) => isHcpCustomerExcluded(...args),
  },
}));
vi.mock('../websocket', () => ({ broadcastToContractor: (cid: string, msg: unknown) => broadcastToContractor(cid, msg) }));
vi.mock('../workflow-engine', () => ({
  workflowEngine: { triggerWorkflowsForEvent: (e: string, ev: unknown, c: string) => triggerWorkflowsForEvent(e, ev, c) },
}));
vi.mock('../utils/workflow/entity-adapter', () => ({ toWorkflowEvent: (e: unknown) => e }));
vi.mock('../utils/logger', () => ({ logger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) }));
vi.mock('../utils/hcp-echo-suppression', () => ({
  isHcpCustomerEchoPending: () => false,
  clearHcpCustomerEcho: vi.fn(),
}));

import { handleCustomerEvent } from '../routes/webhooks/housecall-pro/handlers/customers';

const CONTRACTOR = 'tenant-1';

beforeEach(() => {
  vi.clearAllMocks();
  isHcpCustomerExcluded.mockResolvedValue(false);
  getContactByExternalId.mockResolvedValue(undefined);
  updateContact.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch }));
});

describe('customer.created email fallback (task #798)', () => {
  it('links an existing email-only lead instead of creating a customer/active contact', async () => {
    // No HCP customer-id match, no phone on the payload → phone match returns nothing.
    getContactByPhone.mockResolvedValue(undefined);
    // Email fallback resolves to an existing lead.
    findMatchingContact.mockResolvedValue('existing-lead-1');
    getContact.mockResolvedValue({ id: 'existing-lead-1', type: 'lead', status: 'new', source: null });

    await handleCustomerEvent(
      CONTRACTOR,
      'customer.created',
      { id: 'cust_email', first_name: 'Emaily', last_name: 'Ellen', email: 'ellen@example.com' },
      undefined,
    );

    expect(findMatchingContact).toHaveBeenCalledWith(CONTRACTOR, ['ellen@example.com'], undefined);
    // Existing lead linked — NOT re-created as a customer/active.
    expect(createContact).not.toHaveBeenCalled();
    expect(updateContact).toHaveBeenCalledTimes(1);
    const [linkedId, patch] = updateContact.mock.calls[0];
    expect(linkedId).toBe('existing-lead-1');
    expect(patch.housecallProCustomerId).toBe('cust_email');
    expect(patch.externalId).toBe('cust_email');
    expect(patch.externalSource).toBe('housecall-pro');
  });

  it('creates a new contact when neither phone nor email match an existing contact', async () => {
    getContactByPhone.mockResolvedValue(undefined);
    findMatchingContact.mockResolvedValue(undefined);
    createContact.mockResolvedValue({ id: 'new-contact-1' });

    await handleCustomerEvent(
      CONTRACTOR,
      'customer.created',
      { id: 'cust_nomatch', first_name: 'Nomatch', last_name: 'Nancy', email: 'nancy@example.com' },
      undefined,
    );

    expect(findMatchingContact).toHaveBeenCalledWith(CONTRACTOR, ['nancy@example.com'], undefined);
    expect(updateContact).not.toHaveBeenCalled();
    expect(createContact).toHaveBeenCalledTimes(1);
  });

  it('prefers a phone match and never consults the email fallback when phone resolves', async () => {
    getContactByPhone.mockResolvedValue({ id: 'phone-lead-1', type: 'lead', status: 'new', source: null });

    await handleCustomerEvent(
      CONTRACTOR,
      'customer.created',
      { id: 'cust_phone', first_name: 'Phone', last_name: 'Phil', email: 'phil@example.com', mobile_number: '5551234567' },
      undefined,
    );

    expect(findMatchingContact).not.toHaveBeenCalled();
    expect(createContact).not.toHaveBeenCalled();
    expect(updateContact).toHaveBeenCalledTimes(1);
    expect(updateContact.mock.calls[0][0]).toBe('phone-lead-1');
  });
});
