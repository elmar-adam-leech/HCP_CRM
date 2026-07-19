import { type LeadCaptureInbox, type SenderRule, type FieldMapping, activities, contacts } from '@shared/schema';
import { gmailService } from '../gmail-service';
import { parseEmailWithAI, runHeuristicSpamCheck } from './email-ai-parser';
import { extractFirstUrl, extractUrlByPattern, fetchPageText, extractMarketingUrl, KNOWN_PLATFORMS, SOURCE_ABBREVIATIONS } from './link-fetcher';
import { storage } from '../storage';
import { db } from '../db';
import { eq, and, inArray } from 'drizzle-orm';
import { logger } from '../utils/logger';
import { normalizePhoneForStorage } from '../utils/phone-normalizer';
import { maskEmail } from '../utils/pii-redactor';
import { ingestLead } from './lead-ingestion';
import { broadcastToContractor } from '../websocket';
import { dispatchInboundReplyWorkflows } from '../services/inbound-reply-dispatcher';

const log = logger('LeadCaptureSync');

function extractEmailAddress(fromHeader: string): string {
  const match = fromHeader.match(/<([^>]+)>/);
  return (match ? match[1] : fromHeader).trim().toLowerCase();
}

function findSenderRule(rules: SenderRule[], fromAddress: string): SenderRule | undefined {
  const email = extractEmailAddress(fromAddress);
  return rules.find(r => r.senderEmail.toLowerCase() === email);
}

interface ExtractedFields {
  name?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  message?: string;
  address?: string;
  source?: string;
  notes?: string;
  utmCampaign?: string;
  utmSource?: string;
  utmMedium?: string;
  utmTerm?: string;
  utmContent?: string;
  pageUrl?: string;
}

function stripMarkdownFormatting(text: string): string {
  return text.replace(/\*\*|__|\*|_/g, '').trim();
}

function normalizeLabel(label: string): string {
  return stripMarkdownFormatting(label).toLowerCase().replace(/[:\s]+$/, '').trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+\-?^${}()|[\]\\\/]/g, '\\$&');
}

function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function isPlaceholderValue(v: string | undefined): boolean {
  if (!v) return true;
  const trimmed = v.trim();
  if (!trimmed) return true;
  if (/^[-_–—.]+$/.test(trimmed)) return true;
  return false;
}

const FULL_NAME_LABELS = ['full name', 'customer name', 'name'];
const FIRST_NAME_LABELS = ['first name', 'given name'];
const LAST_NAME_LABELS = ['last name', 'surname', 'family name'];

function findLabeledLineValue(body: string, labels: string[]): string | undefined {
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const normalizedLine = stripMarkdownFormatting(line).toLowerCase().trim();
    for (const label of labels) {
      if (!normalizedLine.startsWith(label)) continue;
      const after = normalizedLine.charAt(label.length);
      // Label must end at line end, or be followed by separator/markdown — not a letter/digit
      if (after && !/[\s:*_]/.test(after)) continue;
      const labelEndPattern = new RegExp(
        `^[\\s*_]*${escapeRegExp(label)}[\\s*_:]*`,
        'i'
      );
      const value = stripMarkdownFormatting(line).replace(labelEndPattern, '').replace(/^[:\s]+/, '').trim();
      if (!isPlaceholderValue(value)) {
        return collapseSpaces(value);
      }
    }
  }
  return undefined;
}

/**
 * Auto-detects a contact's full name from email body text by looking for either:
 *   1. An explicit "Name:" / "Full Name:" / "Customer Name:" line, OR
 *   2. Separate "First Name:" and "Last Name:" lines (combining them).
 * Returns undefined if nothing usable is found. Single-half matches (only first
 * or only last) are returned alone — better than nothing.
 */
export function detectFullNameFromBody(body: string): string | undefined {
  const fullName = findLabeledLineValue(body, FULL_NAME_LABELS);
  if (fullName) return fullName;
  const first = findLabeledLineValue(body, FIRST_NAME_LABELS);
  const last = findLabeledLineValue(body, LAST_NAME_LABELS);
  if (first && last) return collapseSpaces(`${first} ${last}`);
  if (first) return first;
  if (last) return last;
  return undefined;
}

export function extractFieldsFromMappings(body: string, mappings: FieldMapping[]): ExtractedFields {
  const result: ExtractedFields = {};
  const lines = body.split(/\r?\n/);

  for (const mapping of mappings) {
    const normalizedMappingLabel = normalizeLabel(mapping.label);
    for (const line of lines) {
      const normalizedLine = stripMarkdownFormatting(line).toLowerCase().trim();
      if (normalizedLine.startsWith(normalizedMappingLabel)) {
        const labelEndPattern = new RegExp(
          `^[\\s*_]*${escapeRegExp(normalizedMappingLabel)}[\\s*_:]*`,
          'i'
        );
        const value = line.trim().replace(labelEndPattern, '').replace(/^[:\s]+/, '').trim();
        if (value) {
          const existing = result[mapping.field];
          if (mapping.field === 'name' && existing) {
            // Multiple "Name"-targeted mappings (e.g. legacy first+last both → name):
            // prefer concatenation over silently overwriting the previous value.
            result[mapping.field] = collapseSpaces(`${existing} ${value}`);
          } else {
            result[mapping.field] = value;
          }
          break;
        }
      }
    }
  }

  // If firstName / lastName mappings captured values but no explicit "name" mapping
  // produced one, combine them into the canonical `name` field. If only one half
  // was captured, use it alone (still better than dropping the contact's name).
  if (!result.name && (result.firstName || result.lastName)) {
    const combined = collapseSpaces(
      [result.firstName, result.lastName].filter(Boolean).join(' ')
    );
    if (combined) result.name = combined;
  }

  return result;
}

export async function syncLeadCaptureInbox(inbox: LeadCaptureInbox): Promise<{
  processed: number;
  skippedSpam: number;
  skippedDuplicate: number;
  skippedBlocked: number;
  errors: number;
}> {
  const stats = { processed: 0, skippedSpam: 0, skippedDuplicate: 0, skippedBlocked: 0, errors: 0 };
  const rawRules = (inbox.senderRules as any[]) || [];
  const senderRules: SenderRule[] = rawRules.map((r: any) => {
    const actions = r.actions && r.actions.length > 0
      ? r.actions
      : r.action ? [r.action] : ['default'];
    return { ...r, actions } as SenderRule;
  });

  const sinceDate = inbox.lastSyncAt
    ? inbox.lastSyncAt
    : new Date(Date.now() - 24 * 60 * 60 * 1000);

  const contractor = await storage.getContractor(inbox.contractorId);
  const contractorDomain = contractor?.domain;
  const autoLearnReplyAddresses = contractor?.autoLearnReplyAddresses ?? true;
  const inboxAddressLower = inbox.emailAddress?.toLowerCase() ?? null;

  log.info(`Starting lead capture sync for contractor ${inbox.contractorId}, since ${sinceDate.toISOString()}`);

  const result = await gmailService.fetchNewEmails(inbox.gmailRefreshToken, sinceDate);

  if (result.error || result.tokenExpired) {
    log.error(`Gmail fetch error for lead capture: ${result.error}`);
    throw new Error(result.tokenExpired
      ? 'Gmail token expired. Please reconnect the lead capture inbox.'
      : result.error || 'Unknown Gmail error');
  }

  const inboxEmails = (result.emails || []).filter(e => e.labelIds?.includes('INBOX'));

  log.info(`Found ${inboxEmails.length} inbox emails to process`);

  const emailIds = inboxEmails.map(e => e.id).filter(Boolean);
  const existingIds = new Set<string>();
  if (emailIds.length > 0) {
    const existingActivities = await db.select({ externalId: activities.externalId })
      .from(activities)
      .where(and(
        inArray(activities.externalId, emailIds),
        eq(activities.externalSource, 'lead_capture'),
        eq(activities.contractorId, inbox.contractorId)
      ));
    existingActivities.forEach(a => { if (a.externalId) existingIds.add(a.externalId); });
  }

  for (const email of inboxEmails) {
    try {
      if (existingIds.has(email.id)) {
        stats.skippedDuplicate++;
        continue;
      }

      const rule = findSenderRule(senderRules, email.from);
      const ruleActions = rule?.actions || ['default'];

      // Header-based reply matching: when no sender rule applies, check whether
      // this inbound email is a reply to one of our own outbound emails (matched
      // by RFC822 In-Reply-To / References headers). If so, file it against the
      // matched contact (and estimate/job) instead of creating a brand-new lead.
      // Mirrors the per-user Gmail sync behavior in server/sync/gmail.ts.
      if (!rule) {
        const headerIds: string[] = [];
        if (email.inReplyTo) headerIds.push(email.inReplyTo);
        if (email.references) headerIds.push(...email.references);
        if (headerIds.length > 0) {
          const matches = await storage.findActivitiesByRfc822MessageIds(inbox.contractorId, headerIds);
          const distinctContactIds = Array.from(new Set(
            matches.map(m => m.contactId).filter((c): c is string => !!c)
          ));
          let matchedContactId: string | null = null;
          let matchedLeadId: string | null = null;
          let matchedEstimateId: string | null = null;
          let matchedJobId: string | null = null;
          if (distinctContactIds.length === 1) {
            matchedContactId = distinctContactIds[0];
            const m = matches.find(x => x.contactId === matchedContactId)!;
            matchedLeadId = m.leadId || null;
            matchedEstimateId = m.estimateId;
            matchedJobId = m.jobId;
          } else if (distinctContactIds.length > 1) {
            const newest = matches.find(m => !!m.contactId)!;
            matchedContactId = newest.contactId!;
            matchedLeadId = newest.leadId || null;
            matchedEstimateId = newest.estimateId;
            matchedJobId = newest.jobId;
            log.warn(
              `Header-based reply matched ${distinctContactIds.length} distinct contacts ` +
              `for lead-capture email ${email.id}; using most recent (contact ${matchedContactId})`
            );
          }

          if (matchedContactId) {
            const matchingContact = await storage.getContact(matchedContactId, inbox.contractorId);
            if (matchingContact) {
              const fromEmail = email.from;
              const senderLower = extractEmailAddress(fromEmail);

              if (
                autoLearnReplyAddresses
                && senderLower
                && (!inboxAddressLower || senderLower !== inboxAddressLower)
              ) {
                const existing = (matchingContact.emails || []).map(e => e.toLowerCase());
                if (!existing.includes(senderLower)) {
                  try {
                    await db.update(contacts)
                      .set({ emails: [...(matchingContact.emails || []), senderLower] })
                      .where(and(
                        eq(contacts.id, matchingContact.id),
                        eq(contacts.contractorId, inbox.contractorId),
                      ));
                    await storage.createActivity({
                      type: 'note',
                      title: 'Reply address auto-learned',
                      content: `Added ${senderLower} from reply to thread.`,
                      metadata: { autoLearnedFromRfc822MessageId: email.inReplyTo || (email.references?.[0] ?? null) },
                      contactId: matchingContact.id,
                      userId: null,
                    }, inbox.contractorId);
                    log.info(`Auto-learned reply address for contact ${matchingContact.id} (lead-capture)`);
                  } catch (learnErr: any) {
                    log.error(`Failed to auto-learn reply address for contact ${matchingContact.id}`, {
                      message: learnErr?.message,
                    });
                  }
                }
              }

              // Resolve current lead for this contact if not provided from prior activity
              if (!matchedLeadId && matchingContact.id) {
                try {
                  const leads = await storage.getLeadsByContact(matchingContact.id, inbox.contractorId);
                  const openLead = leads.find((l: any) => !l.archived && ['new', 'contacted', 'qualified'].includes(l.status)) || leads[0];
                  if (openLead) matchedLeadId = openLead.id;
                } catch (e) {
                  log.error('Error resolving lead for lead-capture inbound email', e);
                }
              }

              await storage.createActivity({
                type: 'email',
                title: `Email received: ${email.subject}`,
                content: email.body,
                metadata: {
                  subject: email.subject,
                  to: email.to,
                  from: email.from,
                  messageId: email.id,
                  direction: 'inbound',
                  rfc822MessageId: email.rfc822MessageId,
                  matchedViaHeaders: true,
                },
                contactId: matchingContact.id,
                leadId: matchedLeadId,
                estimateId: matchedEstimateId,
                jobId: matchedJobId,
                userId: null,
                externalId: email.id,
                externalSource: 'lead_capture',
              }, inbox.contractorId);

              // Trigger unread-badge invalidation on connected clients (parity with SMS).
              broadcastToContractor(inbox.contractorId, {
                type: 'new_message',
                contactId: matchingContact.id,
              });

              // Dispatch reply workflows for this inbound email (gated inside)
              dispatchInboundReplyWorkflows({
                contractorId: inbox.contractorId,
                contactId: matchingContact.id,
                leadId: matchedLeadId || undefined,
                estimateId: matchedEstimateId || undefined,
                jobId: matchedJobId || undefined,
                content: email.body || '',
                type: 'email',
                messageId: undefined, // activity id not captured here
                sourceIntegration: 'gmail', // lead-capture uses gmail under the hood
              }).catch((err) => log.error('Inbound reply dispatcher (lead-capture) failed:', err));

              stats.processed++;
              log.info(`Filed lead-capture reply ${email.id} against contact ${matchingContact.id} via headers`);
              continue;
            }
          }
        }
      }

      if (ruleActions.includes('block')) {
        log.info(`Blocked email from ${maskEmail(email.from)}: ${email.subject}`);
        stats.skippedBlocked++;
        continue;
      }

      let textForAI = email.body;

      if (ruleActions.includes('follow_link')) {
        let url: string | null = null;
        if (rule?.urlPattern) {
          url = extractUrlByPattern(email.body, rule.urlPattern);
          if (!url) {
            log.warn(`No URL matching pattern "${rule.urlPattern}" found, falling back to first URL`);
            url = extractFirstUrl(email.body);
          }
        } else {
          url = extractFirstUrl(email.body);
        }
        if (url) {
          log.info(`Following link for sender rule: ${url}`);
          const pageText = await fetchPageText(url);
          if (pageText) {
            textForAI = pageText;
          } else {
            log.warn(`Failed to fetch linked page, falling back to email body`);
          }
        } else {
          log.warn(`No URL found in email body for follow_link rule, using email body`);
        }
      }

      const mappings = rule?.fieldMappings;
      let mappedFields: ExtractedFields = {};
      if (mappings && mappings.length > 0) {
        mappedFields = extractFieldsFromMappings(textForAI, mappings);
        log.info(`Field mappings extracted ${Object.keys(mappedFields).length} fields for rule ${maskEmail(rule?.senderEmail ?? '')}`);
      }

      const mappedFieldList = mappings?.map(m => m.field) ?? [];
      const mappedFieldNames = new Set(mappedFieldList);
      const allFieldsMapped = mappings && mappings.length > 0 &&
        mappedFieldList.every(f => mappedFields[f as keyof ExtractedFields]);

      const senderOverride = rule?.spamOverride || 'none';

      if (inbox.spamFilterEnabled && senderOverride === 'always_block') {
        log.info(`Always-block override for sender ${maskEmail(email.from)}: ${email.subject}`);
        await storage.createSpamAuditEntry({
          inboxId: inbox.id,
          contractorId: inbox.contractorId,
          senderEmail: extractEmailAddress(email.from),
          subject: email.subject,
          body: email.body.substring(0, 50000),
          spamConfidence: 100,
          reason: 'Sender rule: always block',
        });
        stats.skippedSpam++;
        continue;
      }

      const skipSpamCheck = senderOverride === 'always_allow';

      if (inbox.spamFilterEnabled && !skipSpamCheck) {
        let heuristicName = mappedFields.name || undefined;
        let heuristicPhone = mappedFields.phone || undefined;
        let heuristicEmail = mappedFields.email || undefined;
        let heuristicMessage = mappedFields.message || undefined;

        if (!heuristicName || !heuristicPhone || !heuristicEmail) {
          let heuristicFirstName: string | undefined;
          let heuristicLastName: string | undefined;
          const lines = textForAI.split(/\r?\n/);
          for (const line of lines) {
            const trimmed = line.trim();
            // Order matters: longer multi-word labels must come before single-word `name`
            // so the spam heuristic sees the human's real name (not e.g. just "Petri").
            const labelMatch = trimmed.match(/^[\s*_]*(first name|last name|full name|customer name|name|phone|email|message|service|description)[:\s*_]+(.+)/i);
            if (labelMatch) {
              const label = labelMatch[1].toLowerCase();
              const value = labelMatch[2].replace(/^[:\s]+/, '').trim();
              if (!value) continue;
              if ((label === 'name' || label === 'full name' || label === 'customer name') && !heuristicName) heuristicName = value;
              if (label === 'first name' && !heuristicFirstName) heuristicFirstName = value;
              if (label === 'last name' && !heuristicLastName) heuristicLastName = value;
              if (label === 'phone' && !heuristicPhone) heuristicPhone = value;
              if (label === 'email' && !heuristicEmail) heuristicEmail = value;
              if ((label === 'message' || label === 'service' || label === 'description') && !heuristicMessage) heuristicMessage = value;
            }
          }
          if (!heuristicName && (heuristicFirstName || heuristicLastName)) {
            heuristicName = collapseSpaces(
              [heuristicFirstName, heuristicLastName].filter(Boolean).join(' ')
            );
          }
          if (!heuristicEmail) {
            const emailMatch = textForAI.toLowerCase().match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
            if (emailMatch) heuristicEmail = emailMatch[0];
          }
          if (!heuristicPhone) {
            const phoneMatch = textForAI.match(/\+?[\d\s\-().]{7,15}/);
            if (phoneMatch) heuristicPhone = phoneMatch[0].trim();
          }
        }

        const heuristic = runHeuristicSpamCheck(heuristicName, heuristicPhone, heuristicEmail, heuristicMessage, textForAI);
        if (heuristic.isSpam) {
          log.info(`Heuristic spam filter caught email: ${email.subject} (confidence=${heuristic.confidence}, reason=${heuristic.reason})`);
          await storage.createSpamAuditEntry({
            inboxId: inbox.id,
            contractorId: inbox.contractorId,
            senderEmail: extractEmailAddress(email.from),
            subject: email.subject,
            body: email.body.substring(0, 50000),
            spamConfidence: heuristic.confidence,
            reason: heuristic.reason,
          });
          stats.skippedSpam++;
          continue;
        }
      }

      const needsAI = !allFieldsMapped || (inbox.spamFilterEnabled && !skipSpamCheck);
      const aiResult = needsAI
        ? await parseEmailWithAI(email.subject, textForAI)
        : { isSpam: false };

      if (inbox.spamFilterEnabled && !skipSpamCheck) {
        const confidence = aiResult.spamConfidence ?? 0;
        const threshold = inbox.spamConfidenceThreshold ?? 80;
        const isSpam = aiResult.isSpam === true || confidence >= threshold;
        if (isSpam) {
          log.info(`Skipping spam email: ${email.subject} (isSpam=${aiResult.isSpam}, spamConfidence=${confidence}, threshold=${threshold})`);
          await storage.createSpamAuditEntry({
            inboxId: inbox.id,
            contractorId: inbox.contractorId,
            senderEmail: extractEmailAddress(email.from),
            subject: email.subject,
            body: email.body.substring(0, 50000),
            spamConfidence: confidence,
            reason: aiResult.isSpam ? 'AI flagged as spam' : `Confidence ${confidence} >= threshold ${threshold}`,
          });
          stats.skippedSpam++;
          continue;
        }
      }

      const skipSenderMatching = ruleActions.includes('each_email_is_new_lead') || ruleActions.includes('follow_link');

      const contactEmail = mappedFields.email || (mappedFieldNames.has('email') ? undefined : aiResult.email) || (skipSenderMatching ? undefined : email.from);
      // Auto-detect a combined "First + Last" name from the body when the user
      // hasn't mapped a name field — covers Elementor / WPForms / Contact Form 7
      // style emails that send "First Name:" and "Last Name:" on separate lines.
      // Prefer this over the AI's name extraction (the AI sometimes returns just
      // one half) and over the email-address prefix fallback.
      const autoDetectedName = mappedFieldNames.has('name')
        ? undefined
        : detectFullNameFromBody(textForAI);
      const contactName = mappedFields.name
        || autoDetectedName
        || (mappedFieldNames.has('name') ? undefined : aiResult.name)
        || (contactEmail ? contactEmail.split('@')[0] : 'Unknown');
      const rawPhone = mappedFields.phone || (mappedFieldNames.has('phone') ? undefined : aiResult.phone);
      const normalizedPhone = rawPhone ? normalizePhoneForStorage(rawPhone) : '';
      const serviceDescription = mappedFields.message || (mappedFieldNames.has('message') ? undefined : aiResult.serviceDescription);
      const contactAddress = mappedFields.address;
      const contactSource = mappedFields.source;
      const contactNotes = mappedFields.notes;

      const autoParsed = extractMarketingUrl(email.body, contractorDomain);

      const utmSource = mappedFields.utmSource || (autoParsed?.utmSource);
      const utmMedium = mappedFields.utmMedium || (autoParsed?.utmMedium);
      const utmCampaign = mappedFields.utmCampaign || (autoParsed?.utmCampaign);
      const utmTerm = mappedFields.utmTerm || (autoParsed?.utmTerm);
      const utmContent = mappedFields.utmContent || (autoParsed?.utmContent);
      const pageUrl = mappedFields.pageUrl || (autoParsed?.pageUrl);

      let resolvedSource = contactSource || 'email_capture';
      if (!contactSource && utmSource) {
        const normalized = SOURCE_ABBREVIATIONS[utmSource.toLowerCase()] || utmSource.toLowerCase();
        if (KNOWN_PLATFORMS.has(normalized)) {
          resolvedSource = normalized;
        }
      }

      const noteContent = `**Email Subject:** ${email.subject}\n\n${email.body.substring(0, 5000)}`;

      const result = await ingestLead(inbox.contractorId, {
        name: contactName || 'Unknown',
        emails: contactEmail ? [contactEmail] : [],
        phones: normalizedPhone ? [normalizedPhone] : [],
        address: contactAddress,
        notes: contactNotes,
        source: resolvedSource,
        message: serviceDescription || email.subject,
        utmCampaign,
        utmSource,
        utmMedium,
        utmTerm,
        utmContent,
        pageUrl,
        activityNote: noteContent,
        activityExternalId: email.id,
        skipDuplicateLeadWithinHours: skipSenderMatching ? 0 : 24,
        skipContactMatching: skipSenderMatching,
        skipAutoAssign: false,
      });

      if (result.skippedDuplicateLead) {
        stats.skippedDuplicate++;
        continue;
      }

      stats.processed++;
      log.info(`Created lead ${result.lead.id} from email: ${email.subject}`);
    } catch (error) {
      log.error(`Error processing lead capture email ${email.id}:`, error);
      stats.errors++;
    }
  }

  await storage.updateLeadCaptureInboxSyncTime(inbox.contractorId);

  log.info(`Lead capture sync complete: ${stats.processed} processed, ${stats.skippedSpam} spam, ${stats.skippedDuplicate} duplicates, ${stats.skippedBlocked} blocked, ${stats.errors} errors`);
  return stats;
}
