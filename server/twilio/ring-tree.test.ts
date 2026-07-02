import { describe, it, expect } from 'vitest';
import {
  parseRingTree,
  resolveStepNumbers,
  buildRingTreeStepTwiml,
  buildRingStepCallbackTwiml,
} from './ring-tree';
import { twilioRingTreeSchema, type TwilioRingTree } from '@shared/schema';

const ACTION_URL = 'https://crm.example.com/api/webhooks/twilio/voice/ring-step/tenant-1';
const RECORDING_URL = 'https://crm.example.com/api/webhooks/twilio/voice/recording/tenant-1';
const CONSENT = 'This call may be recorded for quality and training purposes.';

const userPhones = new Map<string, string | null | undefined>([
  ['user-a', '+15551230001'],
  ['user-b', '+15551230002'],
  ['user-no-phone', null],
]);

function tree(overrides: Partial<TwilioRingTree> = {}): TwilioRingTree {
  return {
    steps: [
      { numbers: [], userIds: ['user-a'], timeoutSeconds: 20 },
      { numbers: ['+15559990000'], userIds: ['user-b'], timeoutSeconds: 15 },
    ],
    ...overrides,
  };
}

describe('twilioRingTreeSchema bounds', () => {
  it('rejects zero steps and more than 5 steps', () => {
    expect(twilioRingTreeSchema.safeParse({ steps: [] }).success).toBe(false);
    const step = { numbers: ['+15550000000'], userIds: [], timeoutSeconds: 20 };
    expect(twilioRingTreeSchema.safeParse({ steps: Array(6).fill(step) }).success).toBe(false);
    expect(twilioRingTreeSchema.safeParse({ steps: Array(5).fill(step) }).success).toBe(true);
  });

  it('rejects steps with no members or more than 5 members', () => {
    expect(
      twilioRingTreeSchema.safeParse({ steps: [{ numbers: [], userIds: [], timeoutSeconds: 20 }] }).success,
    ).toBe(false);
    expect(
      twilioRingTreeSchema.safeParse({
        steps: [{ numbers: ['1234567', '2234567', '3234567'], userIds: ['a', 'b', 'c'], timeoutSeconds: 20 }],
      }).success,
    ).toBe(false);
  });

  it('rejects out-of-range timeouts (int 5–60 only)', () => {
    const mk = (timeoutSeconds: number) => ({
      steps: [{ numbers: ['+15550000000'], userIds: [], timeoutSeconds }],
    });
    expect(twilioRingTreeSchema.safeParse(mk(4)).success).toBe(false);
    expect(twilioRingTreeSchema.safeParse(mk(61)).success).toBe(false);
    expect(twilioRingTreeSchema.safeParse(mk(20.5)).success).toBe(false);
    expect(twilioRingTreeSchema.safeParse(mk(5)).success).toBe(true);
    expect(twilioRingTreeSchema.safeParse(mk(60)).success).toBe(true);
  });

  it('bounds the voicemail greeting to 500 chars', () => {
    const base = { steps: [{ numbers: ['+15550000000'], userIds: [], timeoutSeconds: 20 }] };
    expect(twilioRingTreeSchema.safeParse({ ...base, voicemailGreeting: 'x'.repeat(500) }).success).toBe(true);
    expect(twilioRingTreeSchema.safeParse({ ...base, voicemailGreeting: 'x'.repeat(501) }).success).toBe(false);
  });
});

describe('parseRingTree', () => {
  it('returns null for null/undefined/invalid stored values', () => {
    expect(parseRingTree(null)).toBeNull();
    expect(parseRingTree(undefined)).toBeNull();
    expect(parseRingTree('not-an-object')).toBeNull();
    expect(parseRingTree({ steps: [] })).toBeNull();
    expect(parseRingTree({ steps: [{ numbers: [], userIds: [], timeoutSeconds: 999 }] })).toBeNull();
  });

  it('parses a valid tree', () => {
    const parsed = parseRingTree(tree());
    expect(parsed).not.toBeNull();
    expect(parsed!.steps).toHaveLength(2);
  });
});

describe('resolveStepNumbers', () => {
  it('resolves user phones at call time and keeps raw numbers', () => {
    const numbers = resolveStepNumbers(
      { numbers: ['+15559990000'], userIds: ['user-a', 'user-no-phone'], timeoutSeconds: 20 },
      userPhones,
    );
    expect(numbers).toContain('+15559990000');
    expect(numbers).toContain('+15551230001');
    expect(numbers).toHaveLength(2); // user-no-phone skipped
  });

  it('dedupes and skips unknown users', () => {
    const numbers = resolveStepNumbers(
      { numbers: ['+15551230001'], userIds: ['user-a', 'ghost'], timeoutSeconds: 20 },
      userPhones,
    );
    expect(numbers).toEqual(['+15551230001']);
  });
});

describe('buildRingTreeStepTwiml', () => {
  it('renders step 0 with simultaneous <Number> nouns, timeout, and action URL', () => {
    const twiml = buildRingTreeStepTwiml({
      tree: tree(),
      stepIndex: 0,
      userPhones,
      record: false,
      ringStepActionUrl: ACTION_URL,
    });
    expect(twiml).toContain('<Dial timeout="20"');
    expect(twiml).toContain(`action="${ACTION_URL}?step=1"`);
    expect(twiml).toContain('<Number>+15551230001</Number>');
    expect(twiml).not.toContain('record=');
    expect(twiml).not.toContain('<Say>');
  });

  it('speaks the consent message only at step 0 when recording is on', () => {
    const opts = {
      tree: tree(),
      userPhones,
      record: true,
      recordingCallbackUrl: RECORDING_URL,
      consentMessage: CONSENT,
      ringStepActionUrl: ACTION_URL,
    };
    const step0 = buildRingTreeStepTwiml({ ...opts, stepIndex: 0 });
    expect(step0).toContain(`<Say>${CONSENT}</Say>`);
    expect(step0).toContain('record="record-from-answer-dual"');
    expect(step0).toContain(`recordingStatusCallback="${RECORDING_URL}"`);

    const step1 = buildRingTreeStepTwiml({ ...opts, stepIndex: 1 });
    expect(step1).not.toContain(CONSENT);
    // recording attrs still present on every leg
    expect(step1).toContain('record="record-from-answer-dual"');
  });

  it('renders step 1 with both members ringing simultaneously', () => {
    const twiml = buildRingTreeStepTwiml({
      tree: tree(),
      stepIndex: 1,
      userPhones,
      record: false,
      ringStepActionUrl: ACTION_URL,
    });
    expect(twiml).toContain('<Number>+15559990000</Number>');
    expect(twiml).toContain('<Number>+15551230002</Number>');
    expect(twiml).toContain('timeout="15"');
    expect(twiml).toContain(`action="${ACTION_URL}?step=2"`);
  });

  it('skips steps whose members cannot be resolved', () => {
    const t: TwilioRingTree = {
      steps: [
        { numbers: [], userIds: ['user-no-phone'], timeoutSeconds: 20 },
        { numbers: ['+15559990000'], userIds: [], timeoutSeconds: 30 },
      ],
    };
    const twiml = buildRingTreeStepTwiml({
      tree: t,
      stepIndex: 0,
      userPhones,
      record: false,
      ringStepActionUrl: ACTION_URL,
    });
    // Step 0 unresolvable → renders step 1 directly, action points past it.
    expect(twiml).toContain('<Number>+15559990000</Number>');
    expect(twiml).toContain('timeout="30"');
    expect(twiml).toContain(`action="${ACTION_URL}?step=2"`);
  });

  it('falls to voicemail with the custom greeting once steps are exhausted', () => {
    const twiml = buildRingTreeStepTwiml({
      tree: tree({ voicemailGreeting: 'Thanks for calling Acme HVAC!' }),
      stepIndex: 2,
      userPhones,
      record: false,
      ringStepActionUrl: ACTION_URL,
      voicemailCallbackUrl: RECORDING_URL,
    });
    expect(twiml).toContain('<Say>Thanks for calling Acme HVAC!</Say>');
    expect(twiml).toContain('<Record');
    expect(twiml).toContain(`recordingStatusCallback="${RECORDING_URL}"`);
    expect(twiml).not.toContain('<Dial');
  });

  it('uses the default voicemail message when no greeting is set', () => {
    const twiml = buildRingTreeStepTwiml({
      tree: tree(),
      stepIndex: 5,
      userPhones,
      record: false,
      ringStepActionUrl: ACTION_URL,
    });
    expect(twiml).toContain('<Say>Please leave a message after the tone.</Say>');
  });

  it('escapes XML in the voicemail greeting', () => {
    const twiml = buildRingTreeStepTwiml({
      tree: tree({ voicemailGreeting: 'Smith & Sons <HVAC>' }),
      stepIndex: 9,
      userPhones,
      record: false,
      ringStepActionUrl: ACTION_URL,
    });
    expect(twiml).toContain('Smith &amp; Sons &lt;HVAC&gt;');
  });
});

describe('buildRingStepCallbackTwiml', () => {
  const opts = {
    tree: tree(),
    userPhones,
    record: false,
    ringStepActionUrl: ACTION_URL,
  };

  it('hangs up when the previous step was answered (short-circuit)', () => {
    const twiml = buildRingStepCallbackTwiml({ ...opts, stepIndex: 1, dialCallStatus: 'completed' });
    expect(twiml).toContain('<Hangup/>');
    expect(twiml).not.toContain('<Dial');
  });

  it('falls through to the next step when unanswered', () => {
    for (const status of ['no-answer', 'busy', 'failed', undefined]) {
      const twiml = buildRingStepCallbackTwiml({ ...opts, stepIndex: 1, dialCallStatus: status });
      expect(twiml).toContain('<Dial');
      expect(twiml).toContain('<Number>+15559990000</Number>');
    }
  });

  it('goes to voicemail when unanswered past the last step', () => {
    const twiml = buildRingStepCallbackTwiml({ ...opts, stepIndex: 2, dialCallStatus: 'no-answer' });
    expect(twiml).toContain('<Record');
    expect(twiml).not.toContain('<Dial');
  });
});
