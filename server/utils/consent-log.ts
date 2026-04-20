import { createHash } from "crypto";
import { db } from "../db";
import { consentLogs } from "@shared/schema";
import { logger } from "./logger";

const log = logger('ConsentLog');

export const CONSENT_VERSION = "privacy-v1.0-2026";

export function hashIp(ip: string | null | undefined): string | null {
  if (!ip || ip === 'unknown') return null;
  return createHash('sha256').update(ip).digest('hex');
}

interface ConsentLogParams {
  contractorId: string;
  contactId?: string | null;
  userId?: string | null;
  source: string;
  optInType?: "implied" | "explicit";
  ipHash?: string | null;
  metadata?: Record<string, unknown>;
}

export async function logConsent(params: ConsentLogParams): Promise<void> {
  try {
    await db.insert(consentLogs).values({
      contractorId: params.contractorId,
      contactId: params.contactId ?? null,
      userId: params.userId ?? null,
      source: params.source,
      optInType: params.optInType ?? "implied",
      consentVersion: CONSENT_VERSION,
      ipHash: params.ipHash ?? null,
      metadata: params.metadata ?? {},
    });
  } catch (err) {
    log.error('Failed to write consent log entry', err);
  }
}
