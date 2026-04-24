import { refreshTokens, type RefreshToken, type InsertRefreshToken } from "@shared/schema";
import { db } from "../db";
import { and, eq, isNull, lt } from "drizzle-orm";

async function createRefreshToken(input: InsertRefreshToken): Promise<RefreshToken> {
  const [row] = await db.insert(refreshTokens).values(input).returning();
  return row;
}

/**
 * Look up a refresh-token row by its SHA-256 hash. Returns the row regardless
 * of state (active, rotated within grace, rotated past grace, or revoked) so
 * the /api/auth/refresh handler can evaluate state explicitly. Excludes only
 * rows that have been hard-revoked AND are also outside any rotation window —
 * the route handler enforces those checks instead of the query, so that
 * "rotation grace window" semantics live in one place.
 */
async function findRefreshTokenByHash(tokenHash: string): Promise<RefreshToken | undefined> {
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);
  return row;
}

/**
 * Lookup limited to non-revoked rows. Used by callers that only care about
 * "valid for use" semantics and don't need to evaluate rotated_at themselves
 * (e.g., logout flows).
 */
async function findActiveRefreshTokenByHash(tokenHash: string): Promise<RefreshToken | undefined> {
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(and(
      eq(refreshTokens.tokenHash, tokenHash),
      isNull(refreshTokens.revokedAt),
    ))
    .limit(1);
  return row;
}

async function markRefreshTokenUsed(
  id: string,
  fields: {
    lastUsedAt: Date;
    ip?: string | null;
    userAgent?: string | null;
    rotate?: boolean;
    revoke?: boolean;
  },
): Promise<void> {
  const updates: Record<string, unknown> = {
    lastUsedAt: fields.lastUsedAt,
  };
  if (fields.ip !== undefined) updates.ip = fields.ip;
  if (fields.userAgent !== undefined) updates.userAgent = fields.userAgent;
  if (fields.rotate) updates.rotatedAt = fields.lastUsedAt;
  if (fields.revoke) updates.revokedAt = fields.lastUsedAt;
  await db.update(refreshTokens).set(updates).where(eq(refreshTokens.id, id));
}

async function revokeRefreshToken(id: string): Promise<void> {
  await db.update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.revokedAt)));
}

async function revokeRefreshTokenByHash(tokenHash: string): Promise<void> {
  await db.update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)));
}

async function revokeRefreshTokensForUser(userId: string): Promise<void> {
  await db.update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

async function revokeRefreshTokensForUserContractor(userId: string, contractorId: string): Promise<void> {
  await db.update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(refreshTokens.userId, userId),
      eq(refreshTokens.contractorId, contractorId),
      isNull(refreshTokens.revokedAt),
    ));
}

async function revokeRefreshTokensForContractor(contractorId: string): Promise<void> {
  await db.update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.contractorId, contractorId), isNull(refreshTokens.revokedAt)));
}

async function deleteExpiredRefreshTokens(now: Date = new Date()): Promise<number> {
  const result = await db.delete(refreshTokens)
    .where(lt(refreshTokens.expiresAt, now))
    .returning({ id: refreshTokens.id });
  return result.length;
}

export const refreshTokenMethods = {
  createRefreshToken,
  findRefreshTokenByHash,
  findActiveRefreshTokenByHash,
  markRefreshTokenUsed,
  revokeRefreshToken,
  revokeRefreshTokenByHash,
  revokeRefreshTokensForUser,
  revokeRefreshTokensForUserContractor,
  revokeRefreshTokensForContractor,
  deleteExpiredRefreshTokens,
};
