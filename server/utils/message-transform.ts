import type { Message } from "@shared/schema";

/**
 * Maps a joined Activity row (with an optional `userName` from a users-join) to the
 * `Message` shape expected by conversation views.
 *
 * Pure function — no database access. Extracted from `server/storage/messaging.ts` so
 * that it can be tested in isolation without a database fixture.
 *
 * Direction resolution:
 *   1. `metadata.direction` is authoritative when present ('inbound' | 'outbound').
 *   2. Falls back to a title-prefix check (`"Email received"`) for legacy rows that
 *      were stored before the `direction` metadata field was added.
 *   3. Defaults to 'outbound'.
 */
export function emailActivityToMessage(activity: {
  id: string;
  content: string | null;
  contactId: string | null;
  estimateId: string | null;
  userId: string | null;
  contractorId: string;
  createdAt: Date;
  metadata: unknown;
  userName: string | null;
  title?: string | null;
}): Message {
  const metadata = (activity.metadata && typeof activity.metadata === 'object' ? activity.metadata : {}) as Record<string, unknown>;

  let direction: 'inbound' | 'outbound' = 'outbound';
  if (metadata.direction === 'inbound' || metadata.direction === 'outbound') {
    direction = metadata.direction;
  } else if (activity.title?.startsWith('Email received')) {
    direction = 'inbound';
  }

  const toArr = metadata.to as string[] | undefined;
  const fromStr = metadata.from as string | undefined;
  const messageIdStr = metadata.messageId as string | undefined;
  const subjectStr = (metadata.subject as string | undefined)
    // Fall back to deriving subject from the activity title (e.g. "Email sent: Foo")
    // for legacy rows that didn't store subject in metadata.
    ?? (activity.title?.includes(': ') ? activity.title.split(': ').slice(1).join(': ') : undefined);

  return {
    id: activity.id,
    type: 'email' as const,
    status: 'sent' as const,
    direction,
    content: activity.content || '',
    toNumber: toArr?.[0] || '',
    fromNumber: fromStr || '',
    contactId: activity.contactId,
    estimateId: activity.estimateId,
    userId: activity.userId,
    externalMessageId: messageIdStr || null,
    contractorId: activity.contractorId,
    createdAt: activity.createdAt,
    userName: activity.userName,
    // Non-Message field consumed by the frontend conversation view so the
    // single rendered card can read "Email sent: <subject>" instead of just
    // "Email sent". Cast through Message preserves the existing API contract.
    subject: subjectStr || '',
  } as unknown as Message & { subject: string };
}
