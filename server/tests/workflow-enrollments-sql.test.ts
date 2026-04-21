import { describe, it, expect } from 'vitest';
import { eq, and, or, inArray, sql, desc } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { workflowExecutions, workflows } from '@shared/schema';
import { db } from '../db';

const dialect = new PgDialect();

function buildBulkQuery(contactIds: string[], contractorId: string) {
  return db
    .select({
      executionId: workflowExecutions.id,
    })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(and(
      eq(workflowExecutions.contractorId, contractorId),
      inArray(workflowExecutions.status, ['pending', 'running', 'suspended']),
      or(
        inArray(sql`${workflowExecutions.triggerData}::jsonb ->> 'id'`, contactIds),
        inArray(sql`${workflowExecutions.triggerData}::jsonb ->> 'contactId'`, contactIds),
      )!
    ))
    .orderBy(desc(workflowExecutions.createdAt));
}

describe('bulk workflow enrollments SQL shape', () => {
  it('does not produce broken ANY(($1,$2,...)) tuple syntax', () => {
    const ids = ['id-1', 'id-2', 'id-3', 'id-4', 'id-5'];
    const q = buildBulkQuery(ids, 'contractor-1');
    const { sql: generated, params } = dialect.sqlToQuery(q.getSQL());

    expect(generated).not.toMatch(/= any\(\(\$/i);
    expect(generated).toMatch(/ in \(\$/i);
    expect(params).toEqual(expect.arrayContaining(ids));
  });

  it('binds each contactId twice (id and contactId paths)', () => {
    const ids = ['a', 'b', 'c'];
    const q = buildBulkQuery(ids, 'tenant');
    const { params } = dialect.sqlToQuery(q.getSQL());
    for (const id of ids) {
      const occurrences = params.filter((p) => p === id).length;
      expect(occurrences).toBe(2);
    }
  });
});
