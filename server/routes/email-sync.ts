import type { Express } from "express";
import { asyncHandler } from "../utils/async-handler";
import { parseBody } from "../utils/validate-body";
import { storage } from "../storage";
import { activities, users } from "@shared/schema";
import { db } from "../db";
import { eq, and, inArray } from "drizzle-orm";
import { gmailService } from "../gmail-service";
import { broadcastToContractor } from "../websocket";
import { z } from "zod";
import { logger } from "../utils/logger";

const log = logger('EmailSyncRoutes');

const fetchGmailSchema = z.object({
  sinceDate: z.string().optional(),
});

export function registerEmailSyncRoutes(app: Express): void {
  app.post("/api/emails/fetch-gmail", asyncHandler(async (req, res) => {
    const validatedData = parseBody(fetchGmailSchema, req, res);
    if (!validatedData) return;

    const { sinceDate } = validatedData;

    const userResult = await db.select().from(users).where(and(
      eq(users.id, req.user.userId),
      eq(users.contractorId, req.user.contractorId)
    ));
    const user = userResult[0];
    if (!user || !user.gmailConnected || !user.gmailRefreshToken) {
      res.status(400).json({ message: "Gmail not connected. Please connect your Gmail account in settings." });
      return;
    }

    const since = sinceDate ? new Date(sinceDate) : (user.gmailLastSyncAt || undefined);
    const result = await gmailService.fetchNewEmails(user.gmailRefreshToken, since);

    if (result.error) {
      log.error('Gmail fetch error', result.error);
      res.status(500).json({ message: result.error });
      return;
    }

    if (result.tokenExpired) {
      res.status(401).json({ message: "Gmail token expired. Please reconnect your Gmail account." });
      return;
    }

    const emails = result.emails || [];

    const emailIds = emails.map((e: any) => e.id).filter(Boolean);
    const existingIds = new Set<string>();
    if (emailIds.length > 0) {
      const existingActivities = await db.select({ externalId: activities.externalId })
        .from(activities)
        .where(and(
          inArray(activities.externalId, emailIds),
          eq(activities.externalSource, 'gmail'),
          eq(activities.contractorId, req.user.contractorId)
        ));
      existingActivities.forEach((a: any) => { if (a.externalId) existingIds.add(a.externalId); });
    }

    let processedCount = 0;
    for (const email of emails) {
      if (existingIds.has(email.id)) {
        log.info(`Skipping duplicate email: ${email.id}`);
        continue;
      }

      const fromEmail = email.from;
      const toEmails: string[] = Array.isArray(email.to) ? email.to : (email.to ? [email.to] : []);

      // Prefer Gmail's own SENT label — reliably catches alias-sent emails even
      // when the from address differs from the connected gmailEmail.
      const isOutbound = email.labelIds?.includes('SENT')
        || fromEmail?.toLowerCase() === user.gmailEmail?.toLowerCase();
      const direction = isOutbound ? 'outbound' : 'inbound';
      const emailsToMatch = isOutbound ? toEmails : (fromEmail ? [fromEmail] : []);

      let matchingContact = null;

      if (emailsToMatch.length > 0) {
        const matchedId = await storage.findMatchingContact(
          req.user.contractorId,
          emailsToMatch
        );
        if (matchedId) {
          matchingContact = await storage.getContact(matchedId, req.user.contractorId) ?? null;
        }
      }

      const matchingLead = matchingContact?.type === 'lead' ? matchingContact : null;
      const matchingCustomer = matchingContact?.type === 'customer' ? matchingContact : null;

      const emailMetadata = {
        subject: email.subject,
        to: email.to,
        from: email.from,
        messageId: email.id,
        direction: direction,
      };

      const activity = await storage.createActivity({
        type: 'email',
        title: direction === 'inbound' ? `Email received: ${email.subject}` : `Email sent: ${email.subject}`,
        content: email.body || email.snippet,
        metadata: emailMetadata,
        contactId: matchingContact?.id || null,
        userId: req.user.userId,
        externalId: email.id,
        externalSource: 'gmail',
      }, req.user.contractorId);

      if (matchingContact) {
        broadcastToContractor(req.user.contractorId, {
          type: 'new_activity',
          contactId: matchingContact.id,
          ...(matchingLead ? { leadId: matchingLead.id } : {}),
          ...(matchingCustomer ? { customerId: matchingCustomer.id } : {}),
          activity: activity,
        });
        // For inbound emails, also emit `new_message` so unread badge hooks
        // (`useUnreadSummary`, `useUnreadCountsByContacts`) refresh — parity
        // with the SMS broadcast contract.
        if (direction === 'inbound') {
          broadcastToContractor(req.user.contractorId, {
            type: 'new_message',
            contactId: matchingContact.id,
          });
        }
      }

      processedCount++;
    }

    await db.update(users)
      .set({ gmailLastSyncAt: new Date() })
      .where(and(
        eq(users.id, req.user.userId),
        eq(users.contractorId, req.user.contractorId)
      ));

    res.json({
      success: true,
      count: processedCount,
      message: `Fetched ${processedCount} new emails`
    });
  }));
}
