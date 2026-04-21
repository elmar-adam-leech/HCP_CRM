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

## Required env vars

| Var | Purpose |
| --- | --- |
| `GOOGLE_LOCAL_SERVICES_CLIENT_ID`     | OAuth 2.0 client ID from Google Cloud (APIs & Services → Credentials). |
| `GOOGLE_LOCAL_SERVICES_CLIENT_SECRET` | OAuth 2.0 client secret. |
| `GOOGLE_LOCAL_SERVICES_DEVELOPER_TOKEN` | Developer token issued by the Google Ads API team (required by the GLS REST API). |
| `JWT_SECRET` | Reused to sign OAuth state tokens (CSRF). |

## OAuth setup checklist

1. In Google Cloud Console create an OAuth 2.0 client of type "Web
   application".
2. Add this redirect URI:
   `https://<your-host>/api/integrations/google-local-services/callback`
3. Apply for a Google Ads API developer token, set the env var above.
4. Restart the server. The settings card surfaces a clear "Not
   configured" message if either OAuth client or developer token is
   missing.

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

## HCP source mapping

The canonical UI source key for GLS in `lead_source_mapping` is `google`
(`google_local_services` is collapsed via `SOURCE_VARIANT_TO_CANONICAL` in
`server/utils/hcp-helpers.ts`). Contractors can therefore use the existing
"Google" override row in the HCP integration card to control the HCP
`lead_source` label sent for GLS leads. The built-in fallback label is
`Google Local Services`.
