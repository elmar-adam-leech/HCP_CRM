# Security Policy

This document outlines security procedures and policies for the **HCP CRM** project — a multi-tenant SaaS CRM handling customer PII, phone numbers, OAuth tokens, and third-party integrations.

## Reporting a Vulnerability

If you discover a security vulnerability in HCP CRM, please **do not** open a public issue or pull request. Instead, report it privately so we can coordinate a fix before public disclosure.

**Preferred method:**
- Email: adam@hcpcrm.com

**Please include in your report:**
- A clear description of the vulnerability and its potential impact
- Step-by-step instructions to reproduce the issue
- Affected components (e.g. Dialpad webhook, tenant isolation, auth flow, OAuth handling)
- Any proof-of-concept code or screenshots demonstrating the issue
- Mitigations you have already tested or are aware of

**Our commitments:**
- Acknowledgment within **48 hours** of receipt
- Status updates every **7 days** until resolution
- Target fix timeline of **30 days for critical issues**
- Reporter credit in the fix announcement and/or GitHub Advisory, unless you prefer anonymity

## Supported Versions

We actively support the **latest release** on `main` (production). Critical security patches are applied to `main` and mirrored to GitHub. Older branches are not supported.

## Current Security Practices

### Multi-Tenant Isolation

Every database read and write is scoped to the authenticated tenant via `contractorId`. Application-layer filtering ensures that no tenant can access another tenant's records under any code path.

### Encryption at Rest

HCP API keys and all third-party integration secrets (e.g. telephony, CRM integrations) are encrypted using **AES-256-GCM** before persistence. Plaintext secrets are never stored in the database.

### OAuth Token Handling

Gmail and other OAuth provider **refresh tokens** are encrypted before being stored. **Access tokens** are held in memory only and are never logged or persisted. Token refresh is performed server-side.

### JWT Authentication

- JWT tokens are issued with a unique **JTI (JWT ID)** and stored in a revocation table
- **httpOnly cookies** are used to prevent client-side token access
- Tokens are invalidated on logout and on credential/password rotation
- **Sliding expiry** extends sessions for active users without requiring re-authentication
- **RBAC** (Role-Based Access Control) is enforced on protected routes and operations

### Webhook Authentication

Inbound webhooks are authenticated using a combination of:
- **Signed URL tokens** embedded in webhook callback URLs
- **API key headers** validated on every inbound request
- **Twilio signature verification** for Twilio-originated webhook payloads

### PII Masking in Logs

Server logs apply masking rules to protect customer PII:
- Phone numbers are masked to the **last 4 digits**
- Customer names and email addresses are not emitted at debug log level

### Helmet Middleware

The application uses the **Helmet** middleware to set security-relevant HTTP response headers, including:
- **Content Security Policy (CSP)** to restrict resource loading origins and reduce XSS attack surface
- **HTTP Strict Transport Security (HSTS)** to enforce HTTPS connections

### Rate Limiting

Per-tenant and per-IP throttling is applied to:
- Authentication endpoints (login, token refresh)
- Sensitive API endpoints

This mitigates brute-force attacks and abusive scraping patterns.

### Secrets Management

All secrets and credentials are managed via **environment variables** provided by the hosting platform's secret store. No secrets are committed to source control or included in build artifacts.

## In Progress / Planned Enhancements

The following items are on the security roadmap and actively being evaluated or developed:

- **Structured audit logging with filtering UI** — append-only logs for sensitive operations (credential updates, user role changes, bulk data exports, login events) with an admin-facing filtering UI (Task #204)
- **Optional TOTP MFA** — time-based one-time password multi-factor authentication with recovery codes; admin visibility into MFA enrollment status (Task #204)
- **GDPR / CCPA compliance** — data subject rights including export, erasure, consent tracking, and configurable data retention policies (Task #205)
- **Row-Level Security (RLS)** — database-enforced tenant isolation as a defense-in-depth layer beneath application-level `contractorId` filtering
- **Full webhook signature validation** — extend cryptographic signature checks to all inbound webhooks across all providers, regardless of header availability
- **Automated dependency scanning** — CI integration of `npm audit` or a dedicated Software Composition Analysis (SCA) tool (e.g. Dependabot) for known CVE detection
- **Regular penetration testing** — annual third-party penetration test targeting authentication, tenant isolation, and API surface

## Responsible Disclosure Policy

We follow a coordinated responsible disclosure process:

1. **Receive** — Reporter submits vulnerability details privately to adam@hcpcrm.com
2. **Validate** — We reproduce and assess severity within 48 hours; acknowledgment sent to reporter
3. **Fix** — We develop and internally test a fix; target is 30 days for critical severity issues
4. **Release** — Patch is deployed to production; a GitHub Security Advisory is published if applicable
5. **Credit** — Reporter is credited in the advisory and/or release notes (unless anonymity is requested)

We do not pursue legal action against researchers who act in good faith and follow this process.

---

Thank you for helping keep HCP CRM secure for HVAC contractors and their customers.

Questions? Reach out to adam@hcpcrm.com.

_Last updated: March 2026_
