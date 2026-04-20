import { storage } from "../storage";
import { replaceVariablesInObject } from "../utils/workflow/variable-replacer";
import type { ExecutionContext, StepResult } from "./types";
import { logger } from "../utils/logger";

const log = logger('WorkflowCreateNotification');

export async function handleCreateNotification(
  config: Record<string, unknown>,
  context: ExecutionContext
): Promise<StepResult> {
  try {
    const { userId, title, message } = config;

    const processedTitle = replaceVariablesInObject(String(title ?? ''), context.variables) as string;
    const processedMessage = replaceVariablesInObject(String(message ?? ''), context.variables) as string;

    log.info(`Creating notification for user ${userId}: ${processedTitle}`);

    await storage.createNotification(
      {
        userId: String(userId ?? ''),
        title: processedTitle,
        message: processedMessage,
        type: 'system',
        read: false,
      },
      context.contractorId
    );

    return { success: true, data: { userId, title: processedTitle } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create notification',
    };
  }
}
