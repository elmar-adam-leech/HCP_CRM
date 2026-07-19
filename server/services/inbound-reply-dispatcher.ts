import { storage } from "../storage";
import { workflowEngine } from "../workflow-engine";
import { logger } from "../utils/logger";
import { toWorkflowEvent } from "../utils/workflow/entity-adapter";

const log = logger('InboundReplyDispatcher');

export interface InboundReplyParams {
  contractorId: string;
  contactId?: string;
  leadId?: string;
  estimateId?: string;
  jobId?: string;
  content: string;
  fromNumber?: string;
  toNumber?: string;
  type: 'text' | 'email';
  messageId?: string;
  receivedAt?: Date;
  sourceIntegration: string;
  userIdForActivity?: string | null;
}

/**
 * Dispatch reply_received workflow triggers for inbound SMS/email.
 * Gates to only contacts that already have current lead/estimate/job.
 * Prefers direct ids on the inbound record for performance.
 * Enriches with assigned user details and sourceIntegration.
 */
export async function dispatchInboundReplyWorkflows(params: InboundReplyParams): Promise<void> {
  const {
    contractorId,
    contactId,
    leadId: directLeadId,
    estimateId: directEstimateId,
    jobId: directJobId,
    content,
    fromNumber,
    toNumber,
    type,
    messageId,
    receivedAt,
    sourceIntegration,
  } = params;

  const reply = {
    content,
    fromNumber,
    toNumber,
    type,
    receivedAt: receivedAt || new Date(),
    messageId,
    sourceIntegration,
  };

  // Resolve current entities, preferring direct ids from the inbound record (messages now carry lead/job/estimate)
  let fired = false;

  // LEAD
  let leadId = directLeadId;
  if (!leadId && contactId) {
    try {
      const leads = await storage.getLeadsByContact(contactId, contractorId);
      const openLead = leads.find((l: any) => !l.archived && ['new', 'contacted', 'qualified'].includes(l.status));
      if (openLead) leadId = openLead.id;
    } catch (e) {
      log.error('Failed to resolve lead for reply', e);
    }
  }
  if (leadId) {
    try {
      const lead = await storage.getLead(leadId, contractorId);
      if (lead) {
        const contact = lead.contactId ? await storage.getContact(lead.contactId, contractorId) : undefined;
        const payload: Record<string, unknown> = {
          ...(contact || {}),
          ...lead,
          type: (contact as any)?.type || 'lead',
          assignedToUserId: lead.assignedToUserId,
          reply,
          sourceIntegration,
        };
        if (lead.assignedToUserId) {
          const user = await storage.getUser(lead.assignedToUserId);
          const uc = await storage.getUserContractor(lead.assignedToUserId, contractorId);
          payload.assignedUser = {
            id: lead.assignedToUserId,
            name: user?.name,
            email: user?.email,
            phone: uc?.twilioPhoneToRing || null,
          };
        }
        workflowEngine.triggerWorkflowsForEvent('lead_reply_received', toWorkflowEvent(payload), contractorId).catch((err) =>
          log.error('lead_reply_received trigger failed', err)
        );
        fired = true;
      }
    } catch (e) {
      log.error('Error dispatching lead_reply_received', e);
    }
  }

  // ESTIMATE
  let estimateId = directEstimateId;
  if (!estimateId && contactId) {
    try {
      const ests = await storage.getEstimatesByContact(contactId, contractorId);
      if (ests && ests.length > 0) estimateId = ests[0].id;
    } catch (e) {
      log.error('Failed to resolve estimate for reply', e);
    }
  }
  if (estimateId) {
    try {
      const est = await storage.getEstimateWithContact(estimateId, contractorId);
      if (est) {
        const payload: Record<string, unknown> = {
          ...est,
          reply,
          sourceIntegration,
        };
        if ((est as any).salespersonUserId) {
          const spId = (est as any).salespersonUserId;
          const user = await storage.getUser(spId);
          const uc = await storage.getUserContractor(spId, contractorId);
          const sp = {
            id: spId,
            name: user?.name,
            email: user?.email,
            phone: uc?.twilioPhoneToRing || null,
          };
          payload.salesperson = { ...( (est as any).salesperson || {} ), ...sp };
          payload.assignedUser = sp;
        }
        workflowEngine.triggerWorkflowsForEvent('estimate_reply_received', toWorkflowEvent(payload), contractorId).catch((err) =>
          log.error('estimate_reply_received trigger failed', err)
        );
        fired = true;
      }
    } catch (e) {
      log.error('Error dispatching estimate_reply_received', e);
    }
  }

  // JOB
  let jobId = directJobId;
  if (!jobId && contactId) {
    try {
      const jobsList = await storage.getJobsByContact(contactId, contractorId);
      if (jobsList && jobsList.length > 0) jobId = jobsList[0].id;
    } catch (e) {
      log.debug('getJobsByContact failed or not available for reply context');
    }
  }
  if (jobId) {
    try {
      const job = await storage.getJobWithContact(jobId, contractorId);
      if (job) {
        const payload: Record<string, unknown> = {
          ...job,
          reply,
          sourceIntegration,
        };
        if ((job as any).salespersonUserId) {
          const spId = (job as any).salespersonUserId;
          const user = await storage.getUser(spId);
          const uc = await storage.getUserContractor(spId, contractorId);
          const sp = {
            id: spId,
            name: user?.name,
            email: user?.email,
            phone: uc?.twilioPhoneToRing || null,
          };
          payload.salesperson = { ...( (job as any).salesperson || {} ), ...sp };
          payload.assignedUser = sp;
        }
        workflowEngine.triggerWorkflowsForEvent('job_reply_received', toWorkflowEvent(payload), contractorId).catch((err) =>
          log.error('job_reply_received trigger failed', err)
        );
        fired = true;
      }
    } catch (e) {
      log.error('Error dispatching job_reply_received', e);
    }
  }

  if (fired) {
    log.info(`Dispatched reply workflow(s) for contact ${contactId} source=${sourceIntegration}`);
  }
}
