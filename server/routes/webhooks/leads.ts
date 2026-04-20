import type { Express, Request, Response } from "express";
import { webhookRateLimiter } from "../../middleware/rate-limiter";
import { normalizePhoneForStorage, normalizePhoneArrayForStorage } from "../../utils/phone-normalizer";
import { asyncHandler } from "../../utils/async-handler";
import { validateWebhookAuth, parseWebhookPayload } from "../../utils/webhook-auth";
import { logger } from "../../utils/logger";
import { maskPhone, maskEmail, maskAddress } from "../../utils/pii-redactor";
import { parse, parseISO, isValid } from "date-fns";
import { ingestLead } from '../../services/lead-ingestion';

const log = logger('WebhookLeads');

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
        address, street, city, state, zip, source, notes, followUpDate, pageUrl, utmSource, utmMedium, utmCampaign, utmTerm, utmContent,
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
      
      if (tags !== undefined && tags !== null) {
        if (!Array.isArray(tags)) {
          validationErrors.push(`'tags' must be an array, received: ${typeof tags}`);
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
        tags: tags && Array.isArray(tags) ? tags.map((t: any) => String(t).trim()).filter((t: string) => t !== '') : undefined,
        message: notes ? String(notes).trim() : undefined,
        rawPayload: JSON.stringify(requestData),
        utmSource: utmSource ? String(utmSource).trim() : undefined,
        utmMedium: utmMedium ? String(utmMedium).trim() : undefined,
        utmCampaign: utmCampaign ? String(utmCampaign).trim() : undefined,
        utmTerm: utmTerm ? String(utmTerm).trim() : undefined,
        utmContent: utmContent ? String(utmContent).trim() : undefined,
        pageUrl: pageUrl ? String(pageUrl).trim() : undefined,
        ipAddress: req.ip,
        followUpDate: parsedFollowUpDate,
        skipDuplicateLeadWithinHours: 24,
        skipAutoAssign: false,
        skipHcpSync: false,
      });

      log.info(`Lead created for contractor ${contractor.name}: ${result.lead.id} (${result.isNewContact ? 'new contact' : 'existing contact'}${result.skippedDuplicateLead ? ', duplicate skipped' : ''})`);

      if (result.skippedDuplicateLead) {
        res.status(200).json({
          success: true,
          message: "Duplicate lead detected — existing lead returned",
          deduplicated: true,
          leadId: result.lead.id,
          contactId: result.contact.id,
          isNewContact: false,
          lead: {
            id: result.lead.id,
            contactId: result.lead.contactId,
            status: result.lead.status,
            source: result.lead.source,
            createdAt: result.lead.createdAt
          }
        });
      } else {
        res.status(201).json({
          success: true,
          message: result.isNewContact ? "Lead created with new contact" : "Lead created for existing contact",
          leadId: result.lead.id,
          contactId: result.contact.id,
          isNewContact: result.isNewContact,
          lead: {
            id: result.lead.id,
            contactId: result.lead.contactId,
            status: result.lead.status,
            source: result.lead.source,
            createdAt: result.lead.createdAt
          }
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
