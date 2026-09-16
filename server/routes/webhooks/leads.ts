import type { Express, Request, Response } from "express";
import { webhookRateLimiter } from "../../middleware/rate-limiter";
import { normalizePhoneForStorage, normalizePhoneArrayForStorage } from "../../utils/phone-normalizer";
import { asyncHandler } from "../../utils/async-handler";
import { validateWebhookAuth, parseWebhookPayload } from "../../utils/webhook-auth";
import { logger } from "../../utils/logger";
import { maskPhone, maskEmail, maskAddress } from "../../utils/pii-redactor";
import { parse, parseISO, isValid } from "date-fns";
import { ingestLead } from '../../services/lead-ingestion';
import { storage } from "../../storage";
import { getPublicBaseUrl } from "../../utils/public-base-url";

const log = logger('WebhookLeads');

function isAbsentOptionalString(value: unknown): boolean {
  return value === undefined
    || value === null
    || (typeof value === 'string' && value.trim().length === 0);
}

function validateOptionalString(
  fieldName: string,
  value: unknown,
  validationErrors: string[],
): void {
  if (isAbsentOptionalString(value)) return;
  if (typeof value !== 'string') {
    validationErrors.push(`'${fieldName}' must be a string, received: ${typeof value}`);
  }
}

function trimOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function deduplicateExact(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function normalizeTags(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    const tags = value.split(',').map((tag) => tag.trim()).filter(Boolean);
    const deduplicated = deduplicateExact(tags);
    return deduplicated.length > 0 ? deduplicated : undefined;
  }

  if (Array.isArray(value)) {
    const tags = value
      .filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.trim())
      .filter(Boolean);
    const deduplicated = deduplicateExact(tags);
    return deduplicated.length > 0 ? deduplicated : undefined;
  }

  return undefined;
}

export function registerLeadWebhookRoutes(app: Express): void {
  app.post("/api/webhooks/:contractorId/leads", webhookRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    try {
      const { contractorId } = req.params;

      const auth = await validateWebhookAuth(req, res, contractorId, 'webhook-leads');
      if (!auth) return;
      const { contractor } = auth;

      const requestData = parseWebhookPayload(req);
      log.debug('Extracted data: ' + JSON.stringify({
        name: requestData.name,
        email: requestData.email ? maskEmail(String(requestData.email)) : undefined,
        emails: Array.isArray(requestData.emails) ? requestData.emails.map((e: any) => maskEmail(String(e))) : requestData.emails,
        phone: requestData.phone ? maskPhone(String(requestData.phone)) : undefined,
        phones: Array.isArray(requestData.phones) ? requestData.phones.map((p: any) => maskPhone(String(p))) : requestData.phones,
        address: requestData.address ? maskAddress(String(requestData.address)) : undefined,
        street: requestData.street ? maskAddress(String(requestData.street)) : undefined,
        city: requestData.city,
        state: requestData.state,
        zip: requestData.zip,
        source: requestData.source,
        tags: requestData.tags,
        utmSource: requestData.utmSource,
        utmMedium: requestData.utmMedium,
        utmCampaign: requestData.utmCampaign,
      }, null, 2));
      
      const { 
        name, 
        email, emails,
        phone, phones,
        address, street, city, state, zip, source, notes, followUpDate, pageUrl, pageURL, utmSource, utmMedium, utmCampaign, utmTerm, utmContent,
        tags
      } = requestData;
      
      const validationErrors: string[] = [];
      
      if (!name) {
        validationErrors.push("'name' field is required but was not provided");
      } else if (typeof name !== 'string') {
        validationErrors.push(`'name' must be a string, received: ${typeof name}`);
      } else if (name.trim().length === 0) {
        validationErrors.push("'name' cannot be empty");
      }
      
      if (email !== undefined && email !== null && email !== '') {
        if (typeof email !== 'string') {
          validationErrors.push(`'email' must be a string, received: ${typeof email}`);
        } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          validationErrors.push(`'email' format is invalid: "${email}"`);
        }
      }
      
      if (phone !== undefined && phone !== null && phone !== '') {
        if (typeof phone !== 'string' && typeof phone !== 'number') {
          validationErrors.push(`'phone' must be a string or number, received: ${typeof phone}`);
        }
      }
      
      if (address !== undefined && address !== null && address !== '') {
        if (typeof address !== 'string') {
          validationErrors.push(`'address' must be a string, received: ${typeof address}`);
        }
      }

      if (street !== undefined && street !== null && street !== '') {
        if (typeof street !== 'string') {
          validationErrors.push(`'street' must be a string, received: ${typeof street}`);
        }
      }

      if (city !== undefined && city !== null && city !== '') {
        if (typeof city !== 'string') {
          validationErrors.push(`'city' must be a string, received: ${typeof city}`);
        }
      }

      if (state !== undefined && state !== null && state !== '') {
        if (typeof state !== 'string') {
          validationErrors.push(`'state' must be a string, received: ${typeof state}`);
        }
      }

      if (zip !== undefined && zip !== null && zip !== '') {
        if (typeof zip !== 'string' && typeof zip !== 'number') {
          validationErrors.push(`'zip' must be a string or number, received: ${typeof zip}`);
        }
      }
      
      if (source !== undefined && source !== null && source !== '') {
        if (typeof source !== 'string') {
          validationErrors.push(`'source' must be a string, received: ${typeof source}`);
        }
      }
      
      if (notes !== undefined && notes !== null && notes !== '') {
        if (typeof notes !== 'string') {
          validationErrors.push(`'notes' must be a string, received: ${typeof notes}`);
        }
      }

      // Both spellings are accepted because external form/webhook providers
      // use both `pageUrl` and `pageURL`. A non-blank pageUrl wins below.
      validateOptionalString('pageUrl', pageUrl, validationErrors);
      validateOptionalString('pageURL', pageURL, validationErrors);
      validateOptionalString('utmSource', utmSource, validationErrors);
      validateOptionalString('utmMedium', utmMedium, validationErrors);
      validateOptionalString('utmCampaign', utmCampaign, validationErrors);
      validateOptionalString('utmTerm', utmTerm, validationErrors);
      validateOptionalString('utmContent', utmContent, validationErrors);
      
      if (tags !== undefined && tags !== null) {
        if (typeof tags === 'string') {
          // Comma-separated tags are supported for simple form integrations.
          // Empty items are omitted and exact (case-sensitive) duplicates are
          // removed after trimming.
        } else if (!Array.isArray(tags)) {
          validationErrors.push(`'tags' must be a comma-separated string or an array, received: ${typeof tags}`);
        } else {
          const invalidTags = tags.filter((tag: any) => typeof tag !== 'string');
          if (invalidTags.length > 0) {
            validationErrors.push(`'tags' array must contain only strings, found invalid values: ${JSON.stringify(invalidTags)}`);
          }
        }
      }
      
      if (validationErrors.length > 0) {
        log.warn('Validation errors: ' + JSON.stringify(validationErrors));
        res.status(400).json({
          message: `Validation failed: ${validationErrors.join('; ')}`,
          details: validationErrors,
        });
        return;
      }
      
      let parsedFollowUpDate: Date | undefined = undefined;
      if (followUpDate && followUpDate !== '') {
        const dateStr = String(followUpDate).trim();
        
        try {
          let parsedDate = parseISO(dateStr);
          
          if (!isValid(parsedDate)) {
            const formats = [
              'MMMM dd, yyyy',
              'MMM dd, yyyy',
              'MM/dd/yyyy',
              'MM-dd-yyyy',
              'yyyy-MM-dd',
              'EEEE MMMM dd, yyyy',
            ];
            
            for (const format of formats) {
              try {
                parsedDate = parse(dateStr, format, new Date());
                if (isValid(parsedDate)) {
                  break;
                }
              } catch {
                continue;
              }
            }
            
            if (!isValid(parsedDate)) {
              const datePatterns = [
                /(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)?\s*(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/i,
                /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}/i,
                /\d{1,2}[-/]\d{1,2}[-/]\d{4}/,
                /\d{4}-\d{1,2}-\d{1,2}/
              ];
              
              for (const pattern of datePatterns) {
                const match = dateStr.match(pattern);
                if (match) {
                  const extractedDate = match[0];
                  log.debug(`Extracted date pattern: "${extractedDate}" from "${dateStr}"`);
                  
                  for (const format of formats) {
                    try {
                      parsedDate = parse(extractedDate, format, new Date());
                      if (isValid(parsedDate)) {
                        break;
                      }
                    } catch {
                      continue;
                    }
                  }
                  
                  if (isValid(parsedDate)) {
                    break;
                  }
                }
              }
            }
          }
          
          if (isValid(parsedDate)) {
            parsedFollowUpDate = parsedDate;
            log.debug(`Successfully parsed date: "${dateStr}" -> ${parsedDate.toISOString()}`);
          } else {
            log.warn(`Failed to parse date: "${dateStr}"`);
            res.status(400).json({
              message: `Could not parse followUpDate: "${dateStr}". Please use ISO format (2025-10-16T10:00:00Z) or common formats like "October 16, 2025" or "10/16/2025"`,
              details: { receivedValue: dateStr },
            });
            return;
          }
        } catch (dateError) {
          log.error('Date parsing error:', dateError);
          res.status(400).json({
            message: `Error parsing followUpDate: "${dateStr}"`,
            details: { receivedValue: dateStr },
          });
          return;
        }
      }
      
      let emailsArray: string[] = [];
      if (emails && Array.isArray(emails)) {
        emailsArray = emails.map((e: any) => String(e).trim()).filter((e: string) => e !== '');
      } else if (email) {
        emailsArray = [String(email).trim()];
      }
      
      let phonesArray: string[] = [];
      if (phones && Array.isArray(phones)) {
        log.info(`[phone-pipeline] webhook received phones array (count: ${phones.length}): [${phones.map(p => maskPhone(String(p))).join(', ')}]`);
        phonesArray = normalizePhoneArrayForStorage(phones);
        log.info(`[phone-pipeline] after normalizePhoneArrayForStorage (count: ${phonesArray.length}): [${phonesArray.map(maskPhone).join(', ')}]`);
      } else if (phone) {
        const rawPhone = String(phone).trim();
        log.info(`[phone-pipeline] webhook received phone: "${maskPhone(rawPhone)}"`);
        const normalized = normalizePhoneForStorage(rawPhone);
        log.info(`[phone-pipeline] after normalizePhoneForStorage: "${maskPhone(normalized)}"`);
        if (normalized) phonesArray = [normalized];
      }
      
      const result = await ingestLead(contractorId, {
        name: String(name).trim(),
        emails: emailsArray,
        phones: phonesArray,
        address: address ? String(address).trim() : undefined,
        street: street ? String(street).trim() : undefined,
        city: city ? String(city).trim() : undefined,
        state: state ? String(state).trim() : undefined,
        zip: zip !== undefined && zip !== null && zip !== '' ? String(zip).trim() : undefined,
        source: source ? String(source).trim() : 'External API',
        notes: notes ? String(notes).trim() : undefined,
        tags: normalizeTags(tags),
        message: notes ? String(notes).trim() : undefined,
        rawPayload: JSON.stringify(requestData),
        utmSource: trimOptionalString(utmSource),
        utmMedium: trimOptionalString(utmMedium),
        utmCampaign: trimOptionalString(utmCampaign),
        utmTerm: trimOptionalString(utmTerm),
        utmContent: trimOptionalString(utmContent),
        pageUrl: trimOptionalString(pageUrl) ?? trimOptionalString(pageURL),
        ipAddress: req.ip,
        followUpDate: parsedFollowUpDate,
        skipDuplicateLeadWithinHours: 24,
        skipAutoAssign: false,
        skipHcpSync: false,
      });

      log.info(`Lead created for contractor ${contractor.name}: ${result.lead.id} (${result.isNewContact ? 'new contact' : 'existing contact'}${result.skippedDuplicateLead ? ', duplicate skipped' : ''})`);

      // Ensure bookingCode exists (lazily generate + persist for legacy contacts)
      let contact = result.contact;
      if (!contact.bookingCode) {
        const { generateBookingCode } = await import('../../utils/booking-token');
        const newCode = generateBookingCode();
        const updated = await storage.updateContact(contact.id, { bookingCode: newCode }, contractorId);
        if (updated) contact = updated;
      }

      const bookingCode = contact.bookingCode;

      // Build ready-to-use public booking URL (when booking slug is configured)
      const publicOrigin = getPublicBaseUrl();
      const fallbackOrigin = (() => {
        const protocol = req.get('x-forwarded-proto') || req.protocol;
        const host = req.get('x-forwarded-host') || req.get('host');
        return (protocol && host) ? `${protocol}://${host}` : '';
      })();
      const origin = publicOrigin || fallbackOrigin;

      const bookingUrl = (contractor.bookingSlug && bookingCode && origin)
        ? `${origin}/book/${contractor.bookingSlug}?c=${bookingCode}`
        : undefined;

      const commonResponse = {
        leadId: result.lead.id,
        contactId: result.contact.id,
        bookingCode: bookingCode ?? null,
        ...(bookingUrl ? { bookingUrl } : {}),
        lead: {
          id: result.lead.id,
          contactId: result.lead.contactId,
          status: result.lead.status,
          source: result.lead.source,
          createdAt: result.lead.createdAt
        }
      };

      if (result.skippedDuplicateLead) {
        res.status(200).json({
          success: true,
          message: "Duplicate lead detected — existing lead returned",
          deduplicated: true,
          isNewContact: false,
          ...commonResponse
        });
      } else {
        res.status(201).json({
          success: true,
          message: result.isNewContact ? "Lead created with new contact" : "Lead created for existing contact",
          isNewContact: result.isNewContact,
          ...commonResponse
        });
      }
      
    } catch (error) {
      log.error('Processing error:', error);
      res.status(500).json({
        message: "Failed to process lead webhook",
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }));
}
