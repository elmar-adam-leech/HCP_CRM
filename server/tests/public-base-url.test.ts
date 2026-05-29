import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getPublicBaseUrl } from '../utils/public-base-url';

describe('getPublicBaseUrl', () => {
  const originalPublic = process.env.PUBLIC_BASE_URL;
  const originalReplit = process.env.REPLIT_DOMAINS;

  beforeEach(() => {
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.REPLIT_DOMAINS;
  });

  afterEach(() => {
    if (originalPublic === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = originalPublic;
    if (originalReplit === undefined) delete process.env.REPLIT_DOMAINS;
    else process.env.REPLIT_DOMAINS = originalReplit;
  });

  it('prefers PUBLIC_BASE_URL when set (custom domain wins)', () => {
    process.env.PUBLIC_BASE_URL = 'https://hcpcrm.com';
    process.env.REPLIT_DOMAINS = 'hcpcrm.replit.app';
    expect(getPublicBaseUrl()).toBe('https://hcpcrm.com');
  });

  it('strips a trailing slash from PUBLIC_BASE_URL', () => {
    process.env.PUBLIC_BASE_URL = 'https://hcpcrm.com/';
    expect(getPublicBaseUrl()).toBe('https://hcpcrm.com');
  });

  it('falls back to the first REPLIT_DOMAINS entry when PUBLIC_BASE_URL is unset', () => {
    process.env.REPLIT_DOMAINS = 'hcpcrm.replit.app,extra.replit.app';
    expect(getPublicBaseUrl()).toBe('https://hcpcrm.replit.app');
  });

  it('returns empty string when neither is configured', () => {
    expect(getPublicBaseUrl()).toBe('');
  });

  it('ignores a blank PUBLIC_BASE_URL and falls back to REPLIT_DOMAINS', () => {
    process.env.PUBLIC_BASE_URL = '   ';
    process.env.REPLIT_DOMAINS = 'hcpcrm.replit.app';
    expect(getPublicBaseUrl()).toBe('https://hcpcrm.replit.app');
  });
});
