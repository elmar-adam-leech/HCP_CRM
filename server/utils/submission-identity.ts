import { createHash } from 'node:crypto';

/** Provider identity, not payload similarity. Namespaces must not cross sources or tenants. */
export function submissionIdentityKey(
  contractorId: string,
  input: { source: string; submissionId?: string; activityExternalId?: string },
): string | undefined {
  const identity = input.submissionId?.trim()
    ? ['submission', input.submissionId.trim()]
    : input.activityExternalId?.trim() ? ['external', input.activityExternalId.trim()] : undefined;
  if (!identity) return undefined;
  return createHash('sha256').update(JSON.stringify([contractorId, input.source, identity])).digest('hex');
}

/** Drizzle wraps the PostgreSQL error in `cause`; ignore all other unique errors. */
export function isSubmissionCreationConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    const current = error as { code?: string; constraint?: string; cause?: unknown };
    if (current.code === '23505' && current.constraint === 'contacts_submission_creation_idx') return true;
    error = current.cause;
  }
  return false;
}