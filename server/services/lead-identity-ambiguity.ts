import { notifications } from '@shared/schema';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { storage } from '../storage';

export function isLeadIdentityAmbiguity(error: unknown): error is Error & { code: 'LEAD_IDENTITY_AMBIGUOUS' } {
  return !!error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'LEAD_IDENTITY_AMBIGUOUS';
}

/**
 * Make an asynchronous intake ambiguity visible to someone who can resolve it.
 *
 * Pollers intentionally retry an unmatched ambiguous submission instead of
 * advancing past it. The unread notification is deduplicated per recipient and
 * provider reference, so that retrying it does not generate a new alert every
 * sync cycle. Once it is read, a continued unresolved issue can alert again.
 */
export async function notifyLeadIdentityAmbiguity(
  contractorId: string,
  channel: string,
  reference: string | undefined,
  error: Error,
  retryInstruction = 'Retry the submission after resolving the duplicate contacts.',
): Promise<void> {
  const recipients = Array.from(new Set(
    (await storage.getContractorUsers(contractorId))
      .filter(member => ['admin', 'super_admin', 'manager'].includes(member.role))
      .map(member => member.userId),
  ));
  if (recipients.length === 0) return;

  const title = 'Lead needs duplicate-contact review';
  const message = [
    `A ${channel} lead${reference ? ` (${reference})` : ''} matched multiple contacts and was not imported.`,
    error.message,
    retryInstruction,
  ].join(' ');

  await Promise.all(recipients.map(async userId => {
    const existing = await db.select({ id: notifications.id })
      .from(notifications)
      .where(and(
        eq(notifications.contractorId, contractorId),
        eq(notifications.userId, userId),
        eq(notifications.title, title),
        eq(notifications.message, message),
        eq(notifications.read, false),
      ))
      .limit(1);
    if (existing.length > 0) return;

    await storage.createNotification({
      userId,
      type: 'system',
      title,
      message,
      link: '/leads',
    }, contractorId);
  }));
}