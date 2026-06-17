# Threat Model

## Project Overview

This project is a multi-tenant CRM for field-service contractors. It exposes an authenticated browser-based CRM, public booking and lead-capture endpoints, third-party webhook receivers, and multiple high-trust outbound integrations including Housecall Pro, Dialpad, Gmail, Facebook Lead Ads, Google Places, Google Local Services, and SendGrid.

The stack is a React/Vite frontend (`client/`) and a Node.js/Express backend (`server/`) with PostgreSQL via Drizzle ORM and shared schemas in `shared/`. Authentication uses JWTs delivered primarily in an HTTP-only `auth_token` cookie, with multi-company membership and per-session active `contractorId` scoping. Production assumptions for this threat model: `NODE_ENV=production`, TLS is terminated by the platform, and mockup/dev sandbox surfaces are not deployed.

Deployment-specific note from the 2026-05-22 scan: the public `hcpcrm.com`
deployment currently sits behind a Cloudflare edge that returns HTTP 403 for
requests carrying a mismatched `Host` header. As a result, Host-header
poisoning findings that depend on arbitrary external `Host` values are not
currently production-reachable on this deployment unless the edge/domain
configuration changes.

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

## PWA storage trade-off (task #737 — cookieless bearer-token fallback)

Installed PWAs on iOS Safari evict the `auth_token` httpOnly cookie under
storage pressure, sometimes alongside IndexedDB. To meet the product
expectation that field techs stay signed in, task #737 mirrors the short-lived
auth JWT into BOTH `localStorage["auth-token"]` AND `IndexedDB
auth-fallback/auth_token` (newer write wins on read), and attaches it as
`Authorization: Bearer <jwt>` on every same-origin `/api/*` request when a
stored copy is available. The cookie remains the default delivery path —
bearer is added IN ADDITION TO `credentials: "include"`, never INSTEAD OF —
and the server prefers the cookie when both arrive on the same request.

This is a deliberate, narrow weakening of the existing security posture:

- A successful XSS on the SPA can read the stored JWT (and the stored refresh
  token mirrored under the same `auth-fallback` IDB database / matching
  `localStorage` key from task #720), where it could not read the httpOnly
  cookies. We accept this trade-off because (a) #720 already accepted the
  same trade-off for the refresh token and (b) without this fallback,
  installed PWAs cannot meet the basic product expectation of staying signed
  in across iOS storage evictions.
- Mitigations that remain in force: short auth-JWT TTL, refresh-token
  rotation with replay detection (`replayed-past-grace` revokes the chain),
  per-IP and per-token rate limits on `/api/auth/refresh`, server-side
  preference for the cookie over the header, dead-token outcomes
  (`not-found` / `revoked` / `expired` / `replayed-past-grace` /
  `membership-missing`) clearing BOTH stores, and a single
  `clearAllStoredAuthTokens()` helper that every logout path funnels through
  to prevent stale bearer copies on disk.
- Telemetry: a 1%-sampled `auth_source_sample` log (`AuthService`) reports
  whether each authenticated request was served by the cookie or the bearer
  path so ops can monitor real-world fallback usage; a `bearer_probe` log
  (`AuthStorageProbe`, 10/min/IP) records when the SPA first asks the server
  to confirm bearer support.
- Future scans should treat any new storage of high-value secrets in
  `localStorage` or IndexedDB as in-scope for the same trade-off
  conversation, and should verify that newly-added logout / dead-token
  paths still funnel through `clearAllStoredAuthTokens()`.

## 2026-05-08 Task #738 — passkey-first cold-start

Task #738 ("invisible re-sign-in with Face ID") adds three new public-ish
surfaces and one authenticated surface to the auth subsystem. Each was
designed against the existing trust boundaries:

- `GET /api/auth/webauthn/has-credentials` (public, 10/min/IP) — used by the
  SPA's boot-auth helper to decide whether attempting a silent passkey
  unlock is worthwhile. To avoid becoming an account-enumeration oracle the
  endpoint NEVER consults the database for the email branch: any
  well-formed email returns `{ hasAny: true }`, malformed email returns
  `{ hasAny: false }`, and the no-email branch gates on the non-secret
  `pkhint=1` cookie. The constant-true response shape is the entire
  defense — pinned by `server/routes/has-credentials.test.ts`.
- `POST /api/auth/passkey-prompt/dismiss` (authenticated) — sets
  `users.passkey_prompt_dismissed_at` to now. Idempotent. Tenant-irrelevant
  (per-user, not per-contractor). No payload.
- `POST /api/auth/storage-probe` now accepts an optional `bootResolution`
  string field (length-bounded to 40 chars) so production telemetry can
  distinguish cookie/bearer/passkey-conditional/passkey-explicit/password
  outcomes. Still rate-limited 10/min/IP. Still a fire-and-forget log; no
  database write, no auth side-effect.
- `pkhint=1` cookie (client-written, non-httpOnly, SameSite=Lax, 1-year):
  carries no PII, no user identifier, no integrity-bearing material — it is
  literally the bit "this device has at least one local passkey". An
  attacker reading this cookie learns nothing they couldn't learn by
  attempting a WebAuthn assertion. PasskeysCard writes it on register and
  clears it on remove via the same `setHasPasskeyFlag` helper that maintains
  the `localStorage["hcp.webauthn.hasPasskey"]` mirror.
- Conditional-UI passkey discovery in `LoginForm` re-uses the existing
  `/api/auth/webauthn/login/begin` and `/finish` endpoints; no new server
  surface is introduced for the silent path. The begin endpoint already
  enforces its own anti-enumeration shape.

Future scans should:

- Treat `/api/auth/webauthn/has-credentials` as a high-value enumeration
  target — any change that consults the database for the email branch
  breaks the no-oracle invariant and must be re-reviewed. The pinned test
  in `server/routes/has-credentials.test.ts` exists specifically to catch
  this regression.
- Verify any new client-side write of high-value secrets to LS / IDB /
  cookies still respects the trade-off documented in "PWA storage
  trade-off". The `pkhint` cookie is acceptable BECAUSE it carries no
  secret; do not generalize this pattern to anything that does.
- Verify `users.passkey_prompt_dismissed_at` reads/writes go through the
  authenticated surface only — it is a per-user UX flag, not security
  state, but a missing auth check would let an unauthenticated caller
  spam-clear the prompt for arbitrary users.

## Task #802 — background jobs on Replit Scheduled Deployments

To let the Autoscale web app scale to zero when idle, every periodic
background job (sync, sales cadence, suspended-workflow resume, Dialpad
event recovery, webhook/call health checks, ad-spend pull, message cleanup,
daily maintenance) can now run as a standalone Replit Scheduled Deployment
via `server/worker.ts` instead of (or in addition to) the always-on in-app
timers. Behavior is gated by the `RUN_IN_APP_JOBS` env var on the web app
(default — unset or any value other than `"false"` — keeps the historical
in-app timers; `"false"` disables them so only the scheduled deployments
run).

Trust-boundary and abuse considerations:

- **No new network attack surface.** The worker is a CLI process started by
  the platform scheduler, not an HTTP listener. It exposes no routes and
  accepts no external input; its only inputs are the job name(s) on argv and
  the same database/integration credentials the web app already holds. It
  does not weaken any existing authn/authz boundary.
- **Same trust level as the web app.** The worker shares the server codebase
  and runs every job at full server privilege, exactly as the in-app timers
  did. It performs the same tenant-scoped queries and the same outbound
  integration calls; no job gains broader data access by moving to the
  worker.
- **Overlap safety (integrity).** Because a long-running invocation can
  overlap the next scheduled tick — or an in-app timer during the migration
  window — every worker job runs under a Postgres session advisory lock
  (`server/jobs/job-lock.ts`). Only one holder of a given job name runs at a
  time across all processes/machines sharing the database. This composes
  with (does not replace) each job's existing idempotency: atomic row claims
  (`claimSuspendedExecution`, `claimDueAutoTasks`), HCP echo suppression,
  and per-(contractor,service,kind) alert throttling. A lock held elsewhere
  causes the invocation to skip, not to double-process.
- **DoS / resource bounds.** The worker never runs DDL (the web app still
  owns schema migrations on boot, avoiding a migration race), closes its DB
  pool and exits when done, and is bounded by a `WORKER_JOB_TIMEOUT_MS`
  watchdog (default 10 min) that force-exits a wedged job so a scheduled
  deployment cannot stay pinned open. The sales drain loop is bounded
  (max batches) and each external call retains its existing timeouts.
- **No secrets in argv/logs.** Job selection is by non-secret job name only;
  credentials continue to come from the environment/credential service, and
  the worker logs job names and durations, not payloads or secrets.

Future scans should treat `server/worker.ts` as a privileged server
entrypoint equivalent to the in-app job timers, and should verify any newly
added job is wrapped in `withJobLock` and preserves its idempotency
guarantees before being scheduled.

## 2026-04-22 Refresh Notes

- Treat JWT role and integration-permission claims as high-risk scan anchors until token issuance and refresh are fully derived from `user_contractors`, not legacy `users` columns or stale JWT snapshots.
- Treat authenticated integration settings endpoints that return plaintext webhook credentials or trigger tenant-wide sync/configuration actions as privileged-by-default; future scans should verify explicit server-side role checks on each route.
- Treat the public booking flow as a sensitive identity and data-integrity boundary: matching existing contacts by email/phone and then mutating those records is in scope for future scans, and public scheduling routes must continue to enforce tight work bounds.
