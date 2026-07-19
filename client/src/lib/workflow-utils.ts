import { Node } from 'reactflow';

/**
 * Maps an entity type key to a plain-language label.
 * The optional `terminology` object allows tenant-specific label overrides
 * (e.g. "Lead" → "Client") set via the TerminologyContext.
 */
export function getEntityLabel(
  entity: string,
  terminology?: { leadLabel?: string; estimateLabel?: string; jobLabel?: string } | null
): string {
  if (terminology) {
    switch (entity) {
      case 'lead':     return terminology.leadLabel     || 'Lead';
      case 'estimate': return terminology.estimateLabel || 'Estimate';
      case 'job':      return terminology.jobLabel      || 'Job';
      case 'customer': return 'Customer';
    }
  }
  return entity.charAt(0).toUpperCase() + entity.slice(1);
}

/**
 * Build the human-readable trigger label shown on the trigger node.
 * e.g. buildTriggerLabel('lead', 'status_changed', 'won') → "When Lead Status Changes to Won"
 */
export function buildTriggerLabel(
  entityType: string,
  eventType: string,
  targetStatus?: string,
  terminology?: { leadLabel?: string; estimateLabel?: string; jobLabel?: string } | null
): string {
  const entityLabel = getEntityLabel(entityType, terminology);
  if (eventType === 'status_changed' && targetStatus) {
    const statusLabel = targetStatus.replace('_', ' ');
    return `When ${entityLabel} Status Changes to ${statusLabel.charAt(0).toUpperCase() + statusLabel.slice(1)}`;
  }
  if (eventType === 'created')  return `When ${entityLabel} is Created`;
  if (eventType === 'updated')  return `When ${entityLabel} is Updated`;
  if (eventType === 'deleted')  return `When ${entityLabel} is Deleted`;
  if (eventType === 'reply_received') return `When ${entityLabel} Reply Received (SMS/Email)`;
  return `When ${entityLabel} ${eventType}`;
}

export function extractTriggerConfig(nodes: Node[]): { triggerType: string; triggerConfig: Record<string, unknown> } {
  const triggerNode = nodes.find(n => n.type === 'trigger');
  const triggerData = triggerNode?.data || {};
  const triggerType: string = triggerData.triggerType || 'manual';
  let triggerConfig: Record<string, unknown> = {};

  if (triggerType === 'entity_event') {
    const entityType = triggerData.entityType || triggerData.entity || 'lead';
    const eventType = triggerData.event || triggerData.eventType || 'created';
    triggerConfig = {
      entity: entityType,
      event: eventType,
      ...(eventType === 'status_changed' && triggerData.targetStatus && { targetStatus: triggerData.targetStatus }),
      ...(triggerData.tags && (triggerData.tags as unknown[]).length > 0 && { tags: triggerData.tags }),
      ...(eventType === 'stale' && triggerData.staleDays && { staleDays: Number(triggerData.staleDays) }),
    };
  } else if (triggerType === 'time_based') {
    triggerConfig = {
      schedule: triggerData.schedule || 'daily',
      time: triggerData.time || '09:00',
    };
  } else {
    triggerConfig = { entity: triggerData.entity || triggerData.entityType || 'lead' };
  }

  let backendTriggerType = triggerType;
  if (triggerType === 'entity_event') {
    const eventType = triggerData.event || triggerData.eventType || 'created';
    const eventTypeMap: Record<string, string> = {
      created: 'entity_created',
      updated: 'entity_updated',
      status_changed: 'status_changed',
      deleted: 'entity_updated',
      option_approved: 'estimate_option_approved',
      option_rejected: 'estimate_option_rejected',
      stale: 'estimate_stale',
      payment_received: 'payment_received',
      deposit_received: 'deposit_received',
    };
    if (eventType === 'reply_received') {
      const entity = triggerData.entityType || triggerData.entity || 'lead';
      backendTriggerType = `${entity}_reply_received`;
    } else {
      backendTriggerType = eventTypeMap[eventType] || 'entity_created';
    }
  }

  return { triggerType: backendTriggerType, triggerConfig };
}

export const NODE_ACTION_MAP: [nodeType: string, actionType: string][] = [
  ['trigger',      'trigger'],
  ['sendEmail',    'send_email'],
  ['sendSMS',      'send_sms'],
  ['notification', 'create_notification'],
  ['updateEntity', 'update_entity'],
  ['assignUser',   'assign_user'],
  ['setFollowUp',  'set_follow_up'],
  ['conditional',  'conditional_branch'],
  ['delay',        'delay'],
  ['waitUntil',    'wait_until'],
];

export const NODE_TO_ACTION = Object.fromEntries(NODE_ACTION_MAP);
export const ACTION_TO_NODE = Object.fromEntries(NODE_ACTION_MAP.map(([n, a]) => [a, n]));
