import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_HEX = process.env.MFA_ENCRYPTION_KEY;

function getKey(): Buffer {
  if (!KEY_HEX) {
    throw new Error('MFA_ENCRYPTION_KEY environment variable is not set');
  }
  const key = Buffer.from(KEY_HEX, 'hex');
  if (key.length !== 32) {
    throw new Error('MFA_ENCRYPTION_KEY must be a 32-byte hex string (64 hex chars)');
  }
  return key;
}

export interface EncryptedPayload {
  encrypted: string;
  iv: string;
  authTag: string;
}

export function encryptSecret(plaintext: string): EncryptedPayload {
  const key = getKey();
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

export function decryptSecret(payload: EncryptedPayload): string {
  const key = getKey();
  const iv = Buffer.from(payload.iv, 'hex');
  const authTag = Buffer.from(payload.authTag, 'hex');
  const encryptedBuffer = Buffer.from(payload.encrypted, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: 16 });
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
  return decrypted.toString('utf8');
}
