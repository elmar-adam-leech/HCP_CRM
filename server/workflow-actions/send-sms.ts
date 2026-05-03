import { storage } from "../storage";
import { providerService } from "../providers/provider-service";
import { broadcastToContractor } from "../websocket";
import { replaceVariablesInObject } from "../utils/workflow/variable-replacer";
import { applyPostSendStatusUpdate } from "./helpers";
import type { ExecutionContext, StepResult } from "./types";
import { normalizePhoneForStorage, normalizePhoneNumber } from "../utils/phone-normalizer";
import { logger } from "../utils/logger";

const log = logger('WorkflowAction:SendSMS');

interface SendSmsConfig {
  to: string;
  message: string;
  fromNumber?: string;
  updateStatus?: string;
  // Task #706: when true, mark the saved outbound message row with
  // is_scheduling_intent so the inbound SMS webhook knows to wake the AI
  // scheduling agent on any reply within the contractor's window.
  isSchedulingIntent?: boolean;
}

function parseSendSmsConfig(raw: Record<string, unknown>): SendSmsConfig {
  return {
    to: String(raw.to ?? ''),
    message: String(raw.message ?? ''),
    fromNumber: raw.fromNumber != null ? String(raw.fromNumber) : undefined,
    updateStatus: raw.updateStatus != null ? String(raw.updateStatus) : undefined,
    isSchedulingIntent: raw.isSchedulingIntent === true,
  };
}

export async function handleSendSMS(
  config: Record<string, unknown>,
  context: ExecutionContext
): Promise<StepResult> {
  try {
    const { to, message, fromNumber, isSchedulingIntent } = parseSendSmsConfig(config);

    const rawTo = replaceVariablesInObject(to, context.variables) as string;
    log.info(`[phone-pipeline] SMS step resolved {{phones}} variable to: "${rawTo}" (workflowId: ${context.workflowId})`);
    const processedMessage = replaceVariablesInObject(message, context.variables) as string;
    let processedFromNumber = fromNumber
      ? replaceVariablesInObject(fromNumber, context.variables) as string
      : undefined;

    if (!rawTo || !rawTo.trim()) {
      return {
        success: true,
        data: { skipped: true, reason: 'Contact has no phone number' },
      };
    }

    // Ensure the 'to' number is in E.164 format regardless of storage format.
    const processedTo = normalizePhoneNumber(rawTo.trim());
    log.info(`[phone-pipeline] SMS step 'to' after E.164 conversion: "${processedTo}" (workflowId: ${context.workflowId})`);

    if (!processedTo || !/^\+\d{11,15}$/.test(processedTo)) {
      log.warn(`[phone-pipeline] SMS step: could not convert "${rawTo}" to a valid E.164 number — aborting send`);
      return {
        success: false,
        error: `Cannot send SMS: phone number "${rawTo}" could not be converted to a valid E.164 format.`,
      };
    }

    if (!processedFromNumber) {
      const creator = await storage.getUser(context.workflowCreatorId);
      if (!creator || creator.contractorId !== context.contractorId) {
        return { success: false, error: 'Workflow creator not found' };
      }

      if (creator.dialpadDefaultNumber) {
        processedFromNumber = creator.dialpadDefaultNumber;
        log.info(`SMS: fromNumber not set on node — using creator's default number (workflowId: ${context.workflowId})`);
      } else {
        return {
          success: false,
          error: 'No "From" phone number is configured on this SMS step. Please edit the workflow node and select a Dialpad phone number.',
        };
      }
    }

    log.info(`Sending SMS (workflowId: ${context.workflowId}, executionId: ${context.executionId})`);

    const result = await providerService.sendSms({
      to: processedTo,
      message: processedMessage,
      fromNumber: processedFromNumber,
      contractorId: context.contractorId,
    });

    if (!result.success) {
      return { success: false, error: result.error || 'Failed to send SMS' };
    }

    // The SMS was sent successfully. Now attempt to persist a message record
    // so it appears in the conversation thread. This is best-effort: a DB
    // failure here must NOT mark the step as failed (the message was already
    // delivered). Instead, record a saveWarning in the returned data so the
    // workflow execution audit log captures it for operator review.

    // Determine which contact to attribute the message to.
    // Only use the trigger contact's ID if the processedTo number actually
    // belongs to them. If it doesn't, look up the real owner via findMatchingContact.
    let resolvedContactId: string | null = null;
    if (context.contactId) {
      const triggerContact = await storage.getContact(context.contactId, context.contractorId);
      const normalizedTo = processedTo.replace(/\D/g, '');
      const normalizedTo10 = normalizedTo.length > 10 ? normalizedTo.slice(-10) : normalizedTo;
      const contactOwnsNumber = triggerContact?.phones?.some(p => {
        const d = p.replace(/\D/g, '');
        const d10 = d.length > 10 ? d.slice(-10) : d;
        return d10 === normalizedTo10;
      }) ?? false;

      if (contactOwnsNumber) {
        resolvedContactId = context.contactId;
      } else {
        resolvedContactId = await storage.findMatchingContact(context.contractorId, [], [processedTo]);
      }
    } else {
      resolvedContactId = await storage.findMatchingContact(context.contractorId, [], [processedTo]);
    }

    let saveWarning: string | undefined;
    try {
      const msg = await storage.createMessage(
        {
          type: 'text',
          status: 'sent',
          direction: 'outbound',
          content: processedMessage,
          toNumber: normalizePhoneForStorage(processedTo),
          fromNumber: normalizePhoneForStorage(processedFromNumber),
          contactId: resolvedContactId,
          userId: context.workflowCreatorId,
          externalMessageId: result.messageId,
          isSchedulingIntent: isSchedulingIntent === true,
        },
        context.contractorId
      );

      log.info(`Saved SMS to messages (contactId: ${resolvedContactId}, messageId: ${msg.id})`);

      broadcastToContractor(context.contractorId, {
        type: 'new_message',
        message: msg,
        contactId: resolvedContactId,
        contactType: 'lead',
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      saveWarning = `Failed to save message record: ${msg}`;
      log.error('Failed to save SMS to messages — message was sent but will not appear in conversation thread', { error });
    }

    saveWarning = await applyPostSendStatusUpdate(config, context, saveWarning);

    return {
      success: true,
      data: { contactId: resolvedContactId, messageId: result.messageId, ...(saveWarning ? { saveWarning } : {}) },
    };

  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send SMS',
    };
  }
}
