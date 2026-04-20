import { describe, it, expect } from 'vitest';
import { enrichTestTriggerData, type TriggerEnrichmentStorage } from './test-trigger-enrichment';

const CONTRACTOR = 'c1';

const contactRow = {
  id: 'contact-1',
  name: 'David J Sitzer',
  status: 'new',
  tags: ['VIP', 'Repeat'],
  emails: ['d@example.com'],
  phones: ['5555550000'],
};
const leadRow = {
  id: 'lead-1',
  contactId: 'contact-1',
  status: 'new',
  source: 'web',
};
const orphanLead = {
  id: 'lead-orphan',
  contactId: null,
  status: 'new',
};
const estimateRow = { id: 'est-1', title: 'Furnace replacement', status: 'sent' };
const jobRow = { id: 'job-1', title: 'Install', status: 'scheduled' };

function makeStorage(): TriggerEnrichmentStorage {
  return {
    async getContact(id) { return id === contactRow.id ? { ...contactRow } : undefined; },
    async getLead(id) {
      if (id === leadRow.id) return { ...leadRow };
      if (id === orphanLead.id) return { ...orphanLead };
      return undefined;
    },
    async getEstimate(id) { return id === estimateRow.id ? { ...estimateRow } : undefined; },
    async getJob(id) { return id === jobRow.id ? { ...jobRow } : undefined; },
  };
}

describe('enrichTestTriggerData', () => {
  it('entityType=contact + contact UUID → contact row spread on top', async () => {
    const out = await enrichTestTriggerData(
      { entityId: 'contact-1', entityType: 'contact' },
      CONTRACTOR,
      makeStorage(),
    );
    expect(out.tags).toEqual(['VIP', 'Repeat']);
    expect(out.id).toBe('contact-1');
    expect(out.name).toBe('David J Sitzer');
  });

  it('entityType=lead + contact UUID → still resolves to the contact row', async () => {
    const out = await enrichTestTriggerData(
      { entityId: 'contact-1', entityType: 'lead' },
      CONTRACTOR,
      makeStorage(),
    );
    expect(out.tags).toEqual(['VIP', 'Repeat']);
  });

  it('entityType=lead + lead UUID → dereferences to the underlying contact', async () => {
    const out = await enrichTestTriggerData(
      { entityId: 'lead-1', entityType: 'lead' },
      CONTRACTOR,
      makeStorage(),
    );
    // Most importantly: condition evaluator reads .tags, so they must be present.
    expect(out.tags).toEqual(['VIP', 'Repeat']);
    expect(out.id).toBe('contact-1');
  });

  it('entityType=contact + lead UUID → still resolves via lead → contact fallback', async () => {
    // This was a silent-failure path in the old enrichment code.
    const out = await enrichTestTriggerData(
      { entityId: 'lead-1', entityType: 'contact' },
      CONTRACTOR,
      makeStorage(),
    );
    expect(out.tags).toEqual(['VIP', 'Repeat']);
  });

  it('entityType=lead + lead UUID with no contactId → lead row is returned', async () => {
    const out = await enrichTestTriggerData(
      { entityId: 'lead-orphan', entityType: 'lead' },
      CONTRACTOR,
      makeStorage(),
    );
    expect(out.id).toBe('lead-orphan');
    // No tags resolvable — engine will see `tags === undefined`, which the
    // condition diagnostic will surface to the operator with a hint.
    expect(out.tags).toBeUndefined();
  });

  it('entityType=lead + nonexistent UUID → unenriched payload (no throw)', async () => {
    const out = await enrichTestTriggerData(
      { entityId: 'does-not-exist', entityType: 'lead' },
      CONTRACTOR,
      makeStorage(),
    );
    expect(out).toEqual({ entityId: 'does-not-exist', entityType: 'lead' });
  });

  it('entityType=estimate hydrates the estimate row', async () => {
    const out = await enrichTestTriggerData(
      { entityId: 'est-1', entityType: 'estimate' },
      CONTRACTOR,
      makeStorage(),
    );
    expect(out.title).toBe('Furnace replacement');
  });

  it('entityType=job hydrates the job row', async () => {
    const out = await enrichTestTriggerData(
      { entityId: 'job-1', entityType: 'job' },
      CONTRACTOR,
      makeStorage(),
    );
    expect(out.title).toBe('Install');
  });

  it('contact spread wins over user-supplied JSON for the same field', async () => {
    const out = await enrichTestTriggerData(
      { entityId: 'contact-1', entityType: 'lead', tags: ['stale'] },
      CONTRACTOR,
      makeStorage(),
    );
    expect(out.tags).toEqual(['VIP', 'Repeat']);
  });

  it('payload with no id is returned unchanged', async () => {
    const out = await enrichTestTriggerData({ foo: 'bar' }, CONTRACTOR, makeStorage());
    expect(out).toEqual({ foo: 'bar' });
  });
});
