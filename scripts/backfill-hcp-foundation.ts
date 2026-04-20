/**
 * One-shot CLI for the HCP foundation backfill (Task #440).
 *
 * Wires server/sync/hcp-backfill-foundation.ts to a runnable entry point so
 * operators can execute the four idempotent passes (link HCP employees to
 * user_contractors by email, stamp salesperson on estimates, propagate
 * salesperson to linked jobs, stamp approval_status_changed_at on existing
 * options) for a single tenant or every tenant in series.
 *
 * Usage:
 *   npx tsx scripts/backfill-hcp-foundation.ts                 # all tenants
 *   npx tsx scripts/backfill-hcp-foundation.ts --tenant <id>   # single tenant
 *   npx tsx scripts/backfill-hcp-foundation.ts --json          # machine-readable output
 *
 * Re-running is safe: each pass only touches rows still missing the target
 * value, so the second run on a tenant should report all-zero counts.
 */

import {
  runFoundationBackfill,
  backfillEmployeeUserLinks,
  backfillEstimateSalespeople,
  backfillJobSalespeople,
  backfillOptionApprovalTimestamps,
  type BackfillFoundationResult,
} from '../server/sync/hcp-backfill-foundation';
import { db } from '../server/db';
import { contractors } from '@shared/schema';

interface Args {
  tenant?: string;
  json: boolean;
  skipJobs: boolean;
  passes?: Array<'employees' | 'estimates' | 'jobs' | 'options'>;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { json: false, skipJobs: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenant' || a === '-t') {
      out.tenant = argv[i + 1];
      i++;
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--skip-jobs') {
      // Skip the jobs pass, which makes one HCP API call per job and can
      // take many minutes on large tenants. The other three passes are
      // DB-only and finish in seconds.
      out.skipJobs = true;
    } else if (a === '--passes') {
      const raw = argv[i + 1];
      if (!raw || raw.startsWith('--')) {
        console.error('Error: --passes requires a comma-separated value (e.g. --passes employees,options)');
        process.exit(2);
      }
      const allowed = new Set(['employees', 'estimates', 'jobs', 'options']);
      const parsed = raw.split(',').map(s => s.trim()).filter(Boolean);
      const invalid = parsed.filter(p => !allowed.has(p));
      if (parsed.length === 0 || invalid.length > 0) {
        console.error(
          `Error: --passes contains invalid value(s): ${invalid.join(', ') || '(empty)'}. ` +
          `Allowed: ${Array.from(allowed).join(', ')}.`,
        );
        process.exit(2);
      }
      out.passes = parsed as Args['passes'];
      i++;
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: npx tsx scripts/backfill-hcp-foundation.ts [--tenant <id>] [--skip-jobs] [--passes employees,estimates,jobs,options] [--json]');
      process.exit(0);
    }
  }
  return out;
}

async function listTenantIds(): Promise<string[]> {
  const rows = await db.select({ id: contractors.id }).from(contractors);
  return rows.map(r => r.id);
}

async function runSelectedPassesForTenant(
  tenantId: string,
  passes: NonNullable<Args['passes']>,
): Promise<BackfillFoundationResult> {
  const result: BackfillFoundationResult = {
    employeesLinked: 0,
    estimatesUpdated: 0,
    jobsUpdated: 0,
    optionsStamped: 0,
  };
  if (passes.includes('employees')) result.employeesLinked = await backfillEmployeeUserLinks(tenantId);
  if (passes.includes('estimates')) result.estimatesUpdated = await backfillEstimateSalespeople(tenantId);
  if (passes.includes('jobs')) result.jobsUpdated = await backfillJobSalespeople(tenantId);
  if (passes.includes('options')) result.optionsStamped = await backfillOptionApprovalTimestamps(tenantId);
  return result;
}

async function main() {
  const args = parseArgs();
  const startedAt = Date.now();

  // Resolve which passes to run. Explicit --passes overrides --skip-jobs.
  const selectedPasses: NonNullable<Args['passes']> | null = args.passes
    ? args.passes
    : args.skipJobs
      ? ['employees', 'estimates', 'options']
      : null;

  if (!args.json) {
    console.log('='.repeat(70));
    console.log('HCP Foundation Backfill (Task #440)');
    console.log(`Scope: ${args.tenant ? `tenant ${args.tenant}` : 'ALL tenants'}`);
    if (selectedPasses) console.log(`Passes: ${selectedPasses.join(', ')}`);
    console.log('='.repeat(70));
  }

  let perTenant: Array<{ tenantId: string; result?: BackfillFoundationResult; error?: string }>;
  let totals: BackfillFoundationResult;

  if (selectedPasses) {
    const tenants = args.tenant ? [args.tenant] : await listTenantIds();
    perTenant = [];
    totals = { employeesLinked: 0, estimatesUpdated: 0, jobsUpdated: 0, optionsStamped: 0 };
    for (const t of tenants) {
      try {
        const r = await runSelectedPassesForTenant(t, selectedPasses);
        perTenant.push({ tenantId: t, result: r });
        totals.employeesLinked += r.employeesLinked;
        totals.estimatesUpdated += r.estimatesUpdated;
        totals.jobsUpdated += r.jobsUpdated;
        totals.optionsStamped += r.optionsStamped;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        perTenant.push({ tenantId: t, error: message });
      }
    }
  } else {
    const out = await runFoundationBackfill(args.tenant);
    perTenant = out.perTenant;
    totals = out.totals;
  }
  const elapsedMs = Date.now() - startedAt;

  if (args.json) {
    console.log(JSON.stringify({ perTenant, totals, elapsedMs }, null, 2));
    return;
  }

  console.log('');
  console.log('Per-tenant results:');
  for (const row of perTenant) {
    if (row.error) {
      console.log(`  ${row.tenantId}: FAILED — ${row.error}`);
    } else {
      const r = row.result!;
      console.log(
        `  ${row.tenantId}: linked ${r.employeesLinked} employees, ` +
        `${r.estimatesUpdated} estimates, ${r.jobsUpdated} jobs, ` +
        `${r.optionsStamped} option sets stamped`,
      );
    }
  }
  console.log('');
  console.log('Aggregate totals:');
  console.log(`  employeesLinked: ${totals.employeesLinked}`);
  console.log(`  estimatesUpdated: ${totals.estimatesUpdated}`);
  console.log(`  jobsUpdated: ${totals.jobsUpdated}`);
  console.log(`  optionsStamped: ${totals.optionsStamped}`);
  console.log(`  elapsed: ${(elapsedMs / 1000).toFixed(2)}s`);
  console.log('='.repeat(70));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  });
