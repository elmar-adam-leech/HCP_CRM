import type { SenderRule } from "@shared/schema";

/**
 * Normalises raw JSONB sender-rule objects loaded from the database.
 *
 * The database column is typed as `unknown` (JSONB), so this function defensively
 * handles every possible shape:
 *   - null / undefined → returns []
 *   - legacy objects with a single `action` string → promotes to `actions: [action]`
 *   - objects already using the `actions` array form → used as-is
 *   - objects with neither `action` nor `actions` → defaults to `['default']`
 *
 * The `action` field is removed from the output because downstream code only reads
 * `actions` (the normalised multi-action form).
 *
 * Pure function — no database access. Extracted from `server/storage/lead-capture.ts`
 * so that it can be tested in isolation.
 */
export function normalizeSenderRules(raw: any[]): SenderRule[] {
  return (Array.isArray(raw) ? raw : []).map((r: any) => {
    const actions = r.actions && r.actions.length > 0
      ? r.actions
      : r.action ? [r.action] : ['default'];
    return { ...r, actions, action: undefined } as SenderRule;
  });
}
