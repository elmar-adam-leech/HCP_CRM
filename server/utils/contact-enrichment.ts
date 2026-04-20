import { type Contact } from '@shared/schema';

export interface EnrichmentInput {
  emails?: string[];
  phones?: string[];
  address?: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  notes?: string;
  tags?: string[];
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
}

/**
 * Builds a partial contact update containing only fields that are new or
 * additive compared to the existing contact. Used to enrich a contact when
 * new data arrives (e.g. duplicate lead, webhook update, manual import).
 *
 * Rules:
 * - phones/emails/tags: merged with deduplication (new items only appended)
 * - notes: incoming notes appended to existing (newline-separated)
 * - address: written if incoming is non-empty and differs from the existing value (covers no address and changed address)
 * - UTM fields: first-touch-only — only written if the contact field is empty
 * - If nothing changed, returns null (no DB write needed)
 */
export function buildContactEnrichment(
  existing: Contact,
  input: EnrichmentInput,
  normalizedPhones: string[]
): Partial<Contact> | null {
  const update: Record<string, unknown> = {};

  if (normalizedPhones.length > 0) {
    const existingPhones = existing.phones || [];
    const existingSet = new Set(existingPhones);
    const merged = [...existingPhones];
    for (const p of normalizedPhones) {
      if (!existingSet.has(p)) {
        existingSet.add(p);
        merged.push(p);
      }
    }
    if (merged.length > existingPhones.length) {
      update.phones = merged;
    }
  }

  if (input.emails && input.emails.length > 0) {
    const existingEmails = existing.emails || [];
    const existingLower = new Set(existingEmails.map(e => e.toLowerCase()));
    const merged = [...existingEmails];
    for (const e of input.emails) {
      const lower = e.toLowerCase();
      if (!existingLower.has(lower)) {
        existingLower.add(lower);
        merged.push(e);
      }
    }
    if (merged.length > existingEmails.length) {
      update.emails = merged;
    }
  }

  if (input.tags && input.tags.length > 0) {
    const existingTags = existing.tags || [];
    const existingTagSet = new Set(existingTags);
    const merged = [...existingTags];
    for (const t of input.tags) {
      if (!existingTagSet.has(t)) {
        existingTagSet.add(t);
        merged.push(t);
      }
    }
    if (merged.length > existingTags.length) {
      update.tags = merged;
    }
  }

  if (input.notes && input.notes.trim()) {
    if (existing.notes && existing.notes.trim()) {
      update.notes = `${existing.notes}\n${input.notes}`;
    } else {
      update.notes = input.notes;
    }
  }

  if (input.address && input.address !== existing.address) {
    update.address = input.address;
  }

  if (input.street && input.street !== existing.street) {
    update.street = input.street;
  }
  if (input.city && input.city !== existing.city) {
    update.city = input.city;
  }
  if (input.state && input.state !== existing.state) {
    update.state = input.state;
  }
  if (input.zip && input.zip !== existing.zip) {
    update.zip = input.zip;
  }

  if (input.utmSource && !existing.utmSource) update.utmSource = input.utmSource;
  if (input.utmMedium && !existing.utmMedium) update.utmMedium = input.utmMedium;
  if (input.utmCampaign && !existing.utmCampaign) update.utmCampaign = input.utmCampaign;
  if (input.utmTerm && !existing.utmTerm) update.utmTerm = input.utmTerm;
  if (input.utmContent && !existing.utmContent) update.utmContent = input.utmContent;

  if (Object.keys(update).length === 0) return null;
  return update as Partial<Contact>;
}
