import type { Node, Edge } from 'reactflow';

export type WorkflowTemplate = {
  id: string;
  name: string;
  description: string;
  category: 'sales' | 'service' | 'follow-up';
  nodes: Node[];
  edges: Edge[];
};

export const workflowTemplates: WorkflowTemplate[] = [
  {
    id: 'estimate-follow-up',
    name: 'Estimate Follow-up',
    description: 'Automatically follow up with customers who haven\'t responded to estimates within 3 days',
    category: 'follow-up',
    nodes: [
      {
        id: 'trigger-1',
        type: 'trigger',
        position: { x: 250, y: 50 },
        data: {
          label: 'Estimate Created',
          triggerType: 'entity_event',
          entityType: 'estimate',
          event: 'created',
        },
      },
      {
        id: 'delay-1',
        type: 'delay',
        position: { x: 250, y: 180 },
        data: {
          duration: '3 days',
        },
      },
      {
        id: 'condition-1',
        type: 'conditional',
        position: { x: 250, y: 310 },
        data: {
          condition: 'Estimate status = pending',
        },
      },
      {
        id: 'email-1',
        type: 'sendEmail',
        position: { x: 250, y: 450 },
        data: {
          to: '{{customer.email}}',
          subject: 'Following up on your estimate',
        },
      },
    ],
    edges: [
      { id: 'e1-2', source: 'trigger-1', target: 'delay-1', animated: true },
      { id: 'e2-3', source: 'delay-1', target: 'condition-1' },
      {
        id: 'e3-4',
        source: 'condition-1',
        target: 'email-1',
        sourceHandle: 'true',
        label: 'Still Pending',
        type: 'smoothstep',
      },
    ],
  },
  {
    id: 'lead-nurturing',
    name: 'Lead Nurturing Sequence',
    description: 'Automated nurturing sequence for new leads',
    category: 'sales',
    nodes: [
      {
        id: 'trigger-1',
        type: 'trigger',
        position: { x: 250, y: 50 },
        data: {
          label: 'New Lead Created',
          triggerType: 'entity_event',
          entityType: 'lead',
          event: 'created',
        },
      },
      {
        id: 'assign-1',
        type: 'assignUser',
        position: { x: 250, y: 180 },
        data: {
          field: 'assignedTo',
          value: 'auto-assign-sales',
        },
      },
      {
        id: 'notification-1',
        type: 'notification',
        position: { x: 250, y: 310 },
        data: {
          title: 'New lead assigned',
          message: 'Lead {{lead.name}} has been assigned to you',
        },
      },
      {
        id: 'delay-1',
        type: 'delay',
        position: { x: 250, y: 440 },
        data: {
          duration: '2 hours',
        },
      },
      {
        id: 'email-1',
        type: 'sendEmail',
        position: { x: 250, y: 570 },
        data: {
          to: '{{lead.email}}',
          subject: 'Thanks for your interest',
        },
      },
    ],
    edges: [
      { id: 'e1-2', source: 'trigger-1', target: 'assign-1', animated: true },
      { id: 'e2-3', source: 'assign-1', target: 'notification-1' },
      { id: 'e3-4', source: 'notification-1', target: 'delay-1' },
      { id: 'e4-5', source: 'delay-1', target: 'email-1' },
    ],
  },
  {
    id: 'job-completion',
    name: 'Job Completion Follow-up',
    description: 'Request reviews and feedback after job completion',
    category: 'service',
    nodes: [
      {
        id: 'trigger-1',
        type: 'trigger',
        position: { x: 250, y: 50 },
        data: {
          label: 'Job Completed',
          triggerType: 'entity_event',
          entityType: 'job',
          event: 'status_changed',
          statusValue: 'completed',
        },
      },
      {
        id: 'update-1',
        type: 'updateEntity',
        position: { x: 250, y: 180 },
        data: {
          entityType: 'job',
          field: 'followUpSent',
          value: 'true',
        },
      },
      {
        id: 'delay-1',
        type: 'delay',
        position: { x: 250, y: 310 },
        data: {
          duration: '1 day',
        },
      },
      {
        id: 'email-1',
        type: 'sendEmail',
        position: { x: 250, y: 440 },
        data: {
          to: '{{customer.email}}',
          subject: 'How was your experience?',
        },
      },
      {
        id: 'delay-2',
        type: 'delay',
        position: { x: 250, y: 570 },
        data: {
          duration: '5 days',
        },
      },
      {
        id: 'condition-1',
        type: 'conditional',
        position: { x: 250, y: 700 },
        data: {
          condition: 'Review submitted = false',
        },
      },
      {
        id: 'sms-1',
        type: 'sendSMS',
        position: { x: 100, y: 840 },
        data: {
          to: '{{customer.phone}}',
          message: 'Quick reminder: we\'d love to hear your feedback!',
        },
      },
    ],
    edges: [
      { id: 'e1-2', source: 'trigger-1', target: 'update-1', animated: true },
      { id: 'e2-3', source: 'update-1', target: 'delay-1' },
      { id: 'e3-4', source: 'delay-1', target: 'email-1' },
      { id: 'e4-5', source: 'email-1', target: 'delay-2' },
      { id: 'e5-6', source: 'delay-2', target: 'condition-1' },
      {
        id: 'e6-7',
        source: 'condition-1',
        target: 'sms-1',
        sourceHandle: 'true',
        label: 'No Review',
        type: 'smoothstep',
      },
    ],
  },
];
