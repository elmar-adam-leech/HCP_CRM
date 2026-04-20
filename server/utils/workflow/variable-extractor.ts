/**
 * Variable extraction utility for workflow automation
 * Extracts all available fields from trigger entities (leads, estimates, jobs, customers)
 */

import type { KnownEntityType } from "./entity-resolver";

type ExtractableEntityType = KnownEntityType | 'customer';

const EXTRACTABLE_ENTITY_TYPES: readonly string[] = ['lead', 'estimate', 'job', 'customer'];

function isExtractableEntityType(value: string): value is ExtractableEntityType {
  return EXTRACTABLE_ENTITY_TYPES.includes(value);
}

export interface EntityVariable {
  key: string;
  label: string;
  type: 'string' | 'number' | 'date' | 'boolean' | 'array';
  example?: string;
}

export interface EntityVariables {
  entity: string;
  variables: EntityVariable[];
  contactVariables?: EntityVariable[];
}

/**
 * Contact variables shared across entities that reference contacts
 */
const contactVariables: EntityVariable[] = [
  { key: 'contact.name', label: 'Contact Name', type: 'string', example: 'John Doe' },
  { key: 'contact.emails', label: 'Contact Email', type: 'array', example: 'john@example.com' },
  { key: 'contact.phones', label: 'Contact Phone', type: 'array', example: '(555) 123-4567' },
  { key: 'contact.address', label: 'Contact Address', type: 'string', example: '123 Main St' },
  { key: 'contact.type', label: 'Contact Type', type: 'string', example: 'lead' },
  { key: 'contact.status', label: 'Contact Status', type: 'string', example: 'new' },
  { key: 'contact.source', label: 'Contact Source', type: 'string', example: 'website' },
  { key: 'contact.notes', label: 'Contact Notes', type: 'string', example: 'Interested in HVAC' },
  { key: 'contact.tags', label: 'Contact Tags', type: 'array', example: 'VIP, repeat' },
];

/**
 * Get all available variables for a given entity type
 */
export function getEntityVariables(entityType: 'lead' | 'estimate' | 'job' | 'customer'): EntityVariables {
  const baseVariables: EntityVariable[] = [
    { key: 'id', label: 'ID', type: 'string', example: 'abc-123' },
    { key: 'createdAt', label: 'Created Date', type: 'date', example: '2025-01-15' },
  ];

  switch (entityType) {
    case 'lead':
      return {
        entity: 'lead',
        variables: [
          ...baseVariables,
          { key: 'name', label: 'Name', type: 'string', example: 'John Doe' },
          { key: 'emails', label: 'Email Addresses', type: 'array', example: 'john@example.com' },
          { key: 'phones', label: 'Phone Numbers', type: 'array', example: '(555) 123-4567' },
          { key: 'address', label: 'Address', type: 'string', example: '123 Main St' },
          { key: 'type', label: 'Type', type: 'string', example: 'lead' },
          { key: 'status', label: 'Status', type: 'string', example: 'new' },
          { key: 'source', label: 'Source', type: 'string', example: 'website' },
          { key: 'notes', label: 'Notes', type: 'string', example: 'Interested in HVAC installation' },
          { key: 'tags', label: 'Tags', type: 'array', example: 'VIP, repeat' },
          { key: 'followUpDate', label: 'Follow-up Date', type: 'date', example: '2025-02-01' },
          { key: 'booking_link', label: 'Booking Link', type: 'string', example: 'https://yoursite.com/book/my-company?contact=abc-123' },
        ],
      };

    case 'estimate':
      return {
        entity: 'estimate',
        variables: [
          ...baseVariables,
          { key: 'title', label: 'Title', type: 'string', example: 'HVAC Installation Quote' },
          { key: 'description', label: 'Description', type: 'string', example: 'Full system installation' },
          { key: 'amount', label: 'Amount', type: 'string', example: '5000.00' },
          { key: 'status', label: 'Status', type: 'string', example: 'sent' },
          { key: 'validUntil', label: 'Valid Until', type: 'date', example: '2025-02-15' },
          { key: 'followUpDate', label: 'Follow-up Date', type: 'date', example: '2025-01-20' },
          { key: 'contactId', label: 'Contact ID', type: 'string', example: 'contact-789' },
          { key: 'booking_link', label: 'Booking Link', type: 'string', example: 'https://yoursite.com/book/my-company?contact=contact-789' },
        ],
        contactVariables,
      };

    case 'job':
      return {
        entity: 'job',
        variables: [
          ...baseVariables,
          { key: 'title', label: 'Title', type: 'string', example: 'HVAC Repair Service' },
          { key: 'type', label: 'Type', type: 'string', example: 'repair' },
          { key: 'status', label: 'Status', type: 'string', example: 'scheduled' },
          { key: 'priority', label: 'Priority', type: 'string', example: 'high' },
          { key: 'value', label: 'Value', type: 'string', example: '500.00' },
          { key: 'estimatedHours', label: 'Estimated Hours', type: 'number', example: '4' },
          { key: 'scheduledDate', label: 'Scheduled Date', type: 'date', example: '2025-01-18' },
          { key: 'contactId', label: 'Contact ID', type: 'string', example: 'contact-789' },
          { key: 'estimateId', label: 'Estimate ID', type: 'string', example: 'estimate-456' },
          { key: 'booking_link', label: 'Booking Link', type: 'string', example: 'https://yoursite.com/book/my-company?contact=contact-789' },
        ],
        contactVariables,
      };

    case 'customer':
      return {
        entity: 'customer',
        variables: [
          ...baseVariables,
          { key: 'name', label: 'Name', type: 'string', example: 'Jane Smith' },
          { key: 'emails', label: 'Email Addresses', type: 'array', example: 'jane@example.com' },
          { key: 'phones', label: 'Phone Numbers', type: 'array', example: '(555) 987-6543' },
          { key: 'address', label: 'Address', type: 'string', example: '456 Oak Ave' },
          { key: 'type', label: 'Type', type: 'string', example: 'customer' },
          { key: 'status', label: 'Status', type: 'string', example: 'active' },
          { key: 'source', label: 'Source', type: 'string', example: 'referral' },
          { key: 'notes', label: 'Notes', type: 'string', example: 'VIP customer' },
          { key: 'tags', label: 'Tags', type: 'array', example: 'VIP, repeat' },
        ],
      };

    default:
      return { entity: entityType, variables: baseVariables };
  }
}

/**
 * Extract variable values from an entity object with proper nested structure.
 * Handles both direct entity fields and nested contact fields.
 */
export async function extractVariablesFromEntity(entity: Record<string, unknown>, entityType: string, options?: { bookingBaseUrl?: string; contractorSlug?: string; contractorId?: string }): Promise<Record<string, unknown>> {
  const variables: Record<string, unknown> = {};
  const resolvedType: ExtractableEntityType = isExtractableEntityType(entityType) ? entityType : 'lead';
  const entityVars = getEntityVariables(resolvedType);

  for (const varDef of entityVars.variables) {
    const value = entity[varDef.key];
    
    if (varDef.type === 'array' && Array.isArray(value)) {
      if (varDef.key === 'tags') {
        // Tags render as a comma-separated list by default since users typically
        // want the full set in messages (e.g. "as a VIP, repeat customer...").
        variables[varDef.key] = value.join(', ');
        variables[`${varDef.key}_all`] = value.join(', ');
      } else {
        variables[varDef.key] = value.length > 0 ? value[0] : '';
        variables[`${varDef.key}_all`] = value.join(', ');
      }
    } 
    else if (varDef.type === 'date' && value) {
      variables[varDef.key] = value instanceof Date ? value.toISOString() : value;
    }
    else {
      variables[varDef.key] = value ?? '';
    }
  }

  if (options?.bookingBaseUrl) {
    // Prefer the short bookingCode on the contact/lead entity itself.
    // For estimates/jobs we need to look at the nested entity.contact.bookingCode.
    let bookingCode = (resolvedType === 'lead' || resolvedType === 'customer')
      ? (entity.bookingCode as string | undefined)
      : ((entity.contact as Record<string, unknown> | undefined)?.bookingCode as string | undefined);

    // Lazy migration: if the entity doesn't have a bookingCode yet, generate one and persist it
    if (!bookingCode && options?.contractorId) {
      const contactIdForLazy = (resolvedType === 'lead' || resolvedType === 'customer')
        ? (entity.id as string | undefined)
        : (entity.contactId as string | undefined);
      if (contactIdForLazy) {
        try {
          const { storage } = await import("../../storage");
          const { generateBookingCode } = await import("../booking-token");
          const newCode = generateBookingCode();
          const updated = await storage.updateContact(contactIdForLazy, { bookingCode: newCode }, options.contractorId);
          bookingCode = updated?.bookingCode ?? newCode;
        } catch { /* non-fatal: fall through to contactId fallback */ }
      }
    }

    if (bookingCode) {
      variables.booking_link = `${options.bookingBaseUrl}?c=${bookingCode}`;
    } else {
      // Final fallback for contacts that still have no bookingCode
      const contactIdForBooking = (resolvedType === 'lead' || resolvedType === 'customer')
        ? (entity.id as string | undefined)
        : (entity.contactId as string | undefined);
      variables.booking_link = contactIdForBooking
        ? `${options.bookingBaseUrl}?contactId=${contactIdForBooking}`
        : '';
    }
  } else {
    variables.booking_link = '';
  }

  // Derive condition-friendly scalar fields from nested objects (#437).
  // These give workflow authors clean comparison fields like
  // estimate.option_count, job.paid_amount, job.payment_method, job.is_deposit.
  if (resolvedType === 'estimate') {
    const options = (entity as any).options;
    if (Array.isArray(options)) {
      variables.option_count = options.length;
    }
    const salesperson = (entity as any).salesperson;
    if (salesperson && typeof salesperson === 'object') {
      // Allow conditions to compare against the salesperson's name or id easily.
      variables.salesperson_name = (salesperson as any).name ?? '';
      variables.salesperson_id = (salesperson as any).id ?? '';
    }
  }
  if (resolvedType === 'job') {
    const payment = (entity as any).payment;
    if (payment && typeof payment === 'object') {
      variables.paid_amount = (payment as any).amount ?? '';
      variables.payment_method = (payment as any).method ?? '';
      variables.is_deposit = Boolean((payment as any).is_deposit);
    }
  }

  // Surface nested objects added by HCP-driven triggers (#437) so templates
  // can use {{estimate.salesperson.name}}, {{estimate.approved_option.name}},
  // {{job.payment.amount}}, {{estimate.line_items}}, etc.
  for (const passthroughKey of ['salesperson', 'approved_option', 'rejected_option', 'payment', 'line_items'] as const) {
    const value = (entity as Record<string, unknown>)[passthroughKey];
    if (value !== undefined && value !== null) {
      if (passthroughKey === 'line_items' && Array.isArray(value)) {
        // Render line items as a human-readable list for direct {{line_items}} usage,
        // and also expose the raw array under {{line_items_raw}} for advanced use.
        const lines = value.map((li: any) => {
          const name = li?.name || li?.description || 'Item';
          const qty = li?.quantity != null ? `${li.quantity} x ` : '';
          const cents = typeof li?.unit_price === 'number'
            ? li.unit_price
            : (typeof li?.amount === 'number' ? li.amount : undefined);
          const price = cents != null ? ` - $${(cents / 100).toFixed(2)}` : '';
          return `${qty}${name}${price}`;
        });
        variables.line_items = lines.join('\n');
        variables.line_items_raw = value;
      } else {
        variables[passthroughKey] = value;
      }
    }
  }

  if (entityVars.contactVariables && entity.contact) {
    const contact = entity.contact as Record<string, unknown>;
    const contactData: Record<string, unknown> = {};
    
    for (const varDef of entityVars.contactVariables) {
      const contactKey = varDef.key.replace('contact.', '');
      const value = contact[contactKey];
      
      if (varDef.type === 'array' && Array.isArray(value)) {
        if (contactKey === 'tags') {
          contactData[contactKey] = value.join(', ');
          contactData[`${contactKey}_all`] = value.join(', ');
        } else {
          contactData[contactKey] = value.length > 0 ? value[0] : '';
          contactData[`${contactKey}_all`] = value.join(', ');
        }
      } 
      else if (varDef.type === 'date' && value) {
        contactData[contactKey] = value instanceof Date ? value.toISOString() : value;
      }
      else {
        contactData[contactKey] = value ?? '';
      }
    }
    
    variables.contact = contactData;
  }

  return variables;
}
