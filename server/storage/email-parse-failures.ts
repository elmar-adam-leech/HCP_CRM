import {
  emailParseFailures,
  type EmailParseFailure,
  type GmailEmail,
} from "@shared/schema";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";

export interface RecordEmailParseFailureInput {
  contractorId: string;
  inboxId: string;
  email: GmailEmail;
  errorCode: string;
  errorMessage: string;
}

async function record(input: RecordEmailParseFailureInput): Promise<EmailParseFailure> {
  const now = new Date();
  const [recorded] = await db
    .insert(emailParseFailures)
    .values({
      contractorId: input.contractorId,
      inboxId: input.inboxId,
      messageId: input.email.id,
      email: input.email,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      lastAttemptAt: now,
    })
    .onConflictDoUpdate({
      target: [
        emailParseFailures.contractorId,
        emailParseFailures.inboxId,
        emailParseFailures.messageId,
      ],
      set: {
        email: input.email,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        attempts: sql`${emailParseFailures.attempts} + 1`,
        lastAttemptAt: now,
      },
      // A resolved failure is immutable. In particular, another delivery of the
      // same Gmail message must not reopen it or increment its attempt count.
      setWhere: isNull(emailParseFailures.resolvedAt),
    })
    .returning();

  if (recorded) return recorded;

  // ON CONFLICT ... DO UPDATE WHERE returns no row when the existing failure is
  // resolved. Return that row without mutating it, retaining a useful total API.
  const [existing] = await db
    .select()
    .from(emailParseFailures)
    .where(and(
      eq(emailParseFailures.contractorId, input.contractorId),
      eq(emailParseFailures.inboxId, input.inboxId),
      eq(emailParseFailures.messageId, input.email.id),
    ))
    .limit(1);

  if (!existing) {
    throw new Error("Email parse failure upsert did not return or preserve a row");
  }
  return existing;
}

async function listPending(
  contractorId: string,
  inboxId?: string,
): Promise<EmailParseFailure[]> {
  const tenantScope = inboxId === undefined
    ? and(
        eq(emailParseFailures.contractorId, contractorId),
        isNull(emailParseFailures.resolvedAt),
      )
    : and(
        eq(emailParseFailures.contractorId, contractorId),
        eq(emailParseFailures.inboxId, inboxId),
        isNull(emailParseFailures.resolvedAt),
      );

  return db
    .select()
    .from(emailParseFailures)
    .where(tenantScope)
    .orderBy(asc(emailParseFailures.failedAt));
}

async function get(
  id: string,
  contractorId: string,
): Promise<EmailParseFailure | undefined> {
  const [failure] = await db
    .select()
    .from(emailParseFailures)
    .where(and(
      eq(emailParseFailures.id, id),
      eq(emailParseFailures.contractorId, contractorId),
    ))
    .limit(1);
  return failure;
}

async function resolve(
  contractorId: string,
  inboxId: string,
  messageId: string,
): Promise<EmailParseFailure | undefined> {
  const [failure] = await db
    .update(emailParseFailures)
    .set({ resolvedAt: new Date() })
    .where(and(
      eq(emailParseFailures.contractorId, contractorId),
      eq(emailParseFailures.inboxId, inboxId),
      eq(emailParseFailures.messageId, messageId),
      isNull(emailParseFailures.resolvedAt),
    ))
    .returning();
  return failure;
}

export const emailParseFailureStore = {
  record,
  listPending,
  get,
  resolve,
};