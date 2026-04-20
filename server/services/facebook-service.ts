import crypto from 'crypto';
import axios from 'axios';
import { CredentialService } from '../credential-service';
import { logger } from '../utils/logger';
import type { Contact } from '@shared/schema';
import type { Lead } from '@shared/schema';

const log = logger('FacebookService');

const FB_API_VERSION = 'v25.0';
const CRM_NAME = 'HCP CRM';

const STATUS_TO_EVENT_NAME: Record<string, string> = {
  new: 'Lead',
  contacted: 'Contact',
  scheduled: 'Schedule',
  active: 'Schedule',
  converted: 'CompleteRegistration',
  disqualified: 'Other',
  inactive: 'Other',
};

export function hashValue(value: string): string {
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

async function sendConversionEvent(
  contractorId: string,
  _lead: Lead,
  contact: Contact,
  eventName: string
): Promise<void> {
  try {
    const [datasetId, accessToken] = await Promise.all([
      CredentialService.getCredential(contractorId, 'facebook-conversions', 'dataset_id'),
      CredentialService.getCredential(contractorId, 'facebook-conversions', 'capi_access_token'),
    ]);

    if (!datasetId || !accessToken) {
      return;
    }

    const userData: Record<string, any> = {};

    const primaryEmail = contact.emails?.[0];
    if (primaryEmail) {
      userData.em = [hashValue(primaryEmail)];
    }

    const primaryPhone = contact.phones?.[0];
    if (primaryPhone) {
      const digitsOnly = primaryPhone.replace(/\D/g, '');
      userData.ph = [hashValue(digitsOnly)];
    }

    if (contact.name) {
      const parts = contact.name.trim().split(/\s+/);
      if (parts[0]) userData.fn = [hashValue(parts[0])];
      if (parts.length > 1) userData.ln = [hashValue(parts[parts.length - 1])];
    }

    const payload = {
      data: [
        {
          action_source: 'system_generated',
          event_name: eventName,
          event_time: Math.floor(Date.now() / 1000),
          custom_data: {
            event_source: 'crm',
            lead_event_source: CRM_NAME,
          },
          user_data: userData,
        },
      ],
    };

    await axios.post(
      `https://graph.facebook.com/${FB_API_VERSION}/${datasetId}/events`,
      payload,
      {
        params: { access_token: accessToken },
        timeout: 10000,
      }
    );

    log.debug(`Sent conversion event "${eventName}" for contractor ${contractorId}`);
  } catch (error) {
    log.error('Failed to send Facebook conversion event:', error instanceof Error ? error.message : error);
  }
}

async function sendConversionForStatus(
  contractorId: string,
  lead: Lead,
  contact: Contact,
  status: string
): Promise<void> {
  const eventName = STATUS_TO_EVENT_NAME[status];
  if (!eventName || eventName === 'Other') return;
  await sendConversionEvent(contractorId, lead, contact, eventName);
}

export const facebookService = {
  sendConversionEvent,
  sendConversionForStatus,
  hashValue,
  FB_API_VERSION,
};
