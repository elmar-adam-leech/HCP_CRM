import { db } from '../db';
import { contacts } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { housecallProService } from '../hcp/index';
import type { BookingRequest, AddressComponents } from '../types/scheduling';
import { parseAddressString, hasRealStreetAddress } from '../types/scheduling';
import { logger } from '../utils/logger';

const log = logger('HcpSchedulingService');

/**
 * Resolves the address to send to HCP for a booking.
 * Priority: structured components from request → plain string from request →
 * contact's structured fields → contact's formatted address string.
 */
export function resolveAddressComponents(
  request: BookingRequest,
  contactAddress?: string | null,
  contact?: { street?: string | null; city?: string | null; state?: string | null; zip?: string | null } | null
): AddressComponents | undefined {
  if (request.customerAddressComponents?.street) {
    return {
      street: request.customerAddressComponents.street,
      city: request.customerAddressComponents.city || '',
      state: request.customerAddressComponents.state || '',
      zip: request.customerAddressComponents.zip || '',
      country: request.customerAddressComponents.country || 'US',
    };
  }
  if (request.customerAddress && hasRealStreetAddress(request.customerAddress)) {
    const parsed = parseAddressString(request.customerAddress);
    if (parsed.street && parsed.city) return parsed;
  }
  if (contact?.street) {
    return {
      street: contact.street,
      city: contact.city || '',
      state: contact.state || '',
      zip: contact.zip || '',
      country: 'US',
    };
  }
  if (contactAddress && hasRealStreetAddress(contactAddress)) {
    return parseAddressString(contactAddress);
  }
  if (request.customerAddress) {
    return parseAddressString(request.customerAddress);
  }
  if (contactAddress) {
    return parseAddressString(contactAddress);
  }
  return undefined;
}

type HcpAddressRecord = {
  id?: string;
  street?: string;
  street_line_2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  type?: string;
};

async function postNewServiceAddress(
  tenantId: string,
  customerId: string,
  addressData: { street: string; city: string; state: string; zip: string; country?: string }
): Promise<boolean> {
  log.info(`[scheduling] POSTing new service address for HCP customer ${customerId}: street="${addressData.street}", city="${addressData.city}", state="${addressData.state}", zip="${addressData.zip}"`);
  const postResult = await housecallProService.createCustomerAddress(tenantId, customerId, {
    street: addressData.street,
    city: addressData.city,
    state: addressData.state,
    zip: addressData.zip,
    country: addressData.country || 'US',
    type: 'service',
  }).catch((err) => {
    log.warn(`[scheduling] POST address threw for HCP customer ${customerId}: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false as const, error: err instanceof Error ? err.message : String(err) };
  });
  if (!postResult.success) {
    log.warn(`[scheduling] POST address failed for HCP customer ${customerId}: ${postResult.error}`);
    return false;
  }
  return true;
}

/**
 * Ensures a service address exists on the given HCP customer.
 *
 * Routing:
 * - Existing address record: uses the dedicated per-address endpoint
 *   (PATCH /customers/:id/addresses/:address_id). HCP's customer-level PATCH
 *   with an embedded `addresses` array silently no-ops on the street field
 *   for existing records, which is the bug this routine works around.
 * - No address record: POSTs a new one via /customers/:id/addresses.
 *
 * After a per-address PATCH we re-fetch the customer to verify the street
 * actually persisted; if HCP accepted the request but did not update the
 * record (a known quirk on some legacy address records), we delete the
 * existing record and POST a fresh one so the customer ends up with a correct
 * service address either way.
 *
 * All failures are non-fatal and logged with the customer id, address id,
 * the payload we sent, and the HCP error body so regressions stay debuggable.
 */
async function syncHcpCustomerAddress(
  tenantId: string,
  customerId: string,
  addressData: { street: string; city: string; state: string; zip: string; country?: string }
): Promise<void> {
  const customerResult = await housecallProService.getCustomer(tenantId, customerId);

  if (!customerResult.success) {
    log.warn(`[scheduling] Could not fetch HCP customer ${customerId} to check address status (${customerResult.error}); skipping address sync`);
    return;
  }

  const hcpCustomer = customerResult.data;
  // Prefer an existing service-typed address record if one exists, so we don't
  // accidentally mutate a billing/mailing record into a service one. Fall back
  // to the first address record (legacy customers may not have type set).
  const addressList: HcpAddressRecord[] = hcpCustomer?.addresses ?? [];
  const serviceAddress = addressList.find((a) => a?.type === 'service');
  const existingAddress: HcpAddressRecord | undefined =
    serviceAddress || addressList[0] || (hcpCustomer as { address?: HcpAddressRecord })?.address;
  const existingAddressId = existingAddress?.id;

  if (!existingAddressId) {
    log.info(`[scheduling] HCP customer ${customerId} has no address record on file; creating one`);
    await postNewServiceAddress(tenantId, customerId, addressData);
    return;
  }

  const addressPayload = {
    street: addressData.street,
    city: addressData.city,
    state: addressData.state,
    zip: addressData.zip,
    country: addressData.country || 'US',
    type: 'service' as const,
  };

  log.info(`[scheduling] PATCHing existing HCP address record ${existingAddressId} on customer ${customerId} via per-address endpoint with: ${JSON.stringify(addressPayload)}`);
  const patchResult = await housecallProService.updateCustomerAddress(
    tenantId,
    customerId,
    existingAddressId,
    addressPayload,
  );

  if (!patchResult.success) {
    log.warn(`[scheduling] Per-address PATCH failed for HCP customer ${customerId} address ${existingAddressId}: ${patchResult.error}. Falling back to delete + recreate.`);
    const deleteResult = await housecallProService.deleteCustomerAddress(tenantId, customerId, existingAddressId);
    if (!deleteResult.success) {
      log.warn(`[scheduling] Could not delete stale HCP address ${existingAddressId} on customer ${customerId}: ${deleteResult.error}; attempting POST anyway`);
    }
    await postNewServiceAddress(tenantId, customerId, addressData);
    return;
  }

  // Verify the street actually persisted. HCP has been observed to return 2xx
  // on per-address PATCH but leave the record unchanged for some legacy
  // address rows. In that case, delete + recreate is the only reliable fix.
  const verifyResult = await housecallProService.getCustomer(tenantId, customerId);
  if (!verifyResult.success) {
    log.warn(`[scheduling] Could not re-fetch HCP customer ${customerId} after per-address PATCH to verify street persistence: ${verifyResult.error}`);
    return;
  }
  const verifiedList: HcpAddressRecord[] = verifyResult.data?.addresses ?? [];
  const verifiedRecord = verifiedList.find((a) => a?.id === existingAddressId);
  const persistedStreet = (verifiedRecord?.street || '').trim();
  const expectedStreet = addressData.street.trim();
  if (persistedStreet === expectedStreet) {
    log.info(`[scheduling] Verified HCP address ${existingAddressId} street persisted as "${persistedStreet}" for customer ${customerId}`);
    return;
  }

  log.warn(`[scheduling] HCP per-address PATCH returned success but street did not persist for customer ${customerId} address ${existingAddressId} (expected "${expectedStreet}", got "${persistedStreet}"). Deleting stale record and POSTing a fresh one.`);
  const deleteResult = await housecallProService.deleteCustomerAddress(tenantId, customerId, existingAddressId);
  if (!deleteResult.success) {
    log.warn(`[scheduling] Could not delete stale HCP address ${existingAddressId} on customer ${customerId} during recovery: ${deleteResult.error}; POSTing new address anyway (may result in duplicate)`);
  }
  await postNewServiceAddress(tenantId, customerId, addressData);
}

/**
 * Finds or creates an HCP customer record for the given local contact.
 * Updates the local contact row with the HCP customer ID on success.
 * Returns the HCP customer ID, or undefined if it could not be resolved.
 */
export async function resolveHcpCustomer(
  tenantId: string,
  contactId: string,
  request: BookingRequest
): Promise<string | undefined> {
  const [contact] = await db.select()
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (!contact) return undefined;

  const addressData = resolveAddressComponents(request, contact.address, contact);

  if (contact.housecallProCustomerId) {
    if (addressData?.street) {
      await syncHcpCustomerAddress(tenantId, contact.housecallProCustomerId, addressData);
    }
    return contact.housecallProCustomerId;
  }

  const primaryEmail = contact.emails?.[0];
  const primaryPhone = contact.phones?.[0];

  if (primaryEmail || primaryPhone) {
    log.info('[scheduling] Searching for existing HCP customer for contact:', contact.id);
    const searchResult = await housecallProService.searchCustomers(tenantId, {
      email: primaryEmail,
      phone: primaryPhone,
    });
    if (searchResult.success && searchResult.data && searchResult.data.length > 0) {
      const hcpCustomerId = searchResult.data[0].id;
      log.info('[scheduling] Found existing HCP customer:', hcpCustomerId);
      await db.update(contacts)
        .set({ housecallProCustomerId: hcpCustomerId })
        .where(eq(contacts.id, contact.id));
      if (addressData?.street) {
        await syncHcpCustomerAddress(tenantId, hcpCustomerId, addressData);
      }
      return hcpCustomerId;
    }
  }

  log.info('[scheduling] Creating new HCP customer for contact:', contact.id);
  const nameParts = (contact.name || '').trim().split(' ');
  const firstName = nameParts[0] || 'Customer';
  const lastName = nameParts.slice(1).join(' ') || '';

  const customerResult = await housecallProService.createCustomer(tenantId, {
    first_name: firstName,
    last_name: lastName,
    email: primaryEmail,
    mobile_number: primaryPhone,
    addresses: addressData ? [addressData] : undefined,
  });

  if (customerResult.success && customerResult.data?.id) {
    const hcpCustomerId = customerResult.data.id;
    log.info('[scheduling] Created HCP customer:', hcpCustomerId);
    await db.update(contacts)
      .set({ housecallProCustomerId: hcpCustomerId })
      .where(eq(contacts.id, contact.id));
    // The create call accepts an `addresses` array inline, but HCP does not
    // always echo a usable address record back in the create response — and
    // even when it does, it can omit the street. Run the same sync routine
    // here so all three resolution paths converge on the same verified state.
    if (addressData?.street) {
      await syncHcpCustomerAddress(tenantId, hcpCustomerId, addressData);
    }
    return hcpCustomerId;
  }

  log.warn(`Failed to create HCP customer: ${customerResult.error}`);
  return undefined;
}
