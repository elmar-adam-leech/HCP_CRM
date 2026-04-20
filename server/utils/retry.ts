/**
 * server/utils/retry.ts — generic exponential-backoff retry helper.
 *
 * Usage:
 *   const result = await withRetry(() => fetchSomething(), 'fetchSomething');
 *
 * Retry behaviour:
 *   - Attempt 1 runs immediately.
 *   - On failure, waits 1 s before attempt 2, then 2 s before attempt 3, etc.
 *   - If all attempts fail, the last error is re-thrown.
 *
 * Previously localised copies existed in server/sync/gmail.ts. This canonical
 * version ensures consistent retry behaviour and a single place to tune backoff.
 *
 * @param fn          - Async function to call. Retried on any thrown error.
 * @param label       - Human-readable label used in warning/error log lines.
 * @param maxAttempts - Total number of attempts (default 3).
 */
import { logger } from "./logger";

const log = logger('withRetry');

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 3,
): Promise<T> {
  let lastError: Error = new Error('Unknown error');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) {
        const delayMs = (attempt - 1) * 1000;
        log.warn(`${label} — attempt ${attempt}/${maxAttempts} failed, retrying in ${delayMs}ms: ${lastError.message}`);
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  log.error(`${label} — all ${maxAttempts} attempts failed.`);
  throw lastError;
}
