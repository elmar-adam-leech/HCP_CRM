import type { Request } from 'express';
import { db } from '../db';
import { auditLogs } from '@shared/schema';
import { logger } from './logger';
import type { AuthenticatedRequest } from '../auth-service';

const log = logger('AuditLog');

interface AuditLogParams {
  contractorId: string;
  userId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string;
  ipAddress?: string;
  userAgent?: string;
}

function isAuditLogParams(obj: unknown): obj is AuditLogParams {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'contractorId' in obj &&
    'action' in obj &&
    typeof (obj as AuditLogParams).contractorId === 'string' &&
    typeof (obj as AuditLogParams).action === 'string'
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  if (aKeys.length !== Object.keys(bo).length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

function pickKeys(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

export async function auditLog(
  reqOrParams: Request | AuthenticatedRequest | AuditLogParams,
  action?: string,
  entityType?: string,
  entityId?: string,
  before?: Record<string, unknown>,
  after?: Record<string, unknown>,
): Promise<void> {
  try {
    let params: AuditLogParams;

    if (isAuditLogParams(reqOrParams)) {
      params = reqOrParams;
    } else {
      const req = reqOrParams as Request;
      const authedReq = req as AuthenticatedRequest;
      params = {
        contractorId: authedReq.user?.contractorId ?? '',
        userId: authedReq.user?.userId ?? null,
        action: action!,
        entityType,
        entityId,
        before,
        after,
        ipAddress: req.ip ?? req.socket?.remoteAddress ?? undefined,
        userAgent: req.headers['user-agent'] ?? undefined,
      };
    }

    let beforeDiff: Record<string, unknown> | undefined | null;
    let afterDiff: Record<string, unknown> | undefined | null;

    if (params.before && params.after) {
      const allKeys = Array.from(new Set([...Object.keys(params.before), ...Object.keys(params.after)]));
      const changedKeys = allKeys.filter((k) => !deepEqual(params.before![k], params.after![k]));
      if (changedKeys.length > 0) {
        beforeDiff = pickKeys(params.before, changedKeys);
        afterDiff = pickKeys(params.after, changedKeys);
      }
    } else {
      beforeDiff = params.before;
      afterDiff = params.after;
    }

    await db.insert(auditLogs).values({
      contractorId: params.contractorId || null,
      userId: params.userId ?? null,
      action: params.action,
      entityType: params.entityType ?? null,
      entityId: params.entityId ?? null,
      before: beforeDiff ?? null,
      after: afterDiff ?? null,
      reason: params.reason ?? null,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
    });
  } catch (err) {
    log.error('Failed to write audit log entry', { action: action ?? (reqOrParams as AuditLogParams).action, err });
  }
}
