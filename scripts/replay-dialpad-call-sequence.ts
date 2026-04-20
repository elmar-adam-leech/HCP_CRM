/**
 * Smoke test for Dialpad call enrich-on-newer-event handling (Task #385).
 *
 * Posts a `hangup` event followed by a `voicemail_uploaded` event for the
 * same call_id and verifies the resulting activity carries the recording
 * URL from the second event.
 *
 * Usage:
 *   npx tsx scripts/replay-dialpad-call-sequence.ts \
 *     --tenant <contractorId> \
 *     --key <webhook_api_key> \
 *     --phone <E164> \
 *     [--base http://localhost:5000]
 *
 * `--phone` should be the phone number of an existing contact for the
 * tenant — otherwise the webhook short-circuits as `unmatched_contact`
 * and no activity is created.
 *
 * Exits non-zero if the assertion (recording URL ends up on the activity)
 * does not hold, so this script is safe to run from CI as a smoke test.
 */

import { db } from '../server/db';
import { activities } from '../shared/schema';
import { and, eq } from 'drizzle-orm';

interface Args {
  tenant: string;
  key: string;
  phone: string;
  base: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      out[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  if (!out.tenant || !out.key || !out.phone) {
    console.error('Required: --tenant <contractorId> --key <webhook_api_key> --phone <E164>');
    process.exit(2);
  }
  return {
    tenant: out.tenant,
    key: out.key,
    phone: out.phone,
    base: out.base ?? 'http://localhost:5000',
  };
}

async function postEvent(base: string, tenant: string, key: string, payload: Record<string, unknown>): Promise<void> {
  const url = `${base}/api/webhooks/dialpad/calls/${tenant}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  console.log(`POST ${url} → ${res.status}: ${body}`);
  if (!res.ok) throw new Error(`Webhook returned ${res.status}`);
}

function fail(msg: string): never {
  console.error(`\n❌ ASSERTION FAILED: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { tenant, key, phone, base } = parseArgs();
  const callId = `replay-${Date.now()}`;
  const now = Date.now();
  const recordingUrl = `https://example.com/voicemail/${callId}.mp3`;

  console.log(`\n--- 1) hangup event for call_id=${callId} ---`);
  await postEvent(base, tenant, key, {
    call_id: callId,
    state: 'hangup',
    direction: 'inbound',
    external_number: phone,
    internal_number: '+15555550000',
    from_number: phone,
    to_number: '+15555550000',
    duration: 12,
    event_timestamp: now,
  });

  await new Promise(r => setTimeout(r, 500));

  console.log(`\n--- 2) voicemail_uploaded event for call_id=${callId} ---`);
  await postEvent(base, tenant, key, {
    call_id: callId,
    state: 'voicemail_uploaded',
    direction: 'inbound',
    external_number: phone,
    internal_number: '+15555550000',
    from_number: phone,
    to_number: '+15555550000',
    duration: 12,
    event_timestamp: now + 5000,
    voicemail_link: recordingUrl,
  });

  console.log('\n--- verifying activity row ---');
  const rows = await db.select()
    .from(activities)
    .where(and(
      eq(activities.contractorId, tenant),
      eq(activities.externalSource, 'dialpad'),
      eq(activities.externalId, callId),
    ));

  if (rows.length === 0) fail(`no activity created for external_id=${callId}`);
  if (rows.length > 1) fail(`expected exactly 1 activity, got ${rows.length}`);

  const activity = rows[0];
  const meta = (activity.metadata ?? {}) as Record<string, unknown>;
  console.log('Activity metadata:', JSON.stringify(meta, null, 2));

  if (meta.recording_url !== recordingUrl) {
    fail(`metadata.recording_url=${meta.recording_url ?? 'null'} (expected ${recordingUrl})`);
  }
  if (meta.outcome !== 'voicemail') {
    fail(`metadata.outcome=${meta.outcome} (expected voicemail)`);
  }
  if (typeof meta.event_timestamp !== 'number' || meta.event_timestamp < now) {
    fail(`metadata.event_timestamp=${meta.event_timestamp} (expected >= ${now})`);
  }
  if (typeof activity.content !== 'string' || !activity.content.includes(recordingUrl)) {
    fail(`activity.content does not include recording URL: ${activity.content}`);
  }

  console.log(`\n✅ PASS — activity ${activity.id} was enriched with the voicemail recording URL.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
