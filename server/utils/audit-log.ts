import type { Request } from 'express';
import _ from 'lodash';
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
      const changedKeys = _.union(Object.keys(params.before), Object.keys(params.after)).filter(
        (k: string) => !_.isEqual(params.before![k], params.after![k])
      );
      if (changedKeys.length > 0) {
        beforeDiff = _.pick(params.before, changedKeys);
        afterDiff = _.pick(params.after, changedKeys);
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
