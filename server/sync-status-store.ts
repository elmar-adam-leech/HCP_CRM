/**
 * Sync status store — in-memory Map tracking the current HCP/Dialpad sync state per contractor.
 *
 * SCALE LIMITATION (process-scoped):
 *   This Map lives in a single Node.js process heap. On horizontal scaling (multiple
 *   server instances behind a load balancer), each process holds its own independent
 *   sync state. A client hitting a different process than the one running the sync will
 *   see stale or missing progress information.
 *   Fix: replace with a Redis key per contractorId (e.g. `sync:status:<contractorId>`)
 *   with a short TTL, shared across all instances.
 */

export interface SyncStatusData {
  isRunning: boolean;
  progress: string | null;
  error: string | null;
  lastSync: string | null;
  startTime: Date | null;
}

export const syncStatus = new Map<string, SyncStatusData>();

export const lastSyncLoaded = new Set<string>();

let broadcastFn: ((contractorId: string, message: { type: string; [key: string]: unknown }) => void) | null = null;

export function initSyncStatusBroadcast(
  fn: (contractorId: string, message: { type: string; [key: string]: unknown }) => void
) {
  broadcastFn = fn;
}

export function setSyncStatus(contractorId: string, status: SyncStatusData) {
  syncStatus.set(contractorId, status);

  if (broadcastFn) {
    broadcastFn(contractorId, {
      type: 'sync_status',
      isRunning: status.isRunning,
      progress: status.progress,
      error: status.error,
      lastSync: status.lastSync,
      startTime: status.startTime ? status.startTime.toISOString() : null,
    });
  }
}
