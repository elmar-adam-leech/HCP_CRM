import { createHash } from 'crypto';
import type { Request, Response } from 'express';

/**
 * Compute a weak ETag for the given JSON-serializable payload.
 * The ETag is a SHA-1 hash of the canonical JSON string, prefixed with W/
 * to indicate weak validation (semantic equivalence, not byte-for-byte).
 */
export function computeWeakEtag(payload: unknown): string {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const hash = createHash('sha1').update(body).digest('base64').replace(/=+$/, '');
  return `W/"${hash}"`;
}

/**
 * Send a JSON response with a weak ETag derived from the payload.
 * If the request's If-None-Match header matches, respond with 304 and no body.
 * Otherwise respond with 200 and the JSON payload.
 */
export function sendJsonWithEtag(req: Request, res: Response, payload: unknown): void {
  const etag = computeWeakEtag(payload);
  res.setHeader('ETag', etag);
  // These helpers are used on per-user authenticated endpoints. Mark responses
  // as private and require revalidation so shared caches/proxies never reuse
  // one user's payload for another, while still permitting If-None-Match 304s.
  if (!res.getHeader('Cache-Control')) {
    res.setHeader('Cache-Control', 'private, no-cache');
  }

  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch && matchesEtag(ifNoneMatch, etag)) {
    res.status(304).end();
    return;
  }
  res.json(payload);
}

function matchesEtag(headerValue: string | string[], etag: string): boolean {
  const raw = Array.isArray(headerValue) ? headerValue.join(',') : headerValue;
  const etagWeakStripped = etag.replace(/^W\//, '');
  return raw.split(',').some((token) => {
    const t = token.trim().replace(/^W\//, '');
    return t === '*' || t === etagWeakStripped;
  });
}
