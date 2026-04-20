export type { ExecutionContext, StepResult } from "../workflow-actions/types";

export interface StepLog {
  stepId: string;
  stepOrder: number;
  actionType: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: 'success' | 'failed' | 'skipped';
  result?: unknown;
  error?: string;
}

export type StepGroupOutcome =
  | { kind: 'completed' }
  | { kind: 'suspended'; stepOrder: number; resumeAt: Date }
  | { kind: 'failed'; errorMessages: string }
  | { kind: 'cancelled' };
