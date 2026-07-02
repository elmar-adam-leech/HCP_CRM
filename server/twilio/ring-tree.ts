/**
 * Twilio inbound "ring tree" (task #854) — pure TwiML builders for the
 * sequential-fallthrough ring order configured in Settings.
 *
 * A ring tree is a list of ordered steps. Each step rings all its members
 * SIMULTANEOUSLY (multiple <Number> nouns in one <Dial>); when a step goes
 * unanswered, the <Dial action> callback renders the NEXT step, and after the
 * last step the caller drops to voicemail. Members can be CRM users (their
 * twilioPhoneToRing is resolved at call time via `userPhones`) or raw phone
 * numbers stored directly on the step.
 */

import { twilioRingTreeSchema, type TwilioRingTree } from '@shared/schema';
import { escapeXml } from './utils';
import { normalizePhoneNumber } from '../utils/phone-normalizer';

export const MAX_RING_STEPS = 5;
export const MAX_STEP_MEMBERS = 5;

/** Safely parse a stored ring-tree value. Returns null when absent/invalid. */
export function parseRingTree(raw: unknown): TwilioRingTree | null {
  if (!raw || typeof raw !== 'object') return null;
  const result = twilioRingTreeSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * Resolve the phone numbers a step should ring: raw numbers + each referenced
 * user's twilioPhoneToRing (resolved at call time so phone changes are picked
 * up automatically). Normalizes, dedupes, and caps at MAX_STEP_MEMBERS.
 */
export function resolveStepNumbers(
  step: TwilioRingTree['steps'][number],
  userPhones: Map<string, string | null | undefined>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | null | undefined) => {
    if (!value) return;
    const normalized = normalizePhoneNumber(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };
  for (const n of step.numbers) push(n);
  for (const userId of step.userIds) push(userPhones.get(userId));
  return out.slice(0, MAX_STEP_MEMBERS);
}

export interface RingTreeTwimlOptions {
  tree: TwilioRingTree;
  /** Which step to render (0-based). Clamped server-side. */
  stepIndex: number;
  /** userId → twilioPhoneToRing, resolved at call time. */
  userPhones: Map<string, string | null | undefined>;
  record: boolean;
  recordingCallbackUrl?: string;
  /** Spoken before the FIRST rendered <Dial> only (recording consent). */
  consentMessage?: string;
  /** e.g. https://host/api/webhooks/twilio/voice/ring-step/<tenantId> — `?step=N` is appended. */
  ringStepActionUrl: string;
  voicemailCallbackUrl?: string;
}

function voicemailTwiml(opts: {
  greeting?: string;
  voicemailCallbackUrl?: string;
  consent?: string;
}): string {
  const vmRecordAttrs = opts.voicemailCallbackUrl
    ? ` recordingStatusCallback="${escapeXml(opts.voicemailCallbackUrl)}" recordingStatusCallbackEvent="completed"`
    : '';
  const greeting = opts.greeting?.trim() || 'Please leave a message after the tone.';
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${opts.consent || ''}<Say>${escapeXml(greeting)}</Say><Record maxLength="120" playBeep="true"${vmRecordAttrs} /></Response>`;
}

/**
 * Build the TwiML for a given step of the ring tree. Steps whose members all
 * fail to resolve to a phone number are skipped; when no ringable step remains
 * at or after `stepIndex`, the caller drops to voicemail.
 */
export function buildRingTreeStepTwiml(opts: RingTreeTwimlOptions): string {
  const steps = opts.tree.steps.slice(0, MAX_RING_STEPS);
  const start = Math.max(0, Math.floor(opts.stepIndex));
  const consent =
    opts.record && opts.consentMessage && start === 0
      ? `<Say>${escapeXml(opts.consentMessage)}</Say>`
      : '';

  // Find the first ringable step at or after the requested index.
  for (let i = start; i < steps.length; i++) {
    const numbers = resolveStepNumbers(steps[i], opts.userPhones);
    if (numbers.length === 0) continue;

    const recordAttrs = opts.record
      ? ` record="record-from-answer-dual"${opts.recordingCallbackUrl ? ` recordingStatusCallback="${escapeXml(opts.recordingCallbackUrl)}" recordingStatusCallbackEvent="completed"` : ''}`
      : '';
    const sep = opts.ringStepActionUrl.includes('?') ? '&' : '?';
    const actionUrl = `${opts.ringStepActionUrl}${sep}step=${i + 1}`;
    const timeout = Math.min(60, Math.max(5, Math.floor(steps[i].timeoutSeconds)));
    const nouns = numbers.map((n) => `<Number>${escapeXml(n)}</Number>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${consent}<Dial timeout="${timeout}" action="${escapeXml(actionUrl)}" method="POST"${recordAttrs}>${nouns}</Dial></Response>`;
  }

  // Steps exhausted (or none ringable) — voicemail.
  return voicemailTwiml({
    greeting: opts.tree.voicemailGreeting,
    voicemailCallbackUrl: opts.voicemailCallbackUrl,
    consent,
  });
}

/**
 * Build the TwiML response for the <Dial action> callback of a ring step.
 * When the previous <Dial> was ANSWERED (DialCallStatus="completed") the call
 * is done — hang up so the caller is not re-dialed into the next step.
 * Otherwise, fall through to the next step (or voicemail).
 */
export function buildRingStepCallbackTwiml(
  opts: RingTreeTwimlOptions & { dialCallStatus: string | undefined },
): string {
  if ((opts.dialCallStatus || '').toLowerCase() === 'completed') {
    return '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
  }
  return buildRingTreeStepTwiml(opts);
}
