import { describe, it, expect } from 'vitest';
import { mapHcpEstimateStatus, resolveHcpEstimateStatus } from '../sync/hcp-mappers';

describe('mapHcpEstimateStatus', () => {
  it('maps approved/completed work_status to approved', () => {
    expect(mapHcpEstimateStatus({ work_status: 'completed' })).toBe('approved');
    expect(mapHcpEstimateStatus({ status: 'approved' })).toBe('approved');
  });

  it('maps option-level approval to approved regardless of work_status', () => {
    expect(mapHcpEstimateStatus({ work_status: 'scheduled', options: [{ approval_status: 'approved' }] })).toBe('approved');
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
