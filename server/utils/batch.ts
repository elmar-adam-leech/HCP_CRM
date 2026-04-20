/**
 * server/utils/batch.ts — generic array-chunking utility.
 *
 * Splits an array into consecutive sub-arrays of at most `batchSize` items.
 *
 * Usage:
 *   const batches = splitIntoBatches(records, 25);
 *   for (const batch of batches) { ... }
 *
 * Previously a local helper inside server/sync/housecall-pro.ts; extracted here
 * so it can be reused by any sync or bulk-processing path without duplication.
 *
 * @param items     - Source array to chunk.
 * @param batchSize - Maximum items per batch (must be > 0).
 * @returns Array of batches; each batch has 1..batchSize items.
 */
export function splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}
