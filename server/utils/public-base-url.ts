/**
 * Canonical public origin for customer-facing links (booking links, etc.).
 *
 * Outbound links sent to customers (SMS/email booking links) must use the
 * contractor-facing custom domain (e.g. https://hcpcrm.com), NOT the
 * auto-assigned `*.replit.app` host that Replit exposes via REPLIT_DOMAINS.
 *
 * Priority order:
 *   1. PUBLIC_BASE_URL — explicit deployment config, the source of truth in
 *      production (set to the custom domain, e.g. https://hcpcrm.com).
 *   2. First entry of REPLIT_DOMAINS — dev / preview fallback when no custom
 *      domain is configured.
 *   3. '' (empty) — callers already handle the "omit the link" case.
 *
 * Returns just the origin (`https://host`) with no trailing slash. Callers
 * append their own path (e.g. `/book/<slug>?c=<code>`).
 *
 * NOTE: This intentionally does NOT affect OAuth/webhook callback URLs
 * (Gmail, Facebook), which must stay aligned with whatever host is registered
 * at the external provider. Those continue to use REPLIT_DOMAINS directly.
 */
export function getPublicBaseUrl(): string {
  const explicit = process.env.PUBLIC_BASE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, '');
  }

  const replitDomain = process.env.REPLIT_DOMAINS?.split(',')[0]?.trim();
  if (replitDomain) {
    return `https://${replitDomain}`;
  }

  return '';
}
