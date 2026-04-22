# Threat Model

## Project Overview

This project is a multi-tenant CRM for field-service contractors. It exposes an authenticated browser-based CRM, public booking and lead-capture endpoints, third-party webhook receivers, and multiple high-trust outbound integrations including Housecall Pro, Dialpad, Gmail, Facebook Lead Ads, Google Places, Google Local Services, and SendGrid.

The stack is a React/Vite frontend (`client/`) and a Node.js/Express backend (`server/`) with PostgreSQL via Drizzle ORM and shared schemas in `shared/`. Authentication uses JWTs delivered primarily in an HTTP-only `auth_token` cookie, with multi-company membership and per-session active `contractorId` scoping. Production assumptions for this threat model: `NODE_ENV=production`, TLS is terminated by the platform, and mockup/dev sandbox surfaces are not deployed.

## Assets

- **User accounts and active sessions** — JWT session cookies, MFA state, password reset tokens, and token revocation state. Compromise enables account takeover and lateral movement across contractor data.
- **Tenant business data** — contacts, leads, jobs, estimates, activities, reports, workflow executions, audit logs, and scheduling data. This is the core multi-tenant dataset and contains business-sensitive information.
- **Customer PII** — names, phone numbers, email addresses, physical addresses, booking details, and communication history. Exposure impacts customer privacy and contractor trust.
- **Integration credentials and secrets** — Gmail OAuth tokens, Dialpad API keys and webhook secrets, Housecall Pro credentials, Facebook page access tokens, SendGrid keys, Google API credentials, JWT signing keys, and credential-encryption keys. These secrets grant direct access to external systems and inbound trust boundaries.
- **Automation and messaging capabilities** — workflow definitions, message templates, outbound email/SMS/call functionality, and booking creation. Abuse can send messages, create records, or trigger actions at tenant scope.

## Trust Boundaries

- **Browser to API** — all `/api/*` traffic from the SPA crosses from an untrusted client into privileged server code. Every authenticated endpoint must validate identity, authorization, and tenant scope on the server.
- **Public internet to unauthenticated endpoints** — `/api/public/*` booking routes and `/api/webhooks/*` receivers accept requests without session auth. These routes must enforce their own authentication, validation, abuse controls, and least-privilege responses.
- **API to PostgreSQL** — the server has broad read/write access to tenant data. Any injection flaw or missing tenant filter at the server layer can expose or corrupt all contractor data.
- **API to external providers** — the server holds long-lived credentials for Housecall Pro, Dialpad, Gmail, Facebook, SendGrid, Google APIs, and similar services. Credential disclosure or unvalidated outbound requests can impact external accounts as well as local data.
- **Authenticated user to privileged user** — standard users, managers, admins, and super admins have different powers. Authorization must be enforced server-side; UI gating is not sufficient.
- **Tenant to tenant** — users may belong to multiple contractors, but each session is scoped to one active `contractorId`. Every data access path must preserve strict tenant isolation.

## Scan Anchors

- **Production entry points:** `server/index.ts`, `server/routes.ts`, `server/websocket.ts`, `client/src/main.tsx`, `client/src/App.tsx`.
- **Highest-risk server areas:** `server/routes/auth.ts`, `server/auth-service.ts`, `server/routes/public.ts`, `server/routes/webhooks/**`, `server/routes/integrations/**`, `server/routes/messaging.ts`, `server/routes/workflows.ts`, `server/credential-service.ts`, `server/storage/**`.
- **Public surfaces:** `/api/public/*`, `/api/webhooks/*`, OAuth callbacks, login/register/reset-password, and public booking pages.
- **Authenticated/admin surfaces:** most `/api/*` CRM routes, integration management, user management, audit logs, workflow builder/executions, messaging, reports, and settings.
- **Usually dev-only / low-priority unless production reachability is shown:** `server/tests/**`, `client/src/pages/OpenSourceLicenses.tsx`, historical `migrations/`, docs, local scripts, Vite-only behavior, Replit development banner behavior.

## Threat Categories

### Spoofing

The application accepts identity from JWT cookies or bearer tokens and accepts unauthenticated traffic on public booking routes, OAuth callbacks, and webhook receivers. It must reject missing, expired, revoked, or stale-version tokens, and every webhook/callback path must verify the sender with a tenant-specific secret, signature, or other strong proof before trusting the payload.

Required guarantees:
- All non-public API routes MUST require a valid JWT and MUST reject revoked or stale-version sessions.
- Session tokens MUST be bound to an authorized active `contractorId` and MUST NOT be accepted for contractors the user no longer belongs to.
- Webhook and OAuth callback handlers MUST authenticate the sending service before processing any state-changing payload.

### Tampering

Untrusted input enters through CRM forms, booking forms, webhook payloads, workflow definitions, message templates, AI-related routes, and integration settings. Attackers can tamper with tenant records, workflow behavior, or scheduling if validation is weak or if privileged routes are reachable by lower-privilege users.

Required guarantees:
- Server-side validation MUST enforce required fields, expected types, and safe value ranges for all public, webhook, and authenticated write paths.
- Sensitive business actions MUST be derived or validated server-side; clients MUST NOT be trusted for authorization, tenant scope, or integration selection.
- Workflow/template inputs MUST be treated as untrusted content and MUST NOT gain code execution or unsafe HTML/script execution.

### Repudiation

The app includes audit logs and many state-changing administrative actions. If sensitive actions are not tied to actor, tenant, and time, administrators may be unable to investigate abuse or credential misuse.

Required guarantees:
- Sensitive authentication, user-management, integration, and credential-management actions MUST record actor, tenant, action, and timestamp.
- Public/webhook-originated state changes SHOULD preserve provenance so operators can distinguish external ingestion from user actions.

### Information Disclosure

The system stores customer PII, communication history, and high-value integration credentials. Risks include overbroad API responses, public endpoints returning tenant data, insufficient authorization on credential/config routes, secrets in logs, and tenant mix-ups.

Required guarantees:
- Public endpoints MUST return only the minimum data needed for the public flow and MUST never expose internal identifiers or unnecessary customer PII.
- Integration secrets, webhook keys, OAuth tokens, and encryption keys MUST never be exposed to unauthorized users, client-side code, or logs.
- Every tenant-scoped query and response MUST be filtered server-side by the authenticated session’s active `contractorId` or an equivalent verified tenant context.

### Denial of Service

Public booking APIs, webhook endpoints, login/reset flows, and external-provider calls can all be abused for resource exhaustion. The app also runs background jobs, sync schedulers, and polling loops that can amplify abuse if not bounded.

Required guarantees:
- Public/auth/webhook routes MUST enforce rate limits appropriate to their exposure and cost.
- External HTTP calls MUST use timeouts and fail safely.
- Public endpoints that can trigger scheduling or expensive lookups MUST bound input sizes and work performed per request.

### Elevation of Privilege

The biggest project-specific risk is a standard user reaching privileged tenant-wide capabilities: integration configuration, secret retrieval, user management, audit access, or cross-tenant data. Multi-tenant CRM routes, webhooks, credential access, and workflow/messaging features all need strict server-side authorization.

Required guarantees:
- Admin- and manager-only capabilities MUST be enforced on the server regardless of frontend visibility.
- Secret-bearing routes and integration-management routes MUST require the exact intended privilege level, not merely authentication.
- All tenant-scoped resources MUST enforce both authentication and ownership/tenant membership checks to prevent IDOR and cross-tenant access.
- Database access patterns MUST remain parameterized and tenant-filtered so injection or scope bypass cannot escalate into broader data compromise.

## 2026-04-22 Refresh Notes

- Treat JWT role and integration-permission claims as high-risk scan anchors until token issuance and refresh are fully derived from `user_contractors`, not legacy `users` columns or stale JWT snapshots.
- Treat authenticated integration settings endpoints that return plaintext webhook credentials or trigger tenant-wide sync/configuration actions as privileged-by-default; future scans should verify explicit server-side role checks on each route.
- Treat the public booking flow as a sensitive identity and data-integrity boundary: matching existing contacts by email/phone and then mutating those records is in scope for future scans, and public scheduling routes must continue to enforce tight work bounds.
