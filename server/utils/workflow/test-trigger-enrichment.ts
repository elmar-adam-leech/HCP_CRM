/**
 * Hydrate a manual workflow Test-run trigger payload from the database so it
 * matches what a live trigger event would produce. Extracted from the
 * /api/workflows/:id/execute handler so it can be unit-tested against a fake
 * storage layer (see test-trigger-enrichment.test.ts).
 *
 * The shape we mirror is `toWorkflowEvent(entity)` from entity-adapter.ts:
 *   - lead/contact/customer triggers → the contact row (where tags, phones,
 *     statuses live, and what the condition evaluator reads from)
 *   - estimate triggers → the estimate row
 *   - job triggers → the job row
 *
 * The lookup is forgiving: passing a contact UUID with entityType='lead' or
 * a lead UUID with entityType='contact' both resolve, because the picker UX
 * doesn't require the operator to know which underlying table to point at.
 */
export interface TriggerEnrichmentStorage {
  getContact(id: string, contractorId: string): Promise<Record<string, unknown> | undefined>;
  getLead(id: string, contractorId: string): Promise<(Record<string, unknown> & { contactId?: string | null }) | undefined>;
  getEstimate(id: string, contractorId: string): Promise<Record<string, unknown> | undefined>;
  getJob(id: string, contractorId: string): Promise<Record<string, unknown> | undefined>;
}

export async function enrichTestTriggerData(
  triggerData: Record<string, unknown>,
  contractorId: string,
  storage: TriggerEnrichmentStorage,
): Promise<Record<string, unknown>> {
  const lookupId = triggerData.id ?? triggerData.entityId;
  if (!lookupId) return triggerData;

  const entityType = (triggerData.entityType as string | undefined) || 'lead';
  const id = String(lookupId);

  if (entityType === 'contact' || entityType === 'lead' || entityType === 'customer') {
    const contact = await storage.getContact(id, contractorId);
    if (contact) return { ...triggerData, ...contact };
    const lead = await storage.getLead(id, contractorId);
    if (lead) {
      const contactRecord = lead.contactId
        ? await storage.getContact(String(lead.contactId), contractorId)
        : undefined;
      return contactRecord
        ? { ...triggerData, ...contactRecord }
        : { ...triggerData, ...lead };
    }
    return triggerData;
  }

  if (entityType === 'estimate') {
    const estimate = await storage.getEstimate(id, contractorId);
    return estimate ? { ...triggerData, ...estimate } : triggerData;
  }
  if (entityType === 'job') {
    const job = await storage.getJob(id, contractorId);
    return job ? { ...triggerData, ...job } : triggerData;
  }
  return triggerData;
}
