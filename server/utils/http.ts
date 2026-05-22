/**
 * Tiny JSON HTTP helper built on Node's native `fetch`. Mirrors the small
 * subset of axios behavior we relied on across the codebase so the migration
 * away from axios (a frequent CVE source — see task #773) doesn't require
 * rewriting call sites.
 *
 * Supported axios-isms preserved:
 *   - `params` → query string (skips undefined/null)
 *   - object `body` → JSON-encoded with `Content-Type: application/json`
 *   - `URLSearchParams` `body` → form-encoded with
 *     `application/x-www-form-urlencoded`
 *   - `timeout` (ms) → AbortController
 *   - non-2xx responses throw an error with the same
 *     `err.response.{status,data,headers}` shape axios used.
 *
 * Not supported (intentionally — none of our 33 call sites used these):
 *   interceptors, cancellation tokens, custom adapters, `axios.create()`,
 *   request retries, automatic XSRF handling, transformResponse, etc.
 */

export interface HttpResponse<T = any> {
  data: T;
  status: number;
  headers: Record<string, string>;
}

export interface HttpError extends Error {
  response?: HttpResponse;
}

export interface HttpJsonInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  timeout?: number;
}

function buildUrl(url: string, params?: HttpJsonInit['params']): string {
  if (!params) return url;
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    search.append(k, String(v));
  }
  const qs = search.toString();
  if (!qs) return url;
  return url + (url.includes('?') ? '&' : '?') + qs;
}

function parseBody(text: string): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return text; }
}

export async function httpJson<T = any>(url: string, init: HttpJsonInit = {}): Promise<HttpResponse<T>> {
  const { method = 'GET', params, body, timeout } = init;
  const reqHeaders: Record<string, string> = { ...(init.headers ?? {}) };
  let reqBody: BodyInit | undefined;

  if (body !== undefined && body !== null) {
    if (body instanceof URLSearchParams) {
      reqBody = body;
      if (!Object.keys(reqHeaders).some(h => h.toLowerCase() === 'content-type')) {
        reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    } else if (typeof body === 'string') {
      reqBody = body;
    } else {
      reqBody = JSON.stringify(body);
      if (!Object.keys(reqHeaders).some(h => h.toLowerCase() === 'content-type')) {
        reqHeaders['Content-Type'] = 'application/json';
      }
    }
  }

  const controller = timeout ? new AbortController() : undefined;
  const timer = timeout && controller
    ? setTimeout(() => controller.abort(), timeout)
    : undefined;

  let res: Response;
  try {
    res = await fetch(buildUrl(url, params), {
      method,
      headers: reqHeaders,
      body: reqBody,
      signal: controller?.signal,
    });
  } catch (err: any) {
    if (timer) clearTimeout(timer);
    if (err?.name === 'AbortError') {
      const e = new Error(`Request timed out after ${timeout}ms: ${method} ${url}`) as HttpError;
      throw e;
    }
    throw err;
  }
  if (timer) clearTimeout(timer);

  const text = await res.text();
  const data = parseBody(text);

  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { responseHeaders[k] = v; });

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${method} ${url}`) as HttpError;
    err.response = { data, status: res.status, headers: responseHeaders };
    throw err;
  }

  return { data: data as T, status: res.status, headers: responseHeaders };
}
