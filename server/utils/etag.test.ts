import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { computeWeakEtag, sendJsonWithEtag } from './etag';

function makeRes() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    ended: false,
    setHeader(key: string, value: string) {
      this.headers[key.toLowerCase()] = value;
    },
    getHeader(key: string) {
      return this.headers[key.toLowerCase()];
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      this.ended = true;
      return this;
    },
  };
  return res as Response & typeof res;
}

describe('etag utils', () => {
  it('computeWeakEtag is stable for equal payloads and differs for different payloads', () => {
    const a = computeWeakEtag({ x: 1, y: 'foo' });
    const b = computeWeakEtag({ x: 1, y: 'foo' });
    const c = computeWeakEtag({ x: 2, y: 'foo' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('W/"')).toBe(true);
  });

  it('returns 200 with ETag header when no If-None-Match is provided', () => {
    const req = { headers: {} } as Request;
    const res = makeRes();
    const payload = { hello: 'world' };
    sendJsonWithEtag(req, res, payload);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(payload);
    expect(res.headers.etag).toBe(computeWeakEtag(payload));
  });

  it('returns 304 with empty body when If-None-Match matches', () => {
    const payload = { hello: 'world' };
    const etag = computeWeakEtag(payload);
    const req = { headers: { 'if-none-match': etag } } as unknown as Request;
    const res = makeRes();
    sendJsonWithEtag(req, res, payload);

    expect(res.statusCode).toBe(304);
    expect(res.body).toBeUndefined();
    expect(res.ended).toBe(true);
    expect(res.headers.etag).toBe(etag);
  });

  it('returns 200 when If-None-Match does not match', () => {
    const req = { headers: { 'if-none-match': 'W/"stale"' } } as unknown as Request;
    const res = makeRes();
    const payload = { hello: 'world' };
    sendJsonWithEtag(req, res, payload);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(payload);
  });

  it('matches when client sends a strong-form etag for a weak server etag', () => {
    const payload = { a: 1 };
    const weak = computeWeakEtag(payload);
    const strong = weak.replace(/^W\//, '');
    const req = { headers: { 'if-none-match': strong } } as unknown as Request;
    const res = makeRes();
    sendJsonWithEtag(req, res, payload);

    expect(res.statusCode).toBe(304);
  });

  it('matches against a list of comma-separated etags', () => {
    const payload = { a: 1 };
    const etag = computeWeakEtag(payload);
    const req = {
      headers: { 'if-none-match': `W/"other", ${etag}, W/"another"` },
    } as unknown as Request;
    const res = makeRes();
    sendJsonWithEtag(req, res, payload);

    expect(res.statusCode).toBe(304);
  });

  it('sets Cache-Control: private, no-cache by default', () => {
    const req = { headers: {} } as Request;
    const res = makeRes();
    sendJsonWithEtag(req, res, { a: 1 });
    expect(res.headers['cache-control']).toBe('private, no-cache');
  });

  it('does not overwrite an existing Cache-Control header', () => {
    const req = { headers: {} } as Request;
    const res = makeRes();
    res.setHeader('Cache-Control', 'public, max-age=60');
    sendJsonWithEtag(req, res, { a: 1 });
    expect(res.headers['cache-control']).toBe('public, max-age=60');
  });

  it('matches wildcard *', () => {
    const req = { headers: { 'if-none-match': '*' } } as unknown as Request;
    const res = makeRes();
    sendJsonWithEtag(req, res, { a: 1 });
    expect(res.statusCode).toBe(304);
  });
});
