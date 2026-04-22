# Google Local Services (GLS) Ads integration

Pulls leads from a contractor's Google Local Services Ads account into the
CRM. Mirrors the Facebook Lead Ads integration but uses polling — GLS does
not provide real-time webhooks.

## File map

- `server/services/google-local-services-client.ts` — REST client (token
  refresh cache, account list, paginated detailed-lead reports, retry).
- `server/sync/google-local-services-leads.ts` — 5-minute poller and the
  shared `processGlsLead` function (used by the poller and the manual
  `sync-now` route).
- `server/routes/integrations/google-local-services.ts` — OAuth
  connect / callback / disconnect / select-account / sync-now / status
  routes.
- `client/src/components/settings/integrations/GoogleLocalServicesCard.tsx`
  — settings UI card (connect button, account picker, sync-now, last poll
  + last error).

Source key written to `leads.source`: **`google_local_services`**
Integration name (DB / scheduler / credential service): **`google-local-services`**

## Credentials: platform default + per-tenant override

Every GLS API call resolves credentials per tenant via
`server/services/google-local-services-credentials.ts`. The resolver
returns `{ clientId, clientSecret, developerToken, source }` where
`source` reflects which side supplied the developer token (`'tenant'`
or `'platform'`). The OAuth pair (client_id + client_secret) is
resolved as a unit — we never mix tenant client_id with platform
secret.

### Platform-level (env vars)

These are used as the fallback when a tenant has not stored their own.
**They are optional** while the CRM remains an internal tool used by
a single contractor (who configures their own per-tenant credentials).
Provision them when opening the product up to outside contractors.

| Var | Purpose |
| --- | --- |
| `GOOGLE_LOCAL_SERVICES_CLIENT_ID`     | Platform OAuth 2.0 client ID. |
| `GOOGLE_LOCAL_SERVICES_CLIENT_SECRET` | Platform OAuth 2.0 client secret. |
| `GOOGLE_LOCAL_SERVICES_DEVELOPER_TOKEN` | Platform Google Ads developer token (issued to the platform's MCC). |
| `JWT_SECRET` | Reused to sign OAuth state tokens (CSRF). |

### Per-tenant (Settings → Integrations → Google Local Services → Credentials)

Contractors with their own Google Ads MCC can paste:

- **Developer Token** (required to use their MCC) — stored as
  `tenant_developer_token`.
- **OAuth Client ID + Client Secret** (optional) — stored as
  `tenant_client_id` / `tenant_client_secret`. If supplied, the
  Connect Google Account flow runs against *their* OAuth client; the
  resulting refresh token is bound to that client and is automatically
  invalidated if they later change the client_id.

When to use which:

- Internal-only contractor today: set per-tenant credentials, leave
  the platform env vars unset. The card shows "Using your own
  credentials".
- External contractors (future): set the platform env vars; tenants
  without their own MCC silently use them ("Using platform
  credentials"); tenants with their own MCC override.

## OAuth setup checklist

1. In Google Cloud Console (whichever GCP project owns the OAuth
   client — platform's or the tenant's) create an OAuth 2.0 client of
   type "Web application".
2. Add this redirect URI to *that* OAuth client:
   `https://<your-host>/api/integrations/google-local-services/callback`
   The redirect URI is the same for both platform and per-tenant OAuth
   clients.
3. Obtain a Google Ads API developer token (issued by the Google Ads
   API team for that MCC).
4. Either set the env vars (platform default) or paste the values into
   the Credentials section of the GLS settings card (per-tenant).

OAuth scope used: `https://www.googleapis.com/auth/adwords`

## Polling model

- Frequency: every 5 minutes (registered via
  `syncScheduler.onIntegrationEnabled`).
- Defensive recovery on server startup: any contractor with the
  integration enabled but no schedule row gets one re-created (see
  `getContractorsWithGoogleLocalServicesEnabled`).
- Two-window strategy on every poll:
  - **New leads** — since `last_poll_at` (or 7 days back on first run).
  - **Status rechecks** — trailing 60 days, so DISPUTE_APPROVED and
    booked-after-the-fact transitions update the CRM lead in place.
- Cursor (`last_poll_at`) is only advanced when the entire poll succeeds
  with zero per-lead errors. A transient blip thus never leaves a window
  permanently unprocessed.

## Lead matching / dedup

- New leads flow through the shared `ingestLead` pipeline (contact dedup,
  workflows, auto-assignment, HCP push) — same as Facebook leads.
- Re-ingestion of the same Google `leadId` is handled by
  `findLeadByGoogleId`, which looks up the existing CRM lead via the
  `_gls_lead_id` marker embedded in `leads.rawPayload`. When found, the
  existing lead is updated in place (status + raw payload) instead of
  being re-created.

## Operator surfaces

- `/api/integrations/google-local-services/status` returns
  `{ configured, developerTokenSet, connected, accountSelected, enabled,
  accountId, accountName, lastPollAt, lastSuccessAt, lastError,
  lastErrorAt }` — used by the settings card to show health.
- `last_error` and `last_error_at` credentials capture the most recent
  poll failure (typically a Google API auth/permission problem) so it is
  visible to the contractor without needing server logs.

## Disputing leads back to Google

Contractors can dispute a GLS lead from the lead's submission card in the
contact drawer. The action POSTs to:

```
POST /api/integrations/google-local-services/leads/:id/dispute
Body: { reason: GlsDisputeReason, notes?: string }
```

which calls `googleLocalServicesClient.disputeLead`
(`POST {GLS_BASE_URL}/accounts/{accountId}/leads/{leadId}:dispute`). The
result is persisted in the lead's `rawPayload` under internal
`_gls_dispute_*` markers — there is no schema change. Markers used:

| Key | Purpose |
| --- | --- |
| `_gls_dispute_status` | `submitted` / `approved` / `rejected` / `failed`. |
| `_gls_dispute_reason` | Reason code submitted (e.g. `SPAM`). |
| `_gls_dispute_notes` | Optional free-text the user supplied. |
| `_gls_dispute_submitted_at` | ISO timestamp the dispute was sent. |
| `_gls_dispute_response` | Google's raw response body (audit). |
| `_gls_dispute_error` / `_gls_dispute_error_status` | Set when the dispute call failed; cleared on retry success. |

The poller (`processGlsLead`) preserves these markers across re-ingestion
and additionally maps Google's authoritative `disputeStatus` field back
onto `_gls_dispute_status`:

| Google `disputeStatus` | Mapped to `_gls_dispute_status` |
| --- | --- |
| `DISPUTED` | `submitted` (only when no local marker exists — covers disputes filed from the GLS dashboard directly). |
| `DISPUTE_APPROVED` | `approved` (and the lead's CRM status moves to `disqualified`). |
| `DISPUTE_REJECTED` | `rejected`. |

Because the existing 5-minute poller already re-checks the trailing 60-day
window, dispute outcomes flow back into the CRM automatically without a
separate nightly job.

## HCP source mapping

The canonical UI source key for GLS in `lead_source_mapping` is `google`
(`google_local_services` is collapsed via `SOURCE_VARIANT_TO_CANONICAL` in
`server/utils/hcp-helpers.ts`). Contractors can therefore use the existing
"Google" override row in the HCP integration card to control the HCP
`lead_source` label sent for GLS leads. The built-in fallback label is
`Google Local Services`.
