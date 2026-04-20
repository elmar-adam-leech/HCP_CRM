/**
 * One-shot CLI for the "rejected estimates" backfill (Task #479).
 *
 * Mirrors the new mapping rule (`server/sync/hcp-mappers.ts`):
 *   - Skip if `status_manually_set = true`
 *   - Skip if any option's `approval_status` matches
 *     `isHcpApprovedOptionStatus` (approved / pro approved / customer approved)
 *   - Otherwise, if any option's `approval_status` matches
 *     `isHcpDeclinedOptionStatus` (declined / pro declined / customer
 *     declined / expired / cancelled / voided), set `status = 'rejected'`
 *     and stamp `approval_status_changed_at = NOW()` on each declined
 *     option that lacks one.
 *
 * Default is dry-run; pass `--apply` to write. After writing, fires one
 * `estimate_status_changed` workflow event per flipped estimate (in
 * batches of 100 with a small sleep) so any rejection-driven automations
 * catch up.
 *
 * Usage:
 *   npx tsx scripts/backfill-rejected-estimates.ts                     # dry-run, all tenants
 *   npx tsx scripts/backfill-rejected-estimates.ts --tenant <id>       # single tenant
 *   npx tsx scripts/backfill-rejected-estimates.ts --apply             # actually write
 *   npx tsx scripts/backfill-rejected-estimates.ts --apply --no-events # skip workflow events
 */

import { db } from '../server/db';
import { estimates, contractors, type HcpOptionEntry } from '@shared/schema';
import { and, eq, ne, isNotNull } from 'drizzle-orm';
import {
  isHcpDeclinedOptionStatus,
  isHcpApprovedOptionStatus,
} from '../server/sync/hcp-mappers';
import { workflowEngine } from '../server/workflow-engine';
import { toWorkflowEvent } from '../server/utils/workflow/entity-adapter';
import { logger } from '../server/utils/logger';

const log = logger('BackfillRejectedEstimates');

interface Args {
  tenant?: string;
  apply: boolean;
  noEvents: boolean;
  json: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { apply: false, noEvents: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenant' || a === '-t') {
      out.tenant = argv[i + 1];
      i++;
    } else if (a === '--apply') {
      out.apply = true;
    } else if (a === '--no-events') {
      out.noEvents = true;
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: npx tsx scripts/backfill-rejected-estimates.ts [--tenant <id>] [--apply] [--no-events] [--json]');
      process.exit(0);
    }
  }
  return out;
}

interface TenantResult {
  contractorId: string;
  scanned: number;
  candidates: number;
  manualOverridesSkipped: number;
  mixedOptionSkipped: number;
  flipped: number;
}

async function processTenant(contractorId: string, args: Args): Promise<TenantResult> {
  const result: TenantResult = {
    contractorId,
    scanned: 0,
    candidates: 0,
    manualOverridesSkipped: 0,
    mixedOptionSkipped: 0,
    flipped: 0,
  };

  // Pull estimates for this tenant whose status is NOT already rejected and
  // which carry HCP options. Manual-override rows are still fetched so we
  // can count them in the report; we just don't write to them.
  const rows = await db
    .select({
      id: estimates.id,
      status: estimates.status,
      statusManuallySet: estimates.statusManuallySet,
      hcpOptions: estimates.hcpOptions,
      contractorId: estimates.contractorId,
      contactId: estimates.contactId,
      title: estimates.title,
      amount: estimates.amount,
      housecallProEstimateId: estimates.housecallProEstimateId,
      externalId: estimates.externalId,
      externalSource: estimates.externalSource,
      createdAt: estimates.createdAt,
      updatedAt: estimates.updatedAt,
    })
    .from(estimates)
    .where(and(
      eq(estimates.contractorId, contractorId),
      ne(estimates.status, 'rejected'),
      isNotNull(estimates.hcpOptions),
    ));

  result.scanned = rows.length;

  const flippedRows: Array<typeof rows[number] & { newOptions: HcpOptionEntry[] }> = [];
  for (const row of rows) {
    const opts = Array.isArray(row.hcpOptions) ? row.hcpOptions : [];
    if (opts.length === 0) continue;

    const hasApproved = opts.some(o => isHcpApprovedOptionStatus(o?.approval_status));
    const hasDeclined = opts.some(o => isHcpDeclinedOptionStatus(o?.approval_status));

    if (!hasDeclined) continue;
    if (hasApproved) {
      result.mixedOptionSkipped++;
      continue;
    }

    result.candidates++;

    if (row.statusManuallySet) {
      result.manualOverridesSkipped++;
      continue;
    }

    const nowIso = new Date().toISOString();
    const newOptions: HcpOptionEntry[] = opts.map(o => {
      if (isHcpDeclinedOptionStatus(o?.approval_status) && !o?.approval_status_changed_at) {
        return { ...o, approval_status_changed_at: nowIso };
      }
      return o;
    });

    flippedRows.push({ ...row, newOptions });
  }

  result.flipped = flippedRows.length;

  if (!args.apply) return result;

  // Apply in batches of 100 with a 250ms sleep between batches to keep DB +
  // workflow engine load bounded across a multi-thousand-row backfill.
  const BATCH = 100;
  for (let i = 0; i < flippedRows.length; i += BATCH) {
    const slice = flippedRows.slice(i, i + BATCH);
    for (const row of slice) {
      await db
        .update(estimates)
        .set({
          status: 'rejected',
          hcpOptions: row.newOptions,
          updatedAt: new Date(),
        })
        .where(and(eq(estimates.id, row.id), eq(estimates.contractorId, contractorId)));

      if (!args.noEvents) {
        const event = toWorkflowEvent({
          id: row.id,
          status: 'rejected',
          contactId: row.contactId,
          title: row.title,
          amount: row.amount,
          contractorId: row.contractorId,
          housecallProEstimateId: row.housecallProEstimateId,
          externalId: row.externalId,
          externalSource: row.externalSource,
        });
        await workflowEngine
          .triggerWorkflowsForEvent('estimate_status_changed', event, contractorId)
          .catch(err => log.warn(`workflow trigger failed for estimate ${row.id}`, err));
      }
    }
    if (i + BATCH < flippedRows.length) {
      await new Promise(r => setTimeout(r, 250));
    }
  }

  return result;
}

async function main() {
  const args = parseArgs();

  const tenantRows = args.tenant
    ? [{ id: args.tenant }]
    : await db.select({ id: contractors.id }).from(contractors);

  const results: TenantResult[] = [];
  for (const t of tenantRows) {
    const r = await processTenant(t.id, args);
    results.push(r);
    if (!args.json) {
      console.log(
        `[${t.id}] scanned=${r.scanned} candidates=${r.candidates} ` +
        `manual_skipped=${r.manualOverridesSkipped} mixed_skipped=${r.mixedOptionSkipped} ` +
        `flipped=${r.flipped}${args.apply ? '' : ' (dry-run)'}`,
      );
    }
  }

  const totals = results.reduce(
    (acc, r) => ({
      scanned: acc.scanned + r.scanned,
      candidates: acc.candidates + r.candidates,
      manualOverridesSkipped: acc.manualOverridesSkipped + r.manualOverridesSkipped,
      mixedOptionSkipped: acc.mixedOptionSkipped + r.mixedOptionSkipped,
      flipped: acc.flipped + r.flipped,
    }),
    { scanned: 0, candidates: 0, manualOverridesSkipped: 0, mixedOptionSkipped: 0, flipped: 0 },
  );

  if (args.json) {
    console.log(JSON.stringify({ apply: args.apply, totals, results }, null, 2));
  } else {
    console.log('---');
    console.log(
      `TOTAL scanned=${totals.scanned} candidates=${totals.candidates} ` +
      `manual_skipped=${totals.manualOverridesSkipped} mixed_skipped=${totals.mixedOptionSkipped} ` +
      `flipped=${totals.flipped}${args.apply ? '' : ' (dry-run — pass --apply to write)'}`,
    );
  }
  process.exit(0);
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
