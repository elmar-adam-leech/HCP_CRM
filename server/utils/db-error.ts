/**
 * Helper to extract a fully diagnostic string from a database/Drizzle error.
 *
 * Drizzle wraps the underlying `pg`/`postgres` driver error so that
 * `err.message` is just the SQL text ("Failed query: select ..."), and the
 * actual postgres error (which carries the human-readable message, the
 * `code`, the `detail`, the `hint`, etc.) is hidden on `err.cause`.
 *
 * `formatDbError` walks `err.cause` (and any nested causes) and returns a
 * single multi-line string that includes the wrapper message AND every
 * useful field from the underlying postgres error so that a single log
 * line gives an operator everything they need to diagnose the failure
 * (missing column, missing index, permission denied, connection
 * terminated, etc.) without having to attach a debugger.
 */
export function formatDbError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  const parts: string[] = [err.message];
  const seen = new Set<unknown>([err]);

  let cause: unknown = (err as { cause?: unknown }).cause;
  while (cause && !seen.has(cause)) {
    seen.add(cause);

    if (cause instanceof Error) {
      const c = cause as Error & {
        code?: string;
        detail?: string;
        hint?: string;
        position?: string;
        schema?: string;
        table?: string;
        column?: string;
        constraint?: string;
        routine?: string;
        severity?: string;
        where?: string;
      };
      const fields: string[] = [];
      if (c.code) fields.push(`code=${c.code}`);
      if (c.severity) fields.push(`severity=${c.severity}`);
      if (c.detail) fields.push(`detail=${c.detail}`);
      if (c.hint) fields.push(`hint=${c.hint}`);
      if (c.schema) fields.push(`schema=${c.schema}`);
      if (c.table) fields.push(`table=${c.table}`);
      if (c.column) fields.push(`column=${c.column}`);
      if (c.constraint) fields.push(`constraint=${c.constraint}`);
      if (c.routine) fields.push(`routine=${c.routine}`);
      if (c.position) fields.push(`position=${c.position}`);
      if (c.where) fields.push(`where=${c.where}`);

      const suffix = fields.length > 0 ? ` (${fields.join(', ')})` : '';
      parts.push(`cause: ${c.message}${suffix}`);
      cause = (c as { cause?: unknown }).cause;
    } else {
      parts.push(`cause: ${String(cause)}`);
      break;
    }
  }

  return parts.join(' | ');
}
