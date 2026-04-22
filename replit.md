# Multi-Tenant CRM System

## Overview
This project is a multi-tenant Customer Relationship Management (CRM) system designed for service-based businesses, primarily HVAC contractors. It aims to streamline customer management, job tracking, estimates, lead nurturing, and communication. The system ensures data isolation between tenants, provides robust role-based access control, and allows users to belong to multiple companies with seamless switching. The vision is to provide a comprehensive, efficient solution for managing business operations and maximizing market potential.

## User Preferences
Preferred communication style: Simple, everyday language.
Performance is a first-class requirement — every change is evaluated for impact on load time, payload size, and end-user device resources. See "Performance & Resource Standards" below.

## System Architecture

### UI/UX Decisions
The frontend uses React with TypeScript, Vite, Wouter for routing, and TanStack Query for state management. It features a custom component library built with Radix UI primitives and Tailwind CSS, inspired by Pipedrive's design with shadcn/ui. The design is mobile-first, responsive, utilizes card-based layouts, and includes light/dark mode theming. Productivity is enhanced via a global command palette (`Cmd+K`) and context-aware keyboard shortcuts. All communication actions (call, email, text, schedule) are standardized through centralized components and hooks.

### Technical Implementations
The backend is built with Node.js and Express.js, providing a RESTful API with consistent error handling. PostgreSQL, managed with Drizzle ORM, ensures type-safe database operations and multi-tenancy. Data validation uses Zod schemas. Authentication is handled with JWT tokens, HTTP-only cookies, and bcrypt for password hashing. The system implements role-based access control and strict tenant data segregation, supporting multi-contractor users with seamless switching and per-contractor roles. Real-time updates are facilitated by WebSockets. Performance is optimized through database indexing, application caching, and query optimization.

### Feature Specifications
- **Multi-Tenancy**: Complete data isolation and secure access control per tenant.
- **Leads, Estimates & Jobs**: Full CRUD operations with a dual-entity architecture (contacts vs. leads) and real-time updates.
- **Communication & Messaging**: SMS integration, unified conversation threads, real-time updates, and automatic activity capture.
- **Gmail Integration**: Per-user OAuth, encrypted token storage, automatic inbox syncing, and email activity capture. Inbound replies whose sender address is not on any contact are matched to the original outbound activity via the RFC822 `In-Reply-To` / `References` headers (stored on outbound activities as `metadata.rfc822MessageId`); the reply is filed against the parent contact (and estimate/job, if any). When the contractor setting `autoLearnReplyAddresses` is on (default), the new sender address is appended to the contact's `emails` so subsequent replies match via the fast sender path.
- **Shared Company Email**: A contractor-level shared Gmail account that any team member can send from. Managed via Settings > Integrations. Workflow emails fall back to the shared email when the creator has no personal Gmail connected. The `shared_email_accounts` table stores one row per contractor with encrypted refresh tokens. The shared inbox is also polled inbound on the gmail sync schedule (every 5 min): replies that thread back to the shared address are matched to existing contacts (including via RFC822 thread headers) and recorded as `email` activities with `user_id = NULL`. The card surfaces a "Last synced" timestamp and a "Sync Now" button. On token expiry the row is cleared and the connecting user (or all contractor admins) is notified.
- **Unified Scheduling System**: Integration with external scheduling platforms, unified calendar views, appointment slot enforcement, and an auto-assignment algorithm for salespeople.
- **Workflow Automation Builder**: A visual, drag-and-drop builder using React Flow, supporting custom node types, tag-based filtering, dynamic variables, templates, execution logs, and manual testing. Active workflow enrollments are visible on lead/estimate cards and detail modals via the `WorkflowEnrollmentBadges` component, with inline stop/cancel controls. Backend endpoint: `GET /api/contacts/:contactId/workflow-enrollments`.
- **Facebook Leads Integration**: Connects a contractor's Facebook Page(s) to automatically ingest leads submitted via Facebook Lead Ads. This includes OAuth flow, two-level webhook subscription, and lead ingestion with tag matching. An automatic 5-minute polling fallback runs via the sync scheduler to catch leads that the webhook misses (subscription drops, Meta delivery delays, etc.).
- **Dialpad Integration**: Handles calling, SMS, and call recording for contractors using Dialpad. This includes company numbers management, user call preferences, and SMS/call event ingestion with robust recording URL extraction. Write operations are never retried.
- **HCP (Housecall Pro) Integration**: Full bi-directional sync for contacts, estimates, and jobs with echo suppression, two-tier webhook authentication, and a read-only guard for HCP-owned fields. Includes booking and calendar sync.
- **Lead Capture / Public Booking**: Provides a public-facing booking page for prospective customers to schedule an estimate, including HCP calendar sync on submission and structured address capture.
- **Google Maps Address Autocomplete**: Wraps the Google Places API (v1) for address autocomplete in lead forms and public booking pages, handling session tokens, referrer headers, and address normalization.
- **Reports**: A Reports page with the existing Leads Trend chart and a "Speed to Lead by Salesperson" report. The report aggregates outbound calls per salesperson per lead in a date range (7d/30d/90d/Year), surfacing leads called, median/avg time-to-first-call, average calls per lead (overall, scheduled-only, and scheduled-excluding-self-booked), plus a stacked-bar speed-bucket distribution. Backed by `GET /api/reports/speed-to-lead` (`server/services/speed-to-lead-report.ts`).

### Database Schema Migrations
There is **one** source of truth for ongoing database schema changes: the `columnMigrations` array in `server/db.ts`. It runs idempotent SQL (`ALTER TABLE … ADD COLUMN IF NOT EXISTS …`, `CREATE TABLE IF NOT EXISTS …`, etc.) on every boot, so every tenant database stays in sync with the Drizzle schema in `shared/schema/*`.

The `migrations/` folder contains only the historical drizzle-kit bootstrap (`0000_*.sql` plus prior snapshots) used when provisioning a brand-new database. **Do not** roll out new columns by adding standalone SQL files there, by running `drizzle-kit push`, or by ad-hoc psql — those paths only touch one database and silently leave existing tenants behind, which is what caused the recurring "column does not exist" 500s (tasks #432, #433, #434).

A `runSchemaDriftCheck()` step runs at the end of `initDb()` and crashes startup loudly when any Drizzle-declared table or column is missing from the live database, so drift surfaces immediately at deploy time instead of as a 500 on a user-facing page later. The fix when it fires is always the same: add an idempotent statement to `columnMigrations` and redeploy.

**Process rule:** any new column added to `shared/schema/*` MUST ship in the same PR with a matching `columnMigrations` entry in `server/schema-drift.ts`. When `npm run db:push --force` is blocked (e.g. by an unrelated drizzle-kit interactive prompt), the `columnMigrations` entry is the **only** acceptable substitute — never roll out columns via ad-hoc psql or new files in `migrations/`. Task #473 is the canonical example of what happens when this is skipped (deploy promote fails on schema drift).

### Performance & Resource Standards
Every change must pull its weight in load time, network bytes, JS bundle size, DB time, and battery on the end user's device — the same way every change is held to tenant isolation.

**Always do:**
- Paginate any list endpoint that can grow; keep `LIMIT` on every list query.
- Use TanStack Query caching with correct, array-form query keys for hierarchical data so invalidation is precise.
- Lazy-load route components and code-split per route; gate optional/heavy features behind dynamic imports.
- Prefer server-side aggregation (SQL `GROUP BY`, CTEs, window functions) over shipping rows to the client to be summed.
- Prefer `EXISTS` subqueries (or single joined aggregates) over per-row API calls or N+1 fetches in render paths.
- Debounce expensive inputs (search boxes, autocomplete, filter changes).
- Virtualize lists that can render ≥200 rows.
- Ship images at the resolution actually rendered; respect viewport pixel width.
- All HTTP responses are gzip-compressed by `compression` middleware in `server/index.ts`; content-hashed `/assets/*` files are served with `max-age=1y, immutable` in `server/vite.ts`.

**Never do:**
- No unbounded list fetches (no endpoint that returns "all rows for the tenant" without `LIMIT`/cursor).
- No per-row API calls inside a render path or map.
- No synchronous heavy work on the main thread (parse, hash, large transforms — push to a worker or to the server).
- No shipping >100KB of vendor JS for a single feature without a written justification.
- No polling intervals < 30s without a strong reason documented in the task.
- No rendering 500+ DOM nodes when a paginated or virtualized list will do.
- No images larger than the viewport pixel width they're rendered at.

**When in doubt:** every task plan includes a one-line "Performance note" explaining how the change satisfies these standards — even if it's just "no impact — pure UI text change."

**In-repo precedents to model after:** server-side pagination on Pending/In-progress/Lost reports (#561, #564); the canonical-row CTE that eliminated ~6,000 phantom rows in reports (#552); `EXISTS` subqueries powering the `autoDisputed` flag on contacts (#574).

### System Design Choices
- **Frontend**: React, TypeScript, Vite, Wouter, TanStack Query, Radix UI, Tailwind CSS.
- **Backend**: Node.js, Express.js, PostgreSQL, Drizzle ORM, Zod.
- **Real-time**: WebSocket-based architecture with reconnect/stale-data banner in DashboardLayout.
- **Security**: HTTP-only cookies, role-based access control, AES-256-GCM encryption, JWT revocation, `tokenVersion` for sign-out-all-devices.
- **PWA**: Installable to home screen with standalone display for field techs.
- **Mobile UX**: Fixed bottom nav bar, mobile-first page padding, responsive headers, mobile quick actions.
- **Call Preference**: Per-user setting for 'integration' or 'personal' calling.
- **Lead Archive**: Soft-hiding leads instead of deletion, with an option to view/restore archived leads.
- **Contacts Page**: Grid view with side sheet details, full deletion, search, record counts, and quick-links.
- **Smart Delete**: Orphan cleanup; deleting a lead/estimate/job also deletes the contact if no other records are linked.

## External Dependencies

- **PostgreSQL**: Primary database for all system data, managed with Drizzle ORM.
- **React**: Frontend UI library.
- **Node.js/Express.js**: Backend server runtime and web framework.
- **Vite**: Frontend build tool.
- **Wouter**: Frontend routing library.
- **TanStack Query**: Frontend data fetching and state management.
- **Radix UI**: Frontend component primitives.
- **Tailwind CSS**: Utility-first CSS framework.
- **Zod**: Schema validation library.
- **bcrypt**: Password hashing library.
- **WebSockets**: For real-time communication.
- **Google APIs**:
    - **Gmail API**: For per-user email synchronization and activity capture.
    - **Google Places API (v1)**: For address autocomplete and details for lead forms and public booking.
- **Facebook Graph API**: For Facebook Lead Ads integration and lead ingestion.
- **Dialpad API**: For telephony integration (calling, SMS, call recording, company numbers).
- **Housecall Pro API**: For bi-directional sync of contacts, estimates, and jobs, and scheduling.
    - HCP option `approval_status` emits space-separated variants like `pro declined`, `customer declined`, and `pro approved` (in addition to the legacy underscored forms). Always use the predicates in `server/sync/hcp-mappers.ts` (`isHcpDeclinedOptionStatus`, `isHcpApprovedOptionStatus`, `isHcpRejectedEstimateStatus`, `isHcpExcludedEstimateStatus`) — never hard-code the literal strings.
    - Parent estimate → `'rejected'` mapping: a multi-option estimate is only rejected when EVERY option is terminal (declined OR expired) AND at least one is actually declined. "Any approved wins" still short-circuits to `'approved'` first. WARNING: this rule was previously bugged with `.some` (any single declined option flipped the parent), causing ~493 estimates to land in Rejected with mixed approved/pending siblings — see Task #484. The webhook handler for `estimate.option.approval_status_changed` always re-derives the parent from the freshly fetched full options array via `mapHcpEstimateStatus`; it does not infer parent state from the single-option event payload alone. `scripts/revert-misflipped-rejected.ts` is the idempotent revert sweep for the historical sweep.
- **React Flow**: Frontend library used for the Workflow Automation Builder UI.
- **AES-256-GCM**: Encryption standard used for sensitive data.
- **SendGrid**: (Implied by credential storage) For email sending capabilities.
- **Twilio**: (Implied by webhook service enum) Likely used for SMS capabilities.
