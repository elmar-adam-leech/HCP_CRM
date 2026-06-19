---
name: Lead pipeline stage derivation
description: How Leads page + dashboard KPIs derive pipeline stage from the leads table instead of contacts.status
---

# Lead pipeline "effective stage" is derived, not stored

Pipeline stage shown on the Leads page (and counted in dashboard KPIs) is a
DERIVED projection of lead facts, NOT a raw `contacts.status` read. With
one-row-per-person on the Leads page, the displayed stage comes from the
contact's MOST RECENT OPEN lead (+ booking), so a fresh inbound lead for an
existing customer resolves to "new".

The single source of truth is `effectiveStageSql(contractorId)` in
`server/storage/lead-stage.ts` (a correlated CASE subquery over `leads`).
Reused by the Leads list filter, the status-counts query, and the
`getContactsPaginated` select.

## Scope rule (important)
- **lead-ONLY scope** (`effectiveTypes.length === 1 && [0] === 'lead'`) →
  filter/sort by `effectiveStage`.
- **customer / multi-type (incl. lead) / header-search** → keep RAW
  `contacts.status` (those surfaces have no lead-pipeline derivation). e.g.
  `types: ['lead','customer']` is NOT lead-only, so it still uses
  `ne(contacts.status,'disqualified')`.

## Enum-cast gotcha
`leads.status` is the `contact_status` enum (NOT a separate lead enum). Any
CASE/COALESCE that mixes `leads.status` with a text fallback (or compares
across the `contacts.status` enum) MUST cast every branch to `::text`, or
Postgres throws "CASE types ... cannot be matched" / "is of type
contact_status but expression is of type text". Manual status writes that
mirror a stage onto a lead row must cast the literal back to the enum.

## Dashboard re-base
`server/services/dashboard-metrics.ts` (`getDashboardMetrics` +
`getMetricsAggregates`) read `leads` (per-lead grain), windowed by
`leads.created_at`, `archived=false`. Definitions shared with the Leads page:
Total=COUNT(leads); Disqualified=status='disqualified' (NOT 'lost');
Set=convertedToEstimateId IS NOT NULL; SetRate=set/(total−disqualified);
Speed=AVG(contacted_at−created_at). Non-admin scoping: set/touched →
`assigned_to_user_id`; contacted/speed → `contacted_by_user_id`. Consumer
`business-metrics.ts` reads `scheduledLeads` (now = set count) /
`contactedLeads` / `avgSpeedToLeadHours` — preserve those field names.

**Why:** two submissions from one person must count as two leads, and an
existing customer re-entering the pipeline must show as a new lead, which a
single `contacts.status` column cannot represent.
