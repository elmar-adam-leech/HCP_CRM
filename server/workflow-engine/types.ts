export type { ExecutionContext, StepResult } from "../workflow-actions/types";

export interface StepLog {
  stepId: string;
  /**
   * The React Flow nodeId stamped on the step at design time. Persisted in the
   * log so resume paths can reconstruct branch-gating decisions without having
   * to load the original step row (which may not be in the resume slice).
   */
  nodeId?: string;
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
