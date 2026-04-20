/**
 * entity-adapter.ts — safe bridge between typed Drizzle entities and the
 * WorkflowEngine's generic event system.
 *
 * The WorkflowEngine accepts `Record<string, unknown>` for trigger payloads
 * so it can handle any entity type without knowing the concrete shape. Drizzle
 * inferred types (e.g. `Contact`, `Job`) are structurally compatible, but
 * TypeScript won't allow a direct assignment because the inferred types contain
 * non-`unknown` value types.
 *
 * This adapter provides a single, documented conversion point instead of
 * scattering `as unknown as Record<string, unknown>` casts throughout route files.
 *
 * Usage:
 *   import { toWorkflowEvent } from '../utils/workflow/entity-adapter';
 *   workflowEngine.triggerWorkflowsForEvent('contact_created', toWorkflowEvent(contact), contractorId);
 */

/**
 * Converts a typed Drizzle entity to a plain `Record<string, unknown>` safe
 * for passing into the WorkflowEngine event system.
 *
 * The runtime check ensures the value is a non-null object before casting,
 * which catches the case where a caller accidentally passes `undefined` or a
 * primitive (something a bare `as unknown as Record<...>` would silently allow).
 */
export function toWorkflowEvent(entity: object): Record<string, unknown> {
  if (entity === null || typeof entity !== 'object' || Array.isArray(entity)) {
    throw new TypeError(
      `toWorkflowEvent: expected a plain object, received ${Array.isArray(entity) ? 'array' : typeof entity}`
    );
  }
  return entity as Record<string, unknown>;
}
