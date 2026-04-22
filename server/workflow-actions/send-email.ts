import { storage } from "../storage";
import { gmailService } from "../gmail-service";
import { replaceVariablesInObject } from "../utils/workflow/variable-replacer";
import { applyPostSendStatusUpdate } from "./helpers";
import type { ExecutionContext, StepResult } from "./types";
import { logger } from "../utils/logger";

const log = logger('WorkflowAction:SendEmail');

interface SendEmailConfig {
  to: string;
  subject: string;
  body: string;
  fromEmail?: string;
  updateStatus?: string;
}

function parseSendEmailConfig(raw: Record<string, unknown>): SendEmailConfig {
  return {
    to: String(raw.to ?? ''),
    subject: String(raw.subject ?? ''),
    body: String(raw.body ?? ''),
    fromEmail: raw.fromEmail != null ? String(raw.fromEmail) : undefined,
    updateStatus: raw.updateStatus != null ? String(raw.updateStatus) : undefined,
  };
}

export async function handleSendEmail(
  config: Record<string, unknown>,
  context: ExecutionContext
): Promise<StepResult> {
  try {
    const { to, subject, body, fromEmail } = parseSendEmailConfig(config);

    const processedTo = replaceVariablesInObject(to, context.variables) as string;
    const processedSubject = replaceVariablesInObject(subject, context.variables) as string;
    const processedBody = replaceVariablesInObject(body, context.variables) as string;
    const processedFromEmail = fromEmail
      ? replaceVariablesInObject(fromEmail, context.variables) as string
      : undefined;

    log.info(`Sending email (workflowId: ${context.workflowId}, executionId: ${context.executionId}, hasRecipient: ${!!processedTo})`);

    if (!processedTo || processedTo.trim() === '') {
      return {
        success: true,
        data: { skipped: true, reason: 'Contact has no email address' },
      };
    }

    // Validate that the resolved recipient is a syntactically valid email
    // address and contains no CRLF characters that could be used for header
    // injection.  The service layer strips CRLF as well, but rejecting here
    // makes the abuse visible in the workflow execution log.
    const crlfPattern = /[\r\n]/;
    if (crlfPattern.test(processedTo) || crlfPattern.test(processedSubject) || (processedFromEmail && crlfPattern.test(processedFromEmail))) {
      return {
        success: false,
        error: 'Email header values must not contain newline characters',
      };
    }
    // Validate each recipient in a comma-separated list (the contact-lookup
    // code below already splits on comma, so multi-recipient sends are valid).
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const recipients = processedTo.split(',').map((e: string) => e.trim()).filter(Boolean);
    const invalidRecipient = recipients.find((addr) => !emailPattern.test(addr));
    if (invalidRecipient) {
      return {
        success: false,
        error: `Invalid recipient email address: ${invalidRecipient}`,
      };
    }

    const creator = await storage.getUser(context.workflowCreatorId);
    if (!creator || creator.contractorId !== context.contractorId) {
      return { success: false, error: 'Workflow creator not found' };
    }

    let refreshToken: string;
    let senderEmail: string | undefined;
    let senderName: string;

    if (creator.gmailRefreshToken) {
      refreshToken = creator.gmailRefreshToken;
      senderEmail = processedFromEmail;
      senderName = creator.name;
    } else {
      const sharedAccount = await storage.getSharedEmailAccount(context.contractorId);
      if (sharedAccount) {
        refreshToken = sharedAccount.gmailRefreshToken;
        senderEmail = sharedAccount.email;
        senderName = sharedAccount.displayName || creator.name;
        log.info(`Workflow creator ${creator.name} has no Gmail — falling back to shared company email ${sharedAccount.email}`);
      } else {
        return {
          success: false,
          error: `Workflow creator ${creator.name} has not connected their Gmail account and no shared company email is configured`,
        };
      }
    }

    const result = await gmailService.sendEmail({
      to: processedTo,
      subject: processedSubject,
      content: processedBody,
      refreshToken,
      fromEmail: senderEmail,
      fromName: senderName,
    });

    if (!result.success) {
      return { success: false, error: result.error || 'Failed to send email' };
    }

    // The email was sent successfully. Now attempt to persist an activity record
    // so it appears in the contact's history. This is best-effort: a DB failure
    // here must NOT mark the step as failed (the email was already delivered).
    // Instead, record a saveWarning in the returned data so the workflow
    // execution audit log captures it for operator review.
    let saveWarning: string | undefined;
    try {
      const emails = processedTo.split(',').map((e: string) => e.trim());
      let contactId: string | null = context.contactId ?? null;

      if (!contactId) {
        for (const email of emails) {
          const matchedContactId = await storage.findMatchingContact(context.contractorId, [email], []);
          if (matchedContactId) {
            contactId = matchedContactId;
            break;
          }
        }
      }

      await storage.createActivity(
        {
          type: 'email',
          title: `Email sent: ${processedSubject}`,
          content: processedBody,
          metadata: {
            subject: processedSubject,
            to: [processedTo],
            from: senderEmail || processedFromEmail || creator.email,
            messageId: result.messageId,
            // RFC822 Message-Id header — used to thread inbound replies back
            // to this contact even when the reply comes from an unknown
            // sender address (spouse, phone, alias, etc.).
            rfc822MessageId: result.rfc822MessageId,
            direction: 'outbound',
          },
          contactId,
          userId: context.workflowCreatorId,
          // Persist the Gmail message id as externalId/externalSource so:
          //   1. The next Gmail sync run dedups against this row instead of
          //      inserting a second activity for the same outbound email.
          //   2. The frontend ActivityList drops it from the non-message stream
          //      (its dedup contract: any email activity surfaced via the
          //      conversations stream MUST have externalId set).
          externalId: result.messageId ?? null,
          externalSource: 'gmail',
        },
        context.contractorId
      );

      log.info(`Saved email to activities (contactId: ${contactId})`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      saveWarning = `Failed to save activity record: ${msg}`;
      log.error('Failed to save email to activities — email was sent but will not appear in contact history', { error });
    }

    saveWarning = await applyPostSendStatusUpdate(config, context, saveWarning);

    return {
      success: true,
      data: { contactId: context.contactId, subject: processedSubject, messageId: result.messageId, ...(saveWarning ? { saveWarning } : {}) },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send email',
    };
  }
}
