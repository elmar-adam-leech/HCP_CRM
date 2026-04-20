import type { WorkflowStep } from "@shared/schema";
import type { StepResult } from "./types";
import { logger } from "../utils/logger";

const log = logger('WorkflowDelay');

// ────────────────────────────────────────────────────────────────────────────
// DB-backed suspend / resume design
// ────────────────────────────────────────────────────────────────────────────
// Delays do NOT use setTimeout. Instead the handler returns
//   { suspend: true, resumeAt: <Date> }
// which causes WorkflowEngine to:
//   1. Write the execution row to "suspended" status + store resumeAt in the DB.
//   2. Return immediately — no memory timer is held.
//
// On every server startup, WorkflowEngine.startSuspendedPoller() launches a
// background loop (default interval 30 s) that queries for suspended executions
// whose resumeAt has passed and calls resumeSuspendedWorkflow() on each.
//
// Crash safety: because the suspend state is persisted to the DB, a server
// restart does not lose pending delays — they resume automatically once the
// poller starts. The recoverZombieExecutions() startup job only needs to clean
// up truly stuck "running" executions, not suspended ones.
// ────────────────────────────────────────────────────────────────────────────

export function parseDuration(duration: string): number {
  let match = duration.match(/^(\d+)([smhd])$/);
  if (match) {
    const value = parseInt(match[1]);
    const unit = match[2];
    switch (unit) {
      case 's': return value * 1000;
      case 'm': return value * 60 * 1000;
      case 'h': return value * 60 * 60 * 1000;
      case 'd': return value * 24 * 60 * 60 * 1000;
      default: return 0;
    }
  }

  match = duration.match(/^(\d+)\s*(second|minute|hour|day)s?$/i);
  if (match) {
    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    switch (unit) {
      case 'second': return value * 1000;
      case 'minute': return value * 60 * 1000;
      case 'hour':   return value * 60 * 60 * 1000;
      case 'day':    return value * 24 * 60 * 60 * 1000;
      default: return 0;
    }
  }

  log.warn(`Could not parse duration: ${duration}`);
  return 0;
}

export async function handleDelay(
  step: WorkflowStep,
  config: Record<string, unknown>
): Promise<StepResult> {
  try {
    const { delayType, delayValue, duration, dateTime } = config;
    const delayValueToUse = (duration || delayValue) as string | undefined;
    const typeToUse = String(delayType ?? 'duration');

    let resumeAt: Date | null = null;

    if ((typeToUse === 'until' || step.actionType === 'wait_until') && (delayValueToUse || dateTime)) {
      const rawDate = String(dateTime ?? delayValueToUse ?? '');
      const targetDate = new Date(rawDate);
      const now = new Date();
      if (targetDate.getTime() > now.getTime()) {
        resumeAt = targetDate;
      } else {
        // The target date is already in the past (e.g. the workflow was
        // configured with a fixed calendar date that has since elapsed, or
        // the execution was delayed significantly before reaching this step).
        // Skipping the delay rather than failing is intentional: halting the
        // workflow here would silently drop all subsequent actions, which is
        // more harmful than proceeding immediately. The surrounding log line
        // is info-level so operators can detect stale fixed-date nodes and
        // update them.
        log.info(`waitUntil target date is in the past (${targetDate.toISOString()}), skipping delay`);
      }
    } else if (typeToUse === 'duration' && delayValueToUse) {
      const delayMs = parseDuration(delayValueToUse);
      if (delayMs > 0) {
        resumeAt = new Date(Date.now() + delayMs);
      }
    } else {
      log.warn(`Delay node has no valid duration or dateTime configured — skipping`);
    }

    if (resumeAt) {
      log.info(`Suspending execution until ${resumeAt.toISOString()}`);
      return { success: true, suspend: true, resumeAt };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to execute delay',
    };
  }
}
