---
name: Per-integration authorization pattern
description: How to correctly enforce a user's allowedIntegrations allowlist on integration-specific routes.
---

`server/auth-service.ts` exports `canAccessIntegration(user, integrationKey)` and a middleware
factory `requireIntegrationAccess(integrationKey)`. These are the single source of truth for
per-integration authorization: managers/admins/super_admins always pass; a delegated user
(`canManageIntegrations=true`) is further restricted to their `allowedIntegrations` allowlist
(null/empty allowlist = all integrations allowed).

**Why:** `requireIntegrationManager` only checks role OR the coarse `canManageIntegrations`
flag — it does NOT look at `allowedIntegrations` at all. Using it on a route that's scoped to
one specific integration (Twilio settings, HCP sync, Facebook connect, Google Local Services,
shared Gmail, etc.) lets a user who was explicitly restricted to e.g. "facebook-leads" reach
and manage completely unrelated integrations. This was a real High-severity authorization gap
(routes had their own ad-hoc role-only guards, or reused `requireIntegrationManager`).

**How to apply:** Any new or existing route that manages a specific integration must use
`requireIntegrationAccess('<integration-key>')` (or call `canAccessIntegration` inline for
routes with custom response shapes) instead of `requireIntegrationManager`. Reuse the existing
key strings (`AVAILABLE_INTEGRATIONS` in `server/providers/provider-service.ts`, or a service's
own exported constant like `GLS_SERVICE`) rather than inventing new ones. `requireIntegrationManager`
remains appropriate only for genuinely integration-agnostic routes (e.g. generic provider
preference endpoints) — not for anything scoped to one vendor.
