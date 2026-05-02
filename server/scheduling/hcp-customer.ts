import { db } from '../db';
import { contacts } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { housecallProService } from '../hcp/index';
import type { BookingRequest, AddressComponents } from '../types/scheduling';
import { parseAddressString, hasRealStreetAddress } from '../types/scheduling';
import { logger } from '../utils/logger';
import { normalizePhoneForHcp } from '../utils/phone-normalizer';

const log = logger('HcpSchedulingService');

/**
 * Loose normalizer used to detect material disagreement between a structured
 * `street` component and the address string the user typed. We only need
 * "does the street appear inside the string somewhere", not strict equality —
 * users frequently expand "St" → "Street", lowercase tokens, etc., and any of
 * those should still count as agreement.
 */
function normalizeStreetForCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolves the address to send to HCP for a booking.
 * Priority: structured components from request → plain string from request →
 * contact's structured fields → contact's formatted address string.
 *
 * Conflict guard: if BOTH `customerAddressComponents` AND a non-empty
 * `customerAddress` are present, but the components' street does not appear
 * anywhere in the typed string, the typed string wins. This protects against
 * non-conforming external callers (or stale clients that forget to clear
 * components on manual edit) from pinning a downstream HCP record to a stale
 * autocomplete pick instead of what the user actually typed.
 */
export function resolveAddressComponents(
  request: BookingRequest,
  contactAddress?: string | null,
  contact?: { street?: string | null; city?: string | null; state?: string | null; zip?: string | null } | null
): AddressComponents | undefined {
  if (request.customerAddressComponents?.street) {
    const componentsStreet = request.customerAddressComponents.street;
    const typed = request.customerAddress?.trim();
    if (typed && typed.length > 0) {
      const normTyped = normalizeStreetForCompare(typed);
      const normComponents = normalizeStreetForCompare(componentsStreet);
      if (normComponents && !normTyped.includes(normComponents)) {
        // Material disagreement — the user's typed string does not contain
        // the structured component's street. Prefer the typed string and
        // fall through to the string-parse branches below.
        log.warn(
          `[scheduling] resolveAddressComponents: components.street="${componentsStreet}" not present in typed customerAddress="${typed}"; preferring typed string parse`,
        );
      } else {
        return {
          street: componentsStreet,
          city: request.customerAddressComponents.city || '',
          state: request.customerAddressComponents.state || '',
          zip: request.customerAddressComponents.zip || '',
          country: request.customerAddressComponents.country || 'US',
        };
      }
    } else {
      return {
        street: componentsStreet,
        city: request.customerAddressComponents.city || '',
        state: request.customerAddressComponents.state || '',
        zip: request.customerAddressComponents.zip || '',
        country: request.customerAddressComponents.country || 'US',
      };
    }
  }
  if (request.customerAddress && hasRealStreetAddress(request.customerAddress)) {
    const parsed = parseAddressString(request.customerAddress);
    if (parsed.street && parsed.city) return parsed;
  }
  // Defense-in-depth: when the request supplies an address string that the
  // strict `hasRealStreetAddress` check rejects (e.g. "123 New St, Salem NH"
  // with no zip, or a single-line typed address with no comma), prefer that
  // best-effort parse over the contact's stored fields. The user just typed
  // it in this booking — we should never silently substitute the prior
  // contact address for what they submitted. The downstream HCP request will
  // carry the user's intent even when individual components can't all be
  // extracted.
  if (request.customerAddress && request.customerAddress.trim().length > 0) {
    const parsed = parseAddressString(request.customerAddress);
    if (parsed.street) return parsed;
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

/**
 * The result of synchronizing the HCP customer's service address.
 * `recreated=true` indicates the existing address record was deleted and a new
 * one POSTed (so any HCP estimate previously pinned via `address_id` is now
 * dangling and must be re-pinned).
 */
export interface SyncedHcpAddress {
  id: string;
  recreated: boolean;
}

async function postNewServiceAddress(
  tenantId: string,
  customerId: string,
  addressData: { street: string; city: string; state: string; zip: string; country?: string }
): Promise<string | undefined> {
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
    return undefined;
  }
  const newId = (postResult.data as { id?: string } | undefined)?.id;
  if (!newId) {
    log.warn(`[scheduling] POST address for HCP customer ${customerId} succeeded but response did not include an id; refetching to recover`);
    const refetch = await housecallProService.getCustomer(tenantId, customerId);
    if (refetch.success) {
      const refList: HcpAddressRecord[] = refetch.data?.addresses ?? [];
      const match = refList.find((a) => (a?.street || '').trim() === addressData.street.trim() && a?.type === 'service')
        || refList.find((a) => (a?.street || '').trim() === addressData.street.trim());
      if (match?.id) return match.id;
    }
    return undefined;
  }
  return newId;
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
export async function syncHcpCustomerAddress(
  tenantId: string,
  customerId: string,
  addressData: { street: string; city: string; state: string; zip: string; country?: string }
): Promise<SyncedHcpAddress | undefined> {
  const customerResult = await housecallProService.getCustomer(tenantId, customerId);

  if (!customerResult.success) {
    log.warn(`[scheduling] Could not fetch HCP customer ${customerId} to check address status (${customerResult.error}); skipping address sync`);
    return undefined;
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
    const id = await postNewServiceAddress(tenantId, customerId, addressData);
    // No existing record meant nothing was previously pinned to this customer
    // either, so callers don't need to repin downstream estimate references.
    return id ? { id, recreated: false } : undefined;
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
    await deleteAndVerifyAddress(tenantId, customerId, existingAddressId);
    const id = await postNewServiceAddress(tenantId, customerId, addressData);
    return id ? { id, recreated: true } : undefined;
  }

  // Verify the street actually persisted. HCP has been observed to return 2xx
  // on per-address PATCH but leave the record unchanged for some legacy
  // address rows. In that case, delete + recreate is the only reliable fix.
  const verifyResult = await housecallProService.getCustomer(tenantId, customerId);
  if (!verifyResult.success) {
    log.warn(`[scheduling] Could not re-fetch HCP customer ${customerId} after per-address PATCH to verify street persistence: ${verifyResult.error}`);
    return { id: existingAddressId, recreated: false };
  }
  const verifiedList: HcpAddressRecord[] = verifyResult.data?.addresses ?? [];
  const verifiedRecord = verifiedList.find((a) => a?.id === existingAddressId);
  const persistedStreet = (verifiedRecord?.street || '').trim();
  const expectedStreet = addressData.street.trim();
  if (persistedStreet === expectedStreet) {
    log.info(`[scheduling] Verified HCP address ${existingAddressId} street persisted as "${persistedStreet}" for customer ${customerId}`);
    return { id: existingAddressId, recreated: false };
  }

  log.warn(`[scheduling] HCP per-address PATCH returned success but street did not persist for customer ${customerId} address ${existingAddressId} (expected "${expectedStreet}", got "${persistedStreet}"). Deleting stale record and POSTing a fresh one.`);
  await deleteAndVerifyAddress(tenantId, customerId, existingAddressId);
  const id = await postNewServiceAddress(tenantId, customerId, addressData);
  return id ? { id, recreated: true } : undefined;
}

/**
 * Deletes an HCP customer address record, then re-fetches the customer to
 * verify the row is actually gone. HCP occasionally returns 2xx on DELETE but
 * leaves the row in place; when that happens we log loudly so the caller can
 * decide whether to take additional recovery steps (e.g. PATCH the HCP lead's
 * `address_id` so the next convertLead doesn't re-bind to the legacy row).
 */
async function deleteAndVerifyAddress(
  tenantId: string,
  customerId: string,
  addressId: string,
): Promise<void> {
  const deleteResult = await housecallProService.deleteCustomerAddress(tenantId, customerId, addressId);
  if (!deleteResult.success) {
    log.warn(`[scheduling] Could not delete stale HCP address ${addressId} on customer ${customerId}: ${deleteResult.error}`);
    return;
  }
  const verify = await housecallProService.getCustomer(tenantId, customerId);
  if (!verify.success) {
    log.warn(`[scheduling] Could not verify deletion of HCP address ${addressId} on customer ${customerId}: ${verify.error}`);
    return;
  }
  const remaining: HcpAddressRecord[] = verify.data?.addresses ?? [];
  if (remaining.some((a) => a?.id === addressId)) {
    log.warn(`[scheduling] HCP returned success on DELETE of address ${addressId} on customer ${customerId} but the row is still present after re-fetch. The convert-from-lead path may re-bind to this stale row; rely on the lead address_id PATCH before convertLead to recover.`);
  }
}

/**
 * Finds or creates an HCP customer record for the given local contact.
 * Updates the local contact row with the HCP customer ID on success.
 * Returns the HCP customer ID, or undefined if it could not be resolved.
 */
export interface ResolvedHcpCustomer {
  customerId: string;
  serviceAddressId?: string;
  /**
   * True when `syncHcpCustomerAddress` had to delete-and-recreate the
   * underlying address record (per-address PATCH silently no-op'd or failed).
   * Downstream estimate writes must repin to the new `serviceAddressId` even
   * if everything else looks unchanged, otherwise the estimate's `address_id`
   * still points at the now-deleted row.
   */
  serviceAddressRecreated?: boolean;
}

export async function resolveHcpCustomer(
  tenantId: string,
  contactId: string,
  request: BookingRequest
): Promise<ResolvedHcpCustomer | undefined> {
  const [contact] = await db.select()
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (!contact) return undefined;

  const addressData = resolveAddressComponents(request, contact.address, contact);

  if (contact.housecallProCustomerId) {
    let synced: SyncedHcpAddress | undefined;
    if (addressData?.street) {
      synced = await syncHcpCustomerAddress(tenantId, contact.housecallProCustomerId, addressData);
    }
    return {
      customerId: contact.housecallProCustomerId,
      serviceAddressId: synced?.id,
      serviceAddressRecreated: synced?.recreated ?? false,
    };
  }

  const primaryEmail = contact.emails?.[0];
  const primaryPhone = contact.phones?.[0];
  // HCP requires `mobile_number` to be exactly 10 digits with no formatting.
  const hcpPhone = normalizePhoneForHcp(primaryPhone);

  if (primaryEmail || primaryPhone) {
    log.info('[scheduling] Searching for existing HCP customer for contact:', contact.id);
    const searchResult = await housecallProService.searchCustomers(tenantId, {
      email: primaryEmail,
      phone: hcpPhone,
    });
    if (searchResult.success && searchResult.data && searchResult.data.length > 0) {
      const hcpCustomerId = searchResult.data[0].id;
      log.info('[scheduling] Found existing HCP customer:', hcpCustomerId);
      await db.update(contacts)
        .set({ housecallProCustomerId: hcpCustomerId })
        .where(eq(contacts.id, contact.id));
      let synced: SyncedHcpAddress | undefined;
      if (addressData?.street) {
        synced = await syncHcpCustomerAddress(tenantId, hcpCustomerId, addressData);
      }
      return {
        customerId: hcpCustomerId,
        serviceAddressId: synced?.id,
        serviceAddressRecreated: synced?.recreated ?? false,
      };
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
    mobile_number: hcpPhone,
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
    let synced: SyncedHcpAddress | undefined;
    if (addressData?.street) {
      synced = await syncHcpCustomerAddress(tenantId, hcpCustomerId, addressData);
    }
    return {
      customerId: hcpCustomerId,
      serviceAddressId: synced?.id,
      serviceAddressRecreated: synced?.recreated ?? false,
    };
  }

  log.warn(`Failed to create HCP customer: ${customerResult.error}`);
  return undefined;
}
