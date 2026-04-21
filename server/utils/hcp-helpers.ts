import { CredentialService } from '../credential-service';
import { logger } from './logger';

const log = logger('HcpHelpers');

const HCP_LEAD_SOURCE_MAP: Record<string, string> = {
  facebook: 'Facebook',
  facebook_lead_ad: 'Facebook',
  facebook_history: 'Facebook',

  google: 'Google',
  google_local_services: 'Google Local Services',
  website: 'Website',
  public_booking: 'Website',

  email_capture: 'Email',
  email: 'Email',

  referral: 'Referral',
  repeat_customer: 'Repeat Customer',

  yelp: 'Yelp',
  nextdoor: 'Nextdoor',
  angi: 'Angi',
  homeadvisor: 'HomeAdvisor',
  thumbtack: 'Thumbtack',

  webhook: 'Webhook',
  manual: 'Manual',
};

/**
 * Maps a raw app source string to a default HCP label.
 * Returns `undefined` (instead of "Other") when there is no mapping,
 * so callers can fall back to the contractor's configured default.
 */
export function mapToHcpLeadSource(source: string | null | undefined): string | undefined {
  if (!source) return undefined;
  const normalized = source.toLowerCase().replace(/[-\s]+/g, '_');
  return HCP_LEAD_SOURCE_MAP[normalized];
}

/**
 * Maps raw variant source keys to the canonical UI source keys used
 * in the lead_source_mapping credential object. The UI exposes six keys:
 * facebook | google | website | email | referral | webhook
 *
 * Any raw source that is a known variant of one of those six is collapsed
 * to the canonical key so that the contractor's per-source override applies.
 */
const SOURCE_VARIANT_TO_CANONICAL: Record<string, string> = {
  facebook_lead_ad: 'facebook',
  facebook_history: 'facebook',
  google_local_services: 'google',
  public_booking: 'website',
  email_capture: 'email',
  repeat_customer: 'referral',
  manual: 'webhook',
};

/**
 * Normalizes a raw app source string to the canonical key used in the
 * lead_source_mapping credential object.  Known variant aliases are collapsed
 * to their canonical key so per-source overrides work for all ingestion paths.
 */
function normalizeSourceKey(source: string): string {
  const key = source.toLowerCase().replace(/[-\s]+/g, '_');
  return SOURCE_VARIANT_TO_CANONICAL[key] ?? key;
}

/**
 * Resolves the HCP lead_source for a given app source following the priority:
 *  1. Per-source override from contractor's lead_source_mapping credential
 *  2. The contractor's configured default lead source (`lead_source` key)
 *  3. undefined — callers must omit lead_source from the HCP payload
 *
 * The static built-in map is intentionally NOT used as a fallback here,
 * because names in the static map may not exist in that contractor's HCP
 * account settings and would cause a 400.
 */
export async function resolveHcpLeadSource(
  contractorId: string,
  source: string | null | undefined,
): Promise<string | undefined> {
  try {
    const creds = await CredentialService.getServiceCredentials(contractorId, 'housecall-pro');

    // 1. Per-source override mapping
    if (creds.lead_source_mapping && source) {
      try {
        const mapping: Record<string, string> = JSON.parse(creds.lead_source_mapping);
        const key = normalizeSourceKey(source);
        const override = mapping[key];
        if (override && override !== '__default__') return override;
      } catch {
        // malformed JSON — fall through
      }
    }

    // 2. Contractor configured default lead source
    if (creds.lead_source) return creds.lead_source;

    // 3. No match — omit the field
    return undefined;
  } catch (err) {
    log.warn('resolveHcpLeadSource: credential lookup failed, omitting lead_source', err);
    return undefined;
  }
}
