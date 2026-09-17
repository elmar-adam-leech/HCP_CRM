import { contacts } from '@shared/schema';
import { db } from '../db';
import { and, eq, or, sql } from 'drizzle-orm';
import { isValidPhoneNumber, normalizePhoneNumber } from '../utils/phone-normalizer';
import { Pool as NeonPool } from '@neondatabase/serverless';
import { Pool as PgPool } from 'pg';

/**
 * Deliberately narrow identity matcher for inbound lead capture. It is not a
 * replacement for storage.findMatchingContact: communication, HCP and public
 * booking retain their established single-identifier semantics.
 */
export interface LeadIdentity {
  name?: string;
  emails: string[];
  phones: string[];
}

export class LeadIdentityAmbiguityError extends Error {
  readonly code = 'LEAD_IDENTITY_AMBIGUOUS';

  constructor(readonly contactIds: string[]) {
    super(
      `Unable to safely match this lead: two or more contacts (${contactIds.join(', ')}) ` +
      'match at least two identity fields. Resolve the duplicate contacts and retry.',
    );
    this.name = 'LeadIdentityAmbiguityError';
  }
}

const UNKNOWN_NAME = /^(?:unknown(?: lead)?|n\/?a|none|not provided)$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeLeadIdentity(input: {
  name?: string;
  emails?: string[] | null;
  phones?: string[] | null;
}): LeadIdentity {
  const name = input.name?.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const emails = Array.from(new Set(
    (input.emails ?? [])
      .map(email => email.trim().toLocaleLowerCase())
      .filter(email => EMAIL.test(email)),
  ));
  const phones = Array.from(new Set(
    (input.phones ?? [])
      .filter(phone => isValidPhoneNumber(phone))
      .map(phone => normalizePhoneNumber(phone)),
  ));

  return {
    // Provider placeholders are not a person's name and must never provide an
    // otherwise-valid "second" identity field.
    name: name && !UNKNOWN_NAME.test(name) ? name : undefined,
    emails,
    phones,
  };
}

function identityFieldCount(identity: LeadIdentity): number {
  return Number(!!identity.name) + Number(identity.emails.length > 0) + Number(identity.phones.length > 0);
}

function matchingFields(
  identity: LeadIdentity,
  contact: { name: string; emails: string[] | null; phones: string[] | null },
): { name: boolean; email: boolean; phone: boolean } {
  const stored = normalizeLeadIdentity(contact);
  return {
    name: !!identity.name && stored.name === identity.name,
    email: identity.emails.some(email => stored.emails.includes(email)),
    phone: identity.phones.some(phone => stored.phones.includes(phone)),
  };
}

/**
 * Resolve a contact only where at least two independent, normalized identity
 * fields agree. `null` means that fewer than two usable fields were supplied
 * or no candidate qualifies. Ambiguous matches intentionally throw rather
 * than silently choosing or creating another duplicate.
 */
export async function findTwoFieldLeadIdentityContact(
  contractorId: string,
  identity: LeadIdentity,
): Promise<string | null> {
  if (identityFieldCount(identity) < 2) return null;

  const candidateConditions = [];
  if (identity.name) {
    candidateConditions.push(
      sql`LOWER(REGEXP_REPLACE(BTRIM(${contacts.name}), '\\s+', ' ', 'g')) = ${identity.name}`,
    );
  }
  for (const email of identity.emails) {
    candidateConditions.push(sql`EXISTS (
      SELECT 1 FROM unnest(COALESCE(${contacts.emails}, '{}'::text[])) AS contact_email
      WHERE LOWER(BTRIM(contact_email)) = ${email}
    )`);
  }
  for (const phone of identity.phones) {
    const digits = phone.replace(/\D/g, '');
    // The SQL predicate is only a candidate prefilter. The country-aware
    // normalizer in matchingFieldCount is the authority before a match wins.
    candidateConditions.push(sql`EXISTS (
      SELECT 1 FROM unnest(COALESCE(${contacts.phones}, '{}'::text[])) AS contact_phone
      WHERE regexp_replace(contact_phone, '\\D', '', 'g') = ${digits}
        OR RIGHT(regexp_replace(contact_phone, '\\D', '', 'g'), 10) = ${digits.slice(-10)}
    )`);
  }

  const candidates = await db.select({
    id: contacts.id,
    name: contacts.name,
    emails: contacts.emails,
    phones: contacts.phones,
  }).from(contacts).where(and(
    eq(contacts.contractorId, contractorId),
    or(...candidateConditions)!,
  ));

  const matchingCandidates = candidates.map(candidate => {
    const fields = matchingFields(identity, candidate);
    return {
      id: candidate.id,
      fields,
      count: Number(fields.name) + Number(fields.email) + Number(fields.phone),
    };
  }).filter(candidate => candidate.count > 0);
  const twoFieldCandidates = matchingCandidates.filter(candidate => candidate.count >= 2);
  const strongOwners = matchingCandidates.filter(candidate => candidate.fields.email || candidate.fields.phone);

  // A shared name alone is weak evidence, so it must not block an otherwise
  // unambiguous email/phone match. Conversely, two independent strong owners
  // prove that the incoming identity is split across records (e.g. A owns its
  // email and B its phone), which must be resolved by a user.
  if (twoFieldCandidates.length > 1 || new Set(strongOwners.map(candidate => candidate.id)).size > 1) {
    const conflicts = twoFieldCandidates.length > 1 ? twoFieldCandidates : strongOwners;
    throw new LeadIdentityAmbiguityError(conflicts.map(candidate => candidate.id));
  }
  return twoFieldCandidates[0]?.id ?? null;
}

export interface LeadIdentityLock {
  release(): Promise<void>;
}

// Advisory-lock waiters must never occupy the application pool: ingestion
// persistence uses that pool too, and enough concurrent waiters would
// otherwise starve the lock holder's writes. Keep a separate, deliberately
// tiny pool solely for the short coordination critical section.
const MAX_COORDINATION_LOCKS = 2;
const connectionString = process.env.NODE_ENV === 'production'
  ? process.env.NEON_DATABASE_URL
  : process.env.DATABASE_URL;
const coordinationPool = process.env.NODE_ENV === 'production'
  ? new NeonPool({ connectionString, max: MAX_COORDINATION_LOCKS, idleTimeoutMillis: 10_000 })
  : new PgPool({ connectionString, max: MAX_COORDINATION_LOCKS, idleTimeoutMillis: 10_000 });

/**
 * Serialize the short contact/lead persistence critical section per
 * contractor. A contractor-level key, rather than pair-only keys, also closes
 * the race where two different valid pairs resolve to the same candidate.
 *
 * At most two requests per process can wait/hold a dedicated coordination
 * connection. The normal storage pool therefore remains available to the
 * lock holder's writes even during an intake burst.
 */
export async function acquireLeadIdentityLock(
  contractorId: string,
  _identity: LeadIdentity,
): Promise<LeadIdentityLock | null> {
  let client: {
    query(query: string, values?: unknown[]): Promise<unknown>;
    release(error?: Error): void;
  } | undefined;
  let locked = false;
  let released = false;
  const key = `lead-identity-contractor:${contractorId}`;
  try {
    client = await (coordinationPool as unknown as {
      connect(): Promise<{
        query(query: string, values?: unknown[]): Promise<unknown>;
        release(error?: Error): void;
      }>;
    }).connect();
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
    locked = true;
  } catch (error) {
    // If the server reports an error after acquiring the lock, explicitly
    // unlock before returning this connection to the pool. The guard also
    // handles connection-acquisition failures without attempting cleanup on
    // an undefined client.
    if (locked && client) {
      let unlockError: Error | undefined;
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      } catch (error) {
        // `release()` would retain this session (and potentially its advisory
        // lock) in the coordination pool. Release with an error to destroy it.
        unlockError = error instanceof Error ? error : new Error('Failed to release lead identity advisory lock');
      }
      client.release(unlockError);
    } else {
      client?.release();
    }
    throw error;
  }

  return {
    async release() {
      if (released) return;
      released = true;
      let unlockError: Error | undefined;
      try {
        await client!.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      } catch (error) {
        unlockError = error instanceof Error ? error : new Error('Failed to release lead identity advisory lock');
      }
      // A release error deliberately destroys the session, guaranteeing a
      // session-scoped advisory lock cannot leak into the next requester.
      client!.release(unlockError);
    },
  };
}