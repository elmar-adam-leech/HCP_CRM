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

/**
 * Dependencies for resolveDefaultFromNumber — injectable for unit tests.
 */
export interface DefaultFromNumberDeps {
  getActiveSmsProvider: (contractorId: string) => Promise<string>;
  getTwilioNumber: (contractorId: string, phoneNumber: string) => Promise<unknown | undefined>;
  getContractor: (contractorId: string) => Promise<{ defaultTwilioNumber?: string | null; defaultDialpadNumber?: string | null } | undefined>;
}

/**
 * Creator's own saved defaults, one per provider. Sourced from the
 * contractor-scoped membership row (`user_contractors`) so multi-company
 * users get the right default for THIS company.
 */
export interface CreatorDefaults {
  dialpadDefault?: string | null;
  twilioDefault?: string | null;
}

const realDeps: DefaultFromNumberDeps = {
  getActiveSmsProvider: (contractorId) => providerService.getActiveProviderName(contractorId, 'sms'),
  getTwilioNumber: (contractorId, phoneNumber) => storage.getTwilioPhoneNumberByNumber(contractorId, phoneNumber),
  getContractor: (contractorId) => storage.getContractor(contractorId),
};

/**
 * Resolve the default "From" number for a workflow SMS step when the node
 * doesn't specify one. Provider-aware (task #902): the default is validated
 * against the tenant's ACTIVE SMS provider so a Twilio-only tenant no longer
 * fails just because the creator's saved default is a Dialpad number (or
 * vice versa).
 *
 * Resolution order:
 *  - Twilio active:  creator default IF it exists in the tenant's Twilio
 *    numbers → org `defaultTwilioNumber` → error.
 *  - Dialpad active: creator default (unvalidated — preserves pre-#902
 *    behavior for existing Dialpad workflows) → org `defaultDialpadNumber`
 *    → error.
 *  - Other provider: creator default → error.
 */
export async function resolveDefaultFromNumber(
  contractorId: string,
  creatorDefaults: CreatorDefaults,
  deps: DefaultFromNumberDeps = realDeps,
): Promise<{ fromNumber: string } | { error: string }> {
  let provider: string;
  try {
    provider = await deps.getActiveSmsProvider(contractorId);
  } catch (err) {
    return {
      error: err instanceof Error
        ? err.message
        : 'No enabled SMS provider found for this company.',
    };
  }

  if (provider === 'twilio') {
    if (creatorDefaults.twilioDefault) {
      const owned = await deps.getTwilioNumber(contractorId, creatorDefaults.twilioDefault);
      if (owned) return { fromNumber: creatorDefaults.twilioDefault };
    }
    const contractor = await deps.getContractor(contractorId);
    if (contractor?.defaultTwilioNumber) {
      return { fromNumber: contractor.defaultTwilioNumber };
    }
    return {
      error: 'No "From" phone number is configured on this SMS step. Please edit the workflow node and select a phone number, or set a default Twilio number in Settings.',
    };
  }

  const creatorDefault = creatorDefaults.dialpadDefault;
  if (creatorDefault) return { fromNumber: creatorDefault };

  if (provider === 'dialpad') {
    const contractor = await deps.getContractor(contractorId);
    if (contractor?.defaultDialpadNumber) {
      return { fromNumber: contractor.defaultDialpadNumber };
    }
  }

  return {
    error: 'No "From" phone number is configured on this SMS step. Please edit the workflow node and select a phone number.',
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

      // Creator defaults are per-contractor (user_contractors), so a
      // multi-company creator gets the right default for THIS company.
      // Legacy users.dialpadDefaultNumber remains a fallback for old rows.
      const membership = await storage.getUserContractor(context.workflowCreatorId, context.contractorId);
      const resolved = await resolveDefaultFromNumber(context.contractorId, {
        dialpadDefault: membership?.dialpadDefaultNumber ?? creator.dialpadDefaultNumber,
        twilioDefault: membership?.twilioDefaultNumber,
      });
      if ('error' in resolved) {
        return { success: false, error: resolved.error };
      }
      processedFromNumber = resolved.fromNumber;
      log.info(`SMS: fromNumber not set on node — resolved provider-aware default (workflowId: ${context.workflowId})`);
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
      data: {
        contactId: resolvedContactId,
        messageId: result.messageId,
        // Task #905: record which numbers were actually used so the
        // execution step timeline can show "From … → To …".
        fromNumber: processedFromNumber,
        toNumber: processedTo,
        ...(saveWarning ? { saveWarning } : {}),
      },
    };

  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send SMS',
    };
  }
}
