/**
 * One-time backfill script to populate `metadata.rfc822MessageId` on historic
 * outbound Gmail email activities.
 *
 * Why: The reply-attribution feature (Task #416) only stores RFC822 Message-Id
 * headers on outbound emails sent AFTER the feature shipped. Replies to older
 * estimates/emails fall through to the silent-drop path because there is no
 * Message-Id to match against. This script walks every existing outbound
 * email activity (`externalSource = 'gmail'`, `metadata.direction = 'outbound'`)
 * that lacks `metadata.rfc822MessageId`, refetches the Message-Id header from
 * Gmail using the original sender's stored refresh token (or the contractor's
 * shared inbox token as a fallback), and patches the activity row.
 *
 * Run with:
 *   npx tsx server/scripts/backfill-rfc822-message-ids.ts          # dry-run
 *   npx tsx server/scripts/backfill-rfc822-message-ids.ts --execute
 *
 * Optional flags:
 *   --contractor=<id>   Limit to a single contractor (otherwise all)
 *   --limit=<n>         Cap the number of activities processed (default: no cap)
 */

import { db } from "../db";
import { activities, users, sharedEmailAccounts } from "@shared/schema";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { gmailService } from "../gmail-service";

interface CliFlags {
  execute: boolean;
  contractorId?: string;
  limit?: number;
}

function parseFlags(): CliFlags {
  const args = process.argv.slice(2);
  const flags: CliFlags = { execute: false };
  for (const arg of args) {
    if (arg === "--execute") flags.execute = true;
    else if (arg.startsWith("--contractor=")) flags.contractorId = arg.slice("--contractor=".length);
    else if (arg.startsWith("--limit=")) {
      const n = parseInt(arg.slice("--limit=".length), 10);
      if (!isNaN(n) && n > 0) flags.limit = n;
    }
  }
  return flags;
}

interface CandidateRow {
  activityId: string;
  contractorId: string;
  externalId: string;
  userId: string | null;
  metadata: unknown;
}

async function fetchCandidates(flags: CliFlags): Promise<CandidateRow[]> {
  const conditions = [
    eq(activities.type, "email"),
    eq(activities.externalSource, "gmail"),
    isNotNull(activities.externalId),
    sql`(${activities.metadata}::jsonb)->>'direction' = 'outbound'`,
    sql`(${activities.metadata}::jsonb)->>'rfc822MessageId' IS NULL`,
  ];
  if (flags.contractorId) {
    conditions.push(eq(activities.contractorId, flags.contractorId));
  }

  const query = db
    .select({
      activityId: activities.id,
      contractorId: activities.contractorId,
      externalId: activities.externalId,
      userId: activities.userId,
      metadata: activities.metadata,
    })
    .from(activities)
    .where(and(...conditions))
    .orderBy(activities.createdAt);

  const rows = flags.limit ? await query.limit(flags.limit) : await query;
  return rows as CandidateRow[];
}

interface TokenSource {
  refreshToken: string;
  label: string;
}

class TokenResolver {
  private userTokens = new Map<string, string>(); // userId -> refresh token
  private sharedTokens = new Map<string, string>(); // contractorId -> refresh token
  private contractorAnyUserToken = new Map<string, { userId: string; token: string }>();

  async loadForContractors(contractorIds: string[]): Promise<void> {
    if (contractorIds.length === 0) return;

    const userRows = await db
      .select({ id: users.id, contractorId: users.contractorId, token: users.gmailRefreshToken })
      .from(users)
      .where(and(
        eq(users.gmailConnected, true),
        isNotNull(users.gmailRefreshToken),
        inArray(users.contractorId, contractorIds),
      ));
    for (const r of userRows) {
      if (!r.token) continue;
      this.userTokens.set(r.id, r.token);
      if (r.contractorId && contractorIds.includes(r.contractorId) && !this.contractorAnyUserToken.has(r.contractorId)) {
        this.contractorAnyUserToken.set(r.contractorId, { userId: r.id, token: r.token });
      }
    }

    const sharedRows = await db
      .select({
        contractorId: sharedEmailAccounts.contractorId,
        gmailRefreshToken: sharedEmailAccounts.gmailRefreshToken,
      })
      .from(sharedEmailAccounts)
      .where(inArray(sharedEmailAccounts.contractorId, contractorIds));
    for (const r of sharedRows) {
      if (r.gmailRefreshToken) this.sharedTokens.set(r.contractorId, r.gmailRefreshToken);
    }
  }

  candidatesFor(activity: CandidateRow): TokenSource[] {
    const sources: TokenSource[] = [];
    const seen = new Set<string>();
    const push = (token: string | undefined, label: string) => {
      if (!token || seen.has(token)) return;
      seen.add(token);
      sources.push({ refreshToken: token, label });
    };
    if (activity.userId) push(this.userTokens.get(activity.userId), `user:${activity.userId}`);
    push(this.sharedTokens.get(activity.contractorId), `shared:${activity.contractorId}`);
    const fallback = this.contractorAnyUserToken.get(activity.contractorId);
    if (fallback) push(fallback.token, `user:${fallback.userId} (fallback)`);
    return sources;
  }
}

async function backfill() {
  const flags = parseFlags();
  console.log("=".repeat(60));
  console.log("Backfill RFC822 Message-Id on historic outbound emails");
  console.log(`Mode: ${flags.execute ? "EXECUTE" : "DRY RUN"}`);
  if (flags.contractorId) console.log(`Contractor filter: ${flags.contractorId}`);
  if (flags.limit) console.log(`Limit: ${flags.limit}`);
  console.log("=".repeat(60));

  if (!gmailService.isConfigured()) {
    console.error("Gmail service is not configured (missing client id/secret). Aborting.");
    process.exit(1);
  }

  const candidates = await fetchCandidates(flags);
  console.log(`Found ${candidates.length} outbound email activity row(s) missing rfc822MessageId.`);
  if (candidates.length === 0) return;

  const contractorIds = Array.from(new Set(candidates.map(c => c.contractorId)));
  const resolver = new TokenResolver();
  await resolver.loadForContractors(contractorIds);

  let updated = 0;
  let skippedNoToken = 0;
  let skippedNoHeader = 0;
  let skippedNotFound = 0;
  let errored = 0;

  for (const activity of candidates) {
    const sources = resolver.candidatesFor(activity);
    if (sources.length === 0) {
      skippedNoToken++;
      console.warn(`[skip:no-token] activity=${activity.activityId} contractor=${activity.contractorId}`);
      continue;
    }

    let messageIdHeader: string | undefined;
    let lastErr: any;
    let usedLabel: string | undefined;
    let notFound = false;
    for (const src of sources) {
      try {
        messageIdHeader = await gmailService.fetchMessageIdHeader(src.refreshToken, activity.externalId);
        usedLabel = src.label;
        break;
      } catch (err: any) {
        lastErr = err;
        const status = err?.code || err?.response?.status;
        // 404 means the message simply isn't in this mailbox — try next token.
        // Other errors (auth, rate limit, network) we also try the next token.
        if (status === 404) notFound = true;
      }
    }

    if (!messageIdHeader) {
      if (lastErr && !notFound) {
        errored++;
        console.error(`[error] activity=${activity.activityId} gmailMsg=${activity.externalId}: ${lastErr?.message ?? lastErr}`);
      } else if (notFound) {
        skippedNotFound++;
        console.warn(`[skip:not-found] activity=${activity.activityId} gmailMsg=${activity.externalId}`);
      } else {
        skippedNoHeader++;
        console.warn(`[skip:no-header] activity=${activity.activityId} gmailMsg=${activity.externalId}`);
      }
      continue;
    }

    if (flags.execute) {
      // JSONB patch: only writes the rfc822MessageId field, preserving any
      // other metadata changes that may have happened concurrently. Guarded
      // by `IS NULL` so we never overwrite an existing value.
      await db.execute(sql`
        UPDATE ${activities}
        SET metadata = (COALESCE(${activities.metadata}::jsonb, '{}'::jsonb) || jsonb_build_object('rfc822MessageId', ${messageIdHeader}::text))::jsonb,
            updated_at = NOW()
        WHERE id = ${activity.activityId}
          AND (${activities.metadata}::jsonb)->>'rfc822MessageId' IS NULL
      `);
    }
    updated++;
    console.log(`[${flags.execute ? "updated" : "would-update"}] activity=${activity.activityId} via=${usedLabel} messageId=${messageIdHeader}`);
  }

  console.log("=".repeat(60));
  console.log(`Summary: ${flags.execute ? "updated" : "would-update"}=${updated} no-token=${skippedNoToken} not-found=${skippedNotFound} no-header=${skippedNoHeader} errored=${errored}`);
  if (!flags.execute) {
    console.log("Re-run with --execute to apply changes.");
  }
  console.log("=".repeat(60));
}

backfill()
  .then(() => process.exit(0))
  .catch(err => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
