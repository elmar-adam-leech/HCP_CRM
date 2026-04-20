import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const TEST_KEY = 'a'.repeat(64);

beforeAll(() => {
  process.env.MFA_ENCRYPTION_KEY = TEST_KEY;
});

afterAll(() => {
  delete process.env.MFA_ENCRYPTION_KEY;
});

const { encryptSecret, decryptSecret } = await import('../utils/crypto.js');

describe('AES-256-GCM encryption', () => {
  it('encrypts and decrypts a plaintext correctly', () => {
    const plaintext = 'JBSWY3DPEHPK3PXP';
    const payload = encryptSecret(plaintext);
    const result = decryptSecret(payload);
    expect(result).toBe(plaintext);
  });

  it('produces different ciphertext on each call (random IV)', () => {
    const plaintext = 'same-secret';
    const a = encryptSecret(plaintext);
    const b = encryptSecret(plaintext);
    expect(a.iv).not.toBe(b.iv);
    expect(a.encrypted).not.toBe(b.encrypted);
  });

  it('produces correct hex-encoded output fields', () => {
    const payload = encryptSecret('test');
    expect(payload.iv).toMatch(/^[0-9a-f]+$/);
    expect(payload.encrypted).toMatch(/^[0-9a-f]+$/);
    expect(payload.authTag).toMatch(/^[0-9a-f]+$/);
    expect(Buffer.from(payload.iv, 'hex').length).toBe(12);
    expect(Buffer.from(payload.authTag, 'hex').length).toBe(16);
  });

  it('throws when decrypting with tampered authTag', () => {
    const payload = encryptSecret('sensitive');
    const tampered = { ...payload, authTag: 'ff'.repeat(16) };
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('throws when MFA_ENCRYPTION_KEY is missing', async () => {
    const originalKey = process.env.MFA_ENCRYPTION_KEY;
    delete process.env.MFA_ENCRYPTION_KEY;
    vi.resetModules();
    const { encryptSecret: enc } = await import('../utils/crypto.js');
    expect(() => enc('hello')).toThrow('MFA_ENCRYPTION_KEY environment variable is not set');
    process.env.MFA_ENCRYPTION_KEY = originalKey;
  });
});
