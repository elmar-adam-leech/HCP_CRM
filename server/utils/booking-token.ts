import { createHmac, timingSafeEqual, randomBytes } from "crypto";

/**
 * Generate a short alphanumeric booking code (8 characters, URL-safe).
 * Uses base62 alphabet to keep the code compact and clean.
 */
export function generateBookingCode(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(8);
  return Array.from(bytes)
    .map(b => alphabet[b % alphabet.length])
    .join('');
}

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET environment variable is not set");
  return secret;
}

function base64urlEncode(data: string): string {
  return Buffer.from(data).toString("base64url");
}

function base64urlDecode(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

function computeHmac(payload: string, slug: string): string {
  const secret = getSecret();
  return createHmac("sha256", `${secret}:${slug}`)
    .update(payload)
    .digest("base64url");
}

export function generateBookingToken(contactId: string, contractorSlug: string): string {
  const expiry = Date.now() + TOKEN_TTL_MS;
  const payload = base64urlEncode(JSON.stringify({ contactId, expiry }));
  const sig = computeHmac(payload, contractorSlug);
  return `${payload}.${sig}`;
}

export function verifyBookingToken(token: string, contractorSlug: string): string | null {
  try {
    const lastDot = token.lastIndexOf(".");
    if (lastDot === -1) return null;

    const payload = token.slice(0, lastDot);
    const sig = token.slice(lastDot + 1);

    const expectedSig = computeHmac(payload, contractorSlug);

    const sigBuf = Buffer.from(sig, "base64url");
    const expectedBuf = Buffer.from(expectedSig, "base64url");
    if (sigBuf.length !== expectedBuf.length) return null;
    if (!timingSafeEqual(sigBuf, expectedBuf)) return null;

    const parsed = JSON.parse(base64urlDecode(payload));
    if (!parsed || typeof parsed.contactId !== "string" || typeof parsed.expiry !== "number") {
      return null;
    }
    if (Date.now() > parsed.expiry) return null;

    return parsed.contactId;
  } catch {
    return null;
  }
}
