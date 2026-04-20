/**
 * Maps an external (e.g. HouseCall Pro) role string to one or more internal role slugs.
 *
 * The mapping is deliberately broad and keyword-based: external systems rarely use the
 * same role vocabulary as our internal schema, so we match on substrings and fall back
 * to 'technician' for anything unrecognised.
 *
 * Pure function — no database access. Extracted from `server/storage/employees.ts` so
 * that it can be tested in isolation and reused from HCP sync code.
 */
export function mapExternalRoleToInternalRoles(externalRole: string): string[] {
  const role = externalRole.toLowerCase();
  if (role.includes('field') || role.includes('technician')) return ['technician'];
  if (role.includes('estimator')) return ['estimator'];
  if (role.includes('sales')) return ['sales'];
  if (role.includes('dispatch')) return ['dispatcher'];
  if (role.includes('admin') || role.includes('manager')) return ['manager'];
  return ['technician'];
}
