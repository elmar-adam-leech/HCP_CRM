/**
 * Twilio module — sync IncomingPhoneNumbers from the Twilio account into the
 * local twilio_phone_numbers table, mapping voice/SMS capabilities.
 */

import { getTwilioCredentials, twilioGet } from './client';
import { storage } from '../storage';
import { normalizePhoneNumber } from '../utils/phone-normalizer';
import { logger } from '../utils/logger';

const log = logger('TwilioNumbers');

interface TwilioIncomingNumber {
  sid: string;
  phone_number: string;
  friendly_name?: string;
  capabilities?: { voice?: boolean; sms?: boolean; mms?: boolean };
}

/**
 * Pull all IncomingPhoneNumbers from the contractor's Twilio account and
 * upsert them locally. Numbers no longer present in Twilio are marked inactive.
 * Returns the number of records synced.
 */
export async function syncTwilioNumbers(contractorId: string): Promise<{ synced: number }> {
  const creds = await getTwilioCredentials(contractorId);

  const response = await twilioGet(creds, '/IncomingPhoneNumbers.json?PageSize=200');
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to list Twilio numbers: ${response.status} ${text}`);
  }
  const data = await response.json();
  const remote: TwilioIncomingNumber[] = Array.isArray(data.incoming_phone_numbers)
    ? data.incoming_phone_numbers
    : [];

  const existing = await storage.getTwilioPhoneNumbers(contractorId);
  const existingByNumber = new Map(
    existing.map((row) => [normalizePhoneNumber(row.phoneNumber) || row.phoneNumber, row]),
  );

  const seen = new Set<string>();
  let synced = 0;

  for (const num of remote) {
    const e164 = normalizePhoneNumber(num.phone_number) || num.phone_number;
    seen.add(e164);
    const caps = num.capabilities || {};
    const fields = {
      contractorId,
      phoneNumber: e164,
      twilioSid: num.sid,
      displayName: num.friendly_name || null,
      canSendSms: !!caps.sms,
      canReceiveSms: !!caps.sms,
      canMakeCalls: !!caps.voice,
      canReceiveCalls: !!caps.voice,
      isActive: true,
      lastSyncAt: new Date(),
    };

    const match = existingByNumber.get(e164);
    if (match) {
      await storage.updateTwilioPhoneNumber(match.id, fields as any);
    } else {
      await storage.createTwilioPhoneNumber(fields as any);
    }
    synced++;
  }

  // Deactivate numbers that are gone from Twilio.
  for (const row of existing) {
    const e164 = normalizePhoneNumber(row.phoneNumber) || row.phoneNumber;
    if (!seen.has(e164) && row.isActive) {
      await storage.updateTwilioPhoneNumber(row.id, { isActive: false } as any);
    }
  }

  log.info(`Synced ${synced} Twilio numbers for contractor ${contractorId}`);
  return { synced };
}
