import { describe, it, expect } from 'vitest';
import {
  mapHcpEstimateStatus,
  resolveHcpEstimateStatus,
  isHcpDeclinedOptionStatus,
  isHcpApprovedOptionStatus,
  isHcpExpiredOptionStatus,
  isHcpRejectedEstimateStatus,
  isHcpExcludedEstimateStatus,
} from '../sync/hcp-mappers';

describe('isHcpDeclinedOptionStatus', () => {
  it('handles all observed HCP option approval_status variants', () => {
    expect(isHcpDeclinedOptionStatus('approved')).toBe(false);
    expect(isHcpDeclinedOptionStatus('pro approved')).toBe(false);
    expect(isHcpDeclinedOptionStatus('customer approved')).toBe(false);
    expect(isHcpDeclinedOptionStatus('awaiting response')).toBe(false);
    expect(isHcpDeclinedOptionStatus('declined')).toBe(true);
    expect(isHcpDeclinedOptionStatus('pro declined')).toBe(true);
    expect(isHcpDeclinedOptionStatus('customer declined')).toBe(true);
    // expired is now its own predicate (isHcpExpiredOptionStatus)
    expect(isHcpDeclinedOptionStatus('expired')).toBe(false);
    // underscored/legacy forms
    expect(isHcpDeclinedOptionStatus('pro_declined')).toBe(true);
    expect(isHcpDeclinedOptionStatus('customer_declined')).toBe(true);
    // unknown future variant containing the keyword
    expect(isHcpDeclinedOptionStatus('office declined')).toBe(true);
    // empty / null
    expect(isHcpDeclinedOptionStatus(null)).toBe(false);
    expect(isHcpDeclinedOptionStatus(undefined)).toBe(false);
    expect(isHcpDeclinedOptionStatus('')).toBe(false);
  });
});

describe('isHcpExpiredOptionStatus', () => {
  it('only matches expired variants', () => {
    expect(isHcpExpiredOptionStatus('expired')).toBe(true);
    expect(isHcpExpiredOptionStatus('EXPIRED')).toBe(true);
    expect(isHcpExpiredOptionStatus('approved')).toBe(false);
    expect(isHcpExpiredOptionStatus('declined')).toBe(false);
    expect(isHcpExpiredOptionStatus('')).toBe(false);
    expect(isHcpExpiredOptionStatus(null)).toBe(false);
  });
});

describe('isHcpApprovedOptionStatus', () => {
  it('only returns true for the three approval variants', () => {
    expect(isHcpApprovedOptionStatus('approved')).toBe(true);
    expect(isHcpApprovedOptionStatus('pro approved')).toBe(true);
    expect(isHcpApprovedOptionStatus('customer approved')).toBe(true);
    expect(isHcpApprovedOptionStatus('PRO_APPROVED')).toBe(true);
    expect(isHcpApprovedOptionStatus('declined')).toBe(false);
    expect(isHcpApprovedOptionStatus('awaiting response')).toBe(false);
  });
});

describe('isHcpRejectedEstimateStatus / isHcpExcludedEstimateStatus', () => {
  it('treats canceled/expired/voided as rejected', () => {
    for (const v of ['canceled','cancelled','rejected','declined','expired','deleted','void','voided','PRO DECLINED']) {
      expect(isHcpRejectedEstimateStatus(v)).toBe(true);
    }
    expect(isHcpRejectedEstimateStatus('approved')).toBe(false);
    expect(isHcpRejectedEstimateStatus(null)).toBe(false);
  });
  it('excludes completed and unscheduled in addition to rejection-like values', () => {
    expect(isHcpExcludedEstimateStatus('completed')).toBe(true);
    expect(isHcpExcludedEstimateStatus('unscheduled')).toBe(true);
    expect(isHcpExcludedEstimateStatus('pro declined')).toBe(true);
    expect(isHcpExcludedEstimateStatus('approved')).toBe(false);
    expect(isHcpExcludedEstimateStatus('scheduled')).toBe(false);
  });
});

describe('mapHcpEstimateStatus', () => {
  it('maps approved/completed work_status to approved', () => {
    expect(mapHcpEstimateStatus({ work_status: 'completed' })).toBe('approved');
    expect(mapHcpEstimateStatus({ status: 'approved' })).toBe('approved');
  });

  it('maps option-level approval to approved regardless of work_status', () => {
    expect(mapHcpEstimateStatus({ work_status: 'scheduled', options: [{ approval_status: 'approved' }] })).toBe('approved');
    expect(mapHcpEstimateStatus({ work_status: 'scheduled', options: [{ approval_status: 'pro approved' }] })).toBe('approved');
  });

  it('maps an estimate whose options are ALL declined-like to rejected', () => {
    expect(mapHcpEstimateStatus({ work_status: 'scheduled', options: [{ approval_status: 'pro declined' }] })).toBe('rejected');
    expect(mapHcpEstimateStatus({ work_status: 'scheduled', options: [{ approval_status: 'declined' }, { approval_status: 'pro declined' }] })).toBe('rejected');
    // 5 declined — full regression check for the all-declined case
    expect(mapHcpEstimateStatus({
      work_status: 'scheduled',
      options: [
        { approval_status: 'pro declined' },
        { approval_status: 'pro declined' },
        { approval_status: 'customer declined' },
        { approval_status: 'declined' },
        { approval_status: 'pro declined' },
      ],
    })).toBe('rejected');
  });

  it('maps a single-option estimate whose only option is expired through to active rules', () => {
    // All-expired with NO declined option — falls through, no work_status hint
    // → defaults to 'scheduled'. (HCP usually marks the top-level work_status
    // 'expired' in this case, which the rejection check at the top of the
    // mapper catches before we ever inspect options.)
    expect(mapHcpEstimateStatus({ work_status: 'somethingelse', options: [{ approval_status: 'expired' }] })).toBe('scheduled');
  });

  it('preserves "any approved wins" for mixed-option estimates', () => {
    expect(mapHcpEstimateStatus({
      work_status: 'scheduled',
      options: [{ approval_status: 'approved' }, { approval_status: 'pro declined' }],
    })).toBe('approved');
    // declined + approved + pending → still 'approved' (any approved wins)
    expect(mapHcpEstimateStatus({
      work_status: 'sent',
      options: [
        { approval_status: 'pro declined' },
        { approval_status: 'approved' },
        { approval_status: 'awaiting response' },
      ],
    })).toBe('approved');
    // mixed pro_declined / customer_declined / pro_approved → 'approved'
    expect(mapHcpEstimateStatus({
      options: [
        { approval_status: 'pro declined' },
        { approval_status: 'customer declined' },
        { approval_status: 'pro approved' },
      ],
    })).toBe('approved');
  });

  it('mixed declined + pending (no approved) falls through to active work_status', () => {
    // 1 declined + 4 awaiting response, work_status='sent' → 'sent'
    expect(mapHcpEstimateStatus({
      work_status: 'sent',
      options: [
        { approval_status: 'pro declined' },
        { approval_status: 'awaiting response' },
        { approval_status: 'awaiting response' },
        { approval_status: 'awaiting response' },
        { approval_status: 'awaiting response' },
      ],
    })).toBe('sent');
    // Same options, no work_status hint → defaults to 'scheduled'
    expect(mapHcpEstimateStatus({
      options: [
        { approval_status: 'pro declined' },
        { approval_status: 'awaiting response' },
      ],
    })).toBe('scheduled');
  });

  it('declined + expired (all terminal, at least one declined) maps to rejected', () => {
    expect(mapHcpEstimateStatus({
      options: [
        { approval_status: 'pro declined' },
        { approval_status: 'expired' },
        { approval_status: 'expired' },
        { approval_status: 'expired' },
        { approval_status: 'expired' },
      ],
    })).toBe('rejected');
  });

  it('falls through normally when an option is awaiting response', () => {
    expect(mapHcpEstimateStatus({ work_status: 'scheduled', options: [{ approval_status: 'awaiting response' }] })).toBe('scheduled');
  });

  it('an empty/missing options array falls through to active rules', () => {
    expect(mapHcpEstimateStatus({ options: [], work_status: 'sent' })).toBe('sent');
    expect(mapHcpEstimateStatus({ work_status: 'sent' })).toBe('sent');
  });

  it('maps cancelled/rejected/expired/deleted to rejected', () => {
    for (const v of ['cancelled', 'canceled', 'rejected', 'declined', 'expired', 'deleted', 'void', 'voided']) {
      expect(mapHcpEstimateStatus({ work_status: v })).toBe('rejected');
    }
  });

  it('maps awaiting_approval/awaiting_review to sent', () => {
    expect(mapHcpEstimateStatus({ work_status: 'awaiting_approval' })).toBe('sent');
    expect(mapHcpEstimateStatus({ work_status: 'awaiting_review' })).toBe('sent');
    expect(mapHcpEstimateStatus({ status: 'sent' })).toBe('sent');
  });

  it('falls through to scheduled for unknown states', () => {
    expect(mapHcpEstimateStatus({ work_status: 'something_unknown' })).toBe('scheduled');
    expect(mapHcpEstimateStatus({})).toBe('scheduled');
  });
});

describe('resolveHcpEstimateStatus (merge with local)', () => {
  it('terminal rejected from HCP always wins', () => {
    expect(resolveHcpEstimateStatus('rejected', 'approved', false)).toBe('rejected');
    expect(resolveHcpEstimateStatus('rejected', 'sent', true)).toBe('rejected');
    expect(resolveHcpEstimateStatus('rejected', 'scheduled', true)).toBe('rejected');
  });

  it('manual override preserves local status against any non-terminal HCP status', () => {
    expect(resolveHcpEstimateStatus('scheduled', 'approved', true)).toBe('approved');
    expect(resolveHcpEstimateStatus('sent', 'in_progress', true)).toBe('in_progress');
    expect(resolveHcpEstimateStatus('approved', 'sent', true)).toBe('sent');
  });

  it('does not downgrade an advanced local status to scheduled', () => {
    expect(resolveHcpEstimateStatus('scheduled', 'sent', false)).toBe('sent');
    expect(resolveHcpEstimateStatus('scheduled', 'in_progress', false)).toBe('in_progress');
    expect(resolveHcpEstimateStatus('scheduled', 'approved', false)).toBe('approved');
    expect(resolveHcpEstimateStatus('scheduled', 'rejected', false)).toBe('rejected');
  });

  it('allows advancement when not manually set', () => {
    expect(resolveHcpEstimateStatus('sent', 'scheduled', false)).toBe('sent');
    expect(resolveHcpEstimateStatus('approved', 'sent', false)).toBe('approved');
    expect(resolveHcpEstimateStatus('in_progress', 'scheduled', false)).toBe('in_progress');
  });

  it('keeps scheduled-to-scheduled idempotent', () => {
    expect(resolveHcpEstimateStatus('scheduled', 'scheduled', false)).toBe('scheduled');
    expect(resolveHcpEstimateStatus('scheduled', 'scheduled', true)).toBe('scheduled');
  });
});

describe('resolveHcpEstimateStatus — in_progress → sent (task #764)', () => {
  // Pins the exact regression: an `estimate.sent` webhook arriving after
  // an earlier `estimate.on_my_way` (local = in_progress) must promote the
  // local status to 'sent', not be silently dropped as a "downgrade".
  it("promotes in_progress to sent when HCP reports 'sent' and the status is not manually set", () => {
    expect(resolveHcpEstimateStatus('sent', 'in_progress', false)).toBe('sent');
  });

  // And the manual-override rule must still win for the same transition.
  it('preserves a manually-set in_progress against an HCP-reported sent', () => {
    expect(resolveHcpEstimateStatus('sent', 'in_progress', true)).toBe('in_progress');
  });
});
