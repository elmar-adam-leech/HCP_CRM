import { storage } from '../storage';
import { db } from '../db';
import { users, activities, contacts, contractors } from '@shared/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { withRetry } from '../utils/retry';
import { gmailService } from '../gmail-service';
import { broadcastToContractor } from '../websocket';
import { logger } from '../utils/logger';

const log = logger('SyncGmail');

interface SyncOneAccountOpts {
  tenantId: string;
  accountLabel: string;          // 'user:<id>' or 'shared:<id>' for log lines
  refreshToken: string;
  gmailEmail: string | null;     // used for outbound detection
  sinceDate?: Date;
  userIdForActivity: string | null; // null for shared inbox (system-attributed)
  autoLearnReplyAddresses: boolean; // contractor-level toggle for auto-learning new sender addrs
  onTokenExpired: () => Promise<void>;
  onSynced: (when: Date) => Promise<void>;
}

async function syncOneGmailAccount(opts: SyncOneAccountOpts): Promise<void> {
  const {
    tenantId, accountLabel, refreshToken, gmailEmail,
    sinceDate, userIdForActivity, autoLearnReplyAddresses,
    onTokenExpired, onSynced,
  } = opts;

  try {
    log.info(`Syncing emails for ${accountLabel} — lastSyncAt: ${sinceDate?.toISOString() ?? 'never'}`);

    const result = await withRetry(
      () => gmailService.fetchNewEmails(refreshToken, sinceDate),
      `fetchNewEmails for ${accountLabel}`
    );

    if (result.tokenExpired) {
      log.info(`Gmail token expired for ${accountLabel} — running disconnect callback`);
      await onTokenExpired();
      return;
    }

    const emails = result.emails;
    log.info(`Found ${emails.length} new emails for ${accountLabel}`);

    // Batch dedup: one query for all email IDs instead of one per email
    const allEmailIds = emails.map((e: any) => e.id).filter(Boolean);
    let knownEmailIds = new Set<string>();
    if (allEmailIds.length > 0) {
      const existingRows = await db
        .select({ externalId: activities.externalId })
        .from(activities)
        .where(and(
          inArray(activities.externalId, allEmailIds),
          eq(activities.externalSource, 'gmail'),
          eq(activities.contractorId, tenantId),
        ));
      knownEmailIds = new Set(existingRows.map(r => r.externalId!));
    }

    type ActivityPayload = Parameters<typeof storage.createActivity>[0];
    const activitiesToInsert: ActivityPayload[] = [];

    for (const email of emails) {
      if (knownEmailIds.has(email.id)) {
        continue;
      }

      const fromEmail = email.from;
      const toEmails = email.to || [];
      // Prefer Gmail's own SENT label — reliably catches alias-sent emails even
      // when the from address differs from the connected gmailEmail.
      const isOutbound = email.labelIds?.includes('SENT')
        || (gmailEmail && fromEmail.toLowerCase() === gmailEmail.toLowerCase());

      const emailsToSearch = isOutbound ? toEmails : (fromEmail ? [fromEmail] : []);
      let matchedContactId = emailsToSearch.length > 0
        ? await storage.findMatchingContact(tenantId, emailsToSearch, [])
        : null;

      // Header-based fallback: when sender-based matching missed (e.g. spouse
      // replying from a different address), match the inbound email by its
      // RFC822 In-Reply-To / References headers against stored outbound
      // activities. Only applied to inbound — outbound rows would only be
      // self-matches.
      let matchedEstimateId: string | null = null;
      let matchedJobId: string | null = null;
      let matchedViaHeaders = false;
      if (!matchedContactId && !isOutbound) {
        const headerIds: string[] = [];
        if (email.inReplyTo) headerIds.push(email.inReplyTo);
        if (email.references) headerIds.push(...email.references);
        if (headerIds.length > 0) {
          const matches = await storage.findActivitiesByRfc822MessageIds(tenantId, headerIds);
          const distinctContactIds = Array.from(new Set(
            matches.map(m => m.contactId).filter((c): c is string => !!c)
          ));
          if (distinctContactIds.length === 1) {
            matchedContactId = distinctContactIds[0];
            const m = matches.find(x => x.contactId === matchedContactId)!;
            matchedEstimateId = m.estimateId;
            matchedJobId = m.jobId;
            matchedViaHeaders = true;
          } else if (distinctContactIds.length > 1) {
            // Rare: same thread crosses multiple contacts (forwarded thread).
            // Fall back to the most recent matching activity's contact.
            const newest = matches.find(m => !!m.contactId)!;
            matchedContactId = newest.contactId!;
            matchedEstimateId = newest.estimateId;
            matchedJobId = newest.jobId;
            matchedViaHeaders = true;
            log.warn(
              `Header-based reply matched ${distinctContactIds.length} distinct contacts ` +
              `for email ${email.id}; using most recent (contact ${matchedContactId})`
            );
          }
        }
      }

      const matchingContact = matchedContactId
        ? await storage.getContact(matchedContactId, tenantId)
        : undefined;

      if (!matchingContact) {
        continue;
      }

      // Skip email activity creation for contacts where every lead is archived
      // and there are no estimates or jobs — these are muted/archived senders.
      const archivedCheckResult = await db.execute<{ is_fully_archived: boolean }>(sql`
        SELECT (
          EXISTS (SELECT 1 FROM leads WHERE leads.contact_id = ${matchingContact.id} AND leads.contractor_id = ${tenantId} AND leads.archived = true)
          AND NOT EXISTS (SELECT 1 FROM leads WHERE leads.contact_id = ${matchingContact.id} AND leads.contractor_id = ${tenantId} AND leads.archived = false)
          AND NOT EXISTS (SELECT 1 FROM estimates WHERE estimates.contact_id = ${matchingContact.id} AND estimates.contractor_id = ${tenantId})
          AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.contact_id = ${matchingContact.id} AND jobs.contractor_id = ${tenantId})
        ) AS is_fully_archived
      `);
      if (archivedCheckResult.rows[0]?.is_fully_archived) {
        log.debug(`Skipping email ${email.id} — contact ${matchingContact.id} has only archived leads`);
        continue;
      }

      // Auto-learn the new sender address when the reply was attributed via
      // headers (so subsequent replies match via the fast sender path). Skip
      // outbound rows and the connected mailbox's own address so we don't
      // accidentally pollute the contact with our own info@ address.
      if (
        matchedViaHeaders
        && autoLearnReplyAddresses
        && fromEmail
        && (!gmailEmail || fromEmail.toLowerCase() !== gmailEmail.toLowerCase())
      ) {
        const senderLower = fromEmail.toLowerCase();
        const existing = (matchingContact.emails || []).map(e => e.toLowerCase());
        if (!existing.includes(senderLower)) {
          try {
            await db.update(contacts)
              .set({ emails: [...(matchingContact.emails || []), senderLower] })
              .where(and(
                eq(contacts.id, matchingContact.id),
                eq(contacts.contractorId, tenantId),
              ));
            activitiesToInsert.push({
              type: 'note',
              title: 'Reply address auto-learned',
              content: `Added ${senderLower} from reply to thread.`,
              metadata: { autoLearnedFromRfc822MessageId: email.inReplyTo || (email.references?.[0] ?? null) },
              contactId: matchingContact.id,
              userId: userIdForActivity,
            });
            log.info(`Auto-learned reply address for contact ${matchingContact.id}`);
          } catch (learnErr: any) {
            log.error(`Failed to auto-learn reply address for contact ${matchingContact.id}`, {
              message: learnErr?.message,
            });
          }
        }
      }

      const emailMetadata: Record<string, unknown> = {
        subject: email.subject,
        to: email.to,
        from: email.from,
        messageId: email.id,
        direction: isOutbound ? 'outbound' : 'inbound',
      };
      if (email.rfc822MessageId) {
        emailMetadata.rfc822MessageId = email.rfc822MessageId;
      }
      if (matchedViaHeaders) {
        emailMetadata.matchedViaHeaders = true;
      }

      activitiesToInsert.push({
        type: 'email',
        title: isOutbound ? `Email sent: ${email.subject}` : `Email received: ${email.subject}`,
        content: email.body,
        metadata: emailMetadata,
        contactId: matchingContact.id,
        estimateId: matchedEstimateId,
        jobId: matchedJobId,
        userId: userIdForActivity,
        externalId: email.id,
        externalSource: 'gmail',
      });
    }

    if (activitiesToInsert.length > 0) {
      const inserted = await storage.bulkCreateActivities(activitiesToInsert, tenantId);

      // Emit a realtime `new_message` for each inbound email so the unread
      // badge hooks (`useUnreadSummary`, `useUnreadCountsByContacts`) re-fetch
      // immediately, matching how SMS already behaves.
      for (const a of inserted) {
        if (a.type !== 'email' || !a.contactId) continue;
        const md = (a.metadata && typeof a.metadata === 'object'
          ? a.metadata as Record<string, unknown>
          : {});
        if (md.direction !== 'inbound') continue;
        broadcastToContractor(tenantId, {
          type: 'new_message',
          contactId: a.contactId,
        });
      }
    }

    await onSynced(new Date());
    log.info(`Processed ${activitiesToInsert.length} emails for ${accountLabel}`);
  } catch (err: any) {
    log.error(`Error syncing Gmail for ${accountLabel}`, {
      message: err.message,
      code: err.code,
      status: err.status,
      errors: err.errors,
    });
  }
}

export async function syncGmail(tenantId: string): Promise<void> {
  log.info(`Syncing Gmail emails for tenant ${tenantId}`);

  try {
    const [gmailUsers, sharedAccount, contractorRow] = await Promise.all([
      db.select().from(users).where(and(
        eq(users.contractorId, tenantId),
        eq(users.gmailConnected, true),
      )),
      storage.getSharedEmailAccount(tenantId),
      db.select({
        autoLearnReplyAddresses: contractors.autoLearnReplyAddresses,
      }).from(contractors).where(eq(contractors.id, tenantId)).limit(1),
    ]);

    // Default ON when the column has not been set.
    const autoLearnReplyAddresses = contractorRow[0]?.autoLearnReplyAddresses ?? true;

    const totalAccounts = gmailUsers.length + (sharedAccount?.gmailRefreshToken ? 1 : 0);
    if (totalAccounts === 0) {
      log.info(`No Gmail accounts (user or shared) found for tenant ${tenantId}`);
      return;
    }

    log.info(`Found ${gmailUsers.length} user account(s) and ${sharedAccount ? 1 : 0} shared account to sync (tenant: ${tenantId})`);

    for (const user of gmailUsers) {
      if (!user.gmailRefreshToken) {
        log.info(`Skipping user ${user.id} — no refresh token`);
        continue;
      }

      await syncOneGmailAccount({
        tenantId,
        accountLabel: `user:${user.id}`,
        refreshToken: user.gmailRefreshToken,
        gmailEmail: user.gmailEmail ?? null,
        sinceDate: user.gmailLastSyncAt || undefined,
        userIdForActivity: user.id,
        autoLearnReplyAddresses,
        onTokenExpired: async () => {
          await db.update(users)
            .set({ gmailConnected: false, gmailRefreshToken: null })
            .where(eq(users.id, user.id));

          await storage.createNotification({
            userId: user.id,
            type: 'system',
            title: 'Gmail Reconnection Required',
            message: 'Your Gmail connection has expired. Please reconnect your Gmail account in Settings to continue syncing emails.',
            link: '/settings',
          }, tenantId);
        },
        onSynced: async (when) => {
          await db.update(users)
            .set({ gmailLastSyncAt: when })
            .where(eq(users.id, user.id));
        },
      });
    }

    if (sharedAccount && sharedAccount.gmailRefreshToken) {
      await syncOneGmailAccount({
        tenantId,
        accountLabel: `shared:${sharedAccount.id}`,
        refreshToken: sharedAccount.gmailRefreshToken,
        gmailEmail: sharedAccount.email,
        sinceDate: sharedAccount.lastSyncAt || undefined,
        userIdForActivity: null,
        autoLearnReplyAddresses,
        onTokenExpired: async () => {
          log.info(`Shared inbox token expired for tenant ${tenantId} — clearing and notifying`);
          await storage.clearSharedEmailToken(tenantId);

          // Notify the connecting user, falling back to all admins for the contractor.
          const recipients: string[] = [];
          if (sharedAccount.connectedByUserId) {
            recipients.push(sharedAccount.connectedByUserId);
          } else {
            const members = await storage.getContractorUsers(tenantId);
            for (const m of members) {
              if (m.role === 'admin' || m.role === 'super_admin' || m.role === 'manager') {
                recipients.push(m.userId);
              }
            }
          }

          for (const userId of recipients) {
            await storage.createNotification({
              userId,
              type: 'system',
              title: 'Shared Company Email Reconnection Required',
              message: 'The shared company email connection has expired. Please reconnect it in Settings > Integrations to continue syncing inbound emails.',
              link: '/settings?tab=integrations',
            }, tenantId);
          }
        },
        onSynced: async (when) => {
          await storage.updateSharedEmailLastSyncAt(tenantId, when);
        },
      });
    }
  } catch (error: any) {
    log.error(`Error in Gmail sync for tenant ${tenantId}`, {
      message: error.message,
      code: error.code,
      stack: error.stack?.split('\n').slice(0, 3).join('\n'),
    });
    throw error;
  }
}
