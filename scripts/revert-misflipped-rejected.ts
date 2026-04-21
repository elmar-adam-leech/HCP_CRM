/**
 * Task #484 — revert estimates that were mis-flipped to 'rejected' by the
 * `.some` bug in `mapHcpEstimateStatus`. The corrected mapper only sets the
 * parent to 'rejected' when EVERY option is decline-or-expired AND at least
 * one is actually declined; otherwise the previous all-options-declined
 * shortcut wrongly caught mixed estimates that had at least one approved or
 * still-pending option.
 *
 * This script scans every estimate currently in 'rejected' that:
 *   - has `status_manually_set = false`
 *   - carries a non-empty `hcp_options` JSON array
 *
 * For each row it recomputes `mapHcpEstimateStatus` using only the stored
 * options array (we don't persist the HCP `work_status` separately on the
 * row, so the mapper falls back to 'scheduled' when no option-rule path
 * applies — see Task #484 plan). If the recomputed status is NOT 'rejected'
 * the row is reverted in place. Estimates that ARE truly all-declined stay
 * rejected.
 *
 * Default is dry-run; pass `--apply` to write. After writing, fires one
 * `estimate_status_changed` workflow event per reverted estimate (in batches
 * of 100 with a 250ms sleep) unless `--no-events` is passed (recommended for
 * the historical sweep so you don't replay months of automation).
 *
 * Usage:
 *   npx tsx scripts/revert-misflipped-rejected.ts                     # dry-run, all tenants
 *   npx tsx scripts/revert-misflipped-rejected.ts --tenant <id>       # single tenant
 *   npx tsx scripts/revert-misflipped-rejected.ts --apply             # actually write
 *   npx tsx scripts/revert-misflipped-rejected.ts --apply --no-events # skip workflow events
 *   npx tsx scripts/revert-misflipped-rejected.ts --json              # machine-readable
 */

import { db } from '../server/db';
import { estimates, contractors } from '@shared/schema';
import { and, eq } from 'drizzle-orm';
import { mapHcpEstimateStatus } from '../server/sync/hcp-mappers';
import { workflowEngine } from '../server/workflow-engine';
import { toWorkflowEvent } from '../server/utils/workflow/entity-adapter';
import { logger } from '../server/utils/logger';

const log = logger('RevertMisflippedRejected');

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
    if (a === '--tenant' || a === '-t') { out.tenant = argv[i + 1]; i++; }
    else if (a === '--apply') out.apply = true;
    else if (a === '--no-events') out.noEvents = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: npx tsx scripts/revert-misflipped-rejected.ts [--tenant <id>] [--apply] [--no-events] [--json]');
      process.exit(0);
    }
  }
  return out;
}

interface TenantResult {
  contractorId: string;
  scanned: number;
  manualOverridesSkipped: number;
  noOptionsSkipped: number;
  staysRejected: number;
  reverted: number;
  byNewStatus: Record<string, number>;
}

async function processTenant(contractorId: string, args: Args): Promise<TenantResult> {
  const result: TenantResult = {
    contractorId,
    scanned: 0,
    manualOverridesSkipped: 0,
    noOptionsSkipped: 0,
    staysRejected: 0,
    reverted: 0,
    byNewStatus: {},
  };

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
    })
    .from(estimates)
    .where(and(
      eq(estimates.contractorId, contractorId),
      eq(estimates.status, 'rejected'),
    ));

  result.scanned = rows.length;

  const revertRows: Array<{ row: typeof rows[number]; newStatus: 'approved' | 'sent' | 'scheduled' | 'in_progress' }> = [];
  for (const row of rows) {
    if (row.statusManuallySet) { result.manualOverridesSkipped++; continue; }
    const opts = Array.isArray(row.hcpOptions) ? row.hcpOptions : [];
    if (opts.length === 0) { result.noOptionsSkipped++; continue; }

    // Recompute using only the stored options. Per Task #484 the option-rule
    // path returns before the work_status checks for the all-declined case,
    // so estimates that ARE truly rejected stay rejected. Mixed cases with
    // an approved option re-derive to 'approved'; mixed declined+pending
    // fall through to 'scheduled' (we don't have work_status on the row).
    const recomputed = mapHcpEstimateStatus({ options: opts });
    if (recomputed === 'rejected') { result.staysRejected++; continue; }

    revertRows.push({ row, newStatus: recomputed });
    result.byNewStatus[recomputed] = (result.byNewStatus[recomputed] ?? 0) + 1;
  }

  result.reverted = revertRows.length;

  if (!args.apply) return result;

  const BATCH = 100;
  for (let i = 0; i < revertRows.length; i += BATCH) {
    const slice = revertRows.slice(i, i + BATCH);
    for (const { row, newStatus } of slice) {
      await db
        .update(estimates)
        .set({ status: newStatus, updatedAt: new Date() })
        .where(and(eq(estimates.id, row.id), eq(estimates.contractorId, contractorId)));

      if (!args.noEvents) {
        const event = toWorkflowEvent({
          id: row.id,
          status: newStatus,
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
    if (i + BATCH < revertRows.length) {
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
      const bucket = Object.entries(r.byNewStatus).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)';
      console.log(
        `[${t.id}] scanned=${r.scanned} manual_skipped=${r.manualOverridesSkipped} ` +
        `no_options=${r.noOptionsSkipped} stays_rejected=${r.staysRejected} ` +
        `reverted=${r.reverted} (${bucket})${args.apply ? '' : ' (dry-run)'}`,
      );
    }
  }

  const totals = results.reduce(
    (acc, r) => {
      acc.scanned += r.scanned;
      acc.manualOverridesSkipped += r.manualOverridesSkipped;
      acc.noOptionsSkipped += r.noOptionsSkipped;
      acc.staysRejected += r.staysRejected;
      acc.reverted += r.reverted;
      for (const [k, v] of Object.entries(r.byNewStatus)) {
        acc.byNewStatus[k] = (acc.byNewStatus[k] ?? 0) + v;
      }
      return acc;
    },
    { scanned: 0, manualOverridesSkipped: 0, noOptionsSkipped: 0, staysRejected: 0, reverted: 0, byNewStatus: {} as Record<string, number> },
  );

  if (args.json) {
    console.log(JSON.stringify({ apply: args.apply, totals, results }, null, 2));
  } else {
    const bucket = Object.entries(totals.byNewStatus).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)';
    console.log('---');
    console.log(
      `TOTAL scanned=${totals.scanned} manual_skipped=${totals.manualOverridesSkipped} ` +
      `no_options=${totals.noOptionsSkipped} stays_rejected=${totals.staysRejected} ` +
      `reverted=${totals.reverted} (${bucket})${args.apply ? '' : ' (dry-run — pass --apply to write)'}`,
    );
  }
  process.exit(0);
}

main().catch(err => {
  console.error('Revert failed:', err);
  process.exit(1);
});
