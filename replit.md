# Multi-Tenant CRM System

## Overview
This project is a multi-tenant Customer Relationship Management (CRM) system for service-based businesses, primarily HVAC contractors. It aims to streamline customer management, job tracking, estimates, lead nurturing, and communication. The system ensures data isolation, provides robust role-based access control, allows seamless multi-company user switching, and focuses on efficient business operations and market potential.

## User Preferences
Preferred communication style: Simple, everyday language.
Performance is a first-class requirement — every change is evaluated for impact on load time, payload size, and end-user device resources.

## System Architecture

### UI/UX Decisions
The frontend uses React with TypeScript, Vite, Wouter, and TanStack Query. It features a custom component library built with Radix UI and Tailwind CSS, inspired by Pipedrive's design with shadcn/ui. The design is mobile-first, responsive, uses card-based layouts, and includes light/dark mode theming. Productivity is enhanced via a global command palette and context-aware keyboard shortcuts. All communication actions are standardized through centralized components and hooks.

### Technical Implementations
The backend is built with Node.js and Express.js, providing a RESTful API. PostgreSQL, managed with Drizzle ORM, ensures type-safe database operations and multi-tenancy. Data validation uses Zod schemas. Authentication uses JWT tokens, HTTP-only cookies, and bcrypt. The system implements role-based access control and strict tenant data segregation, supporting multi-contractor users with seamless switching. Real-time updates are facilitated by WebSockets. Performance is optimized through database indexing, application caching, and query optimization. Database schema changes are managed via idempotent `columnMigrations` in `server/db.ts` to ensure all tenant databases stay in sync.

### Feature Specifications
- **Multi-Tenancy**: Data isolation and secure access control per tenant.
- **Leads, Estimates & Jobs**: Full CRUD operations with dual-entity architecture (contacts vs. leads) and real-time updates.
- **Communication & Messaging**: SMS integration, unified conversation threads, and automatic activity capture.
- **Gmail Integration**: Per-user OAuth, encrypted token storage, automatic inbox syncing, and email activity capture with intelligent reply matching. Includes a shared company email feature.
- **Unified Scheduling System**: Integration with external platforms, unified calendar views, appointment slot enforcement, and auto-assignment.
- **Workflow Automation Builder**: Visual, drag-and-drop builder using React Flow, supporting custom nodes, dynamic variables, and execution logs.
- **Facebook Leads Integration**: Automatic ingestion of leads from Facebook Lead Ads via OAuth and webhooks, with a polling fallback.
- **Dialpad Integration**: Handles calling, SMS, and call recording, including company numbers management and event ingestion.
- **HCP (Housecall Pro) Integration**: Full bi-directional sync for contacts, estimates, and jobs with echo suppression and two-tier webhook authentication. Includes booking and calendar sync.
- **Lead Capture / Public Booking**: Public-facing booking page for estimates, including HCP calendar sync and structured address capture. Booker-typed notes are pre-staged via `POST /leads/{leadId}/notes` before convertLead so HCP carries them into the resulting estimate, with a verification re-fetch and bounded retry; on failure the booker sees a warning banner and contractor admins receive a SendGrid email. Fix is forward-looking only — historical bookings (e.g. pre-fix records like Meagan Petri) are not backfilled.
- **Google Maps Address Autocomplete**: Integrates Google Places API for address autocomplete.
- **Reports**: Provides reports like Leads Trend and "Speed to Lead by Salesperson".
- **AI Scheduling Agent (settings only — task #697 agent itself still being built)**: Per-contractor admin-only settings on the Account tab to (a) toggle the AI SMS scheduling agent on/off, (b) edit a free-text "Personality & Tone" prompt, and (c) edit a "Company Context" prompt. Stored on `contractors` (`ai_scheduling_enabled`, `ai_scheduling_personality`, `ai_scheduling_company_context`) and managed via `GET`/`PATCH /api/settings/ai-scheduling` (admin-only). UI lives in `client/src/components/settings/account/AiSchedulingAgentCard.tsx`. The runtime agent that consumes these values is built separately under task #697.
- **Real-time**: WebSocket-based architecture with reconnect/stale-data banner.
- **Security**: HTTP-only cookies, role-based access control, AES-256-GCM encryption, JWT revocation, `tokenVersion` for sign-out-all-devices. Persistent PWA login uses a 90-day `refresh_token` httpOnly cookie alongside the 7-day `auth_token`; the SPA silently re-mints the auth token via `POST /api/auth/refresh` (single in-flight, refresh rotates the row) when any `/api/*` call returns 401, so iOS Safari evicting the auth cookie no longer logs the user out. The refresh endpoint enforces a 30-second rotation grace window — re-arrivals of an already-rotated token within that window succeed without re-rotating (covers in-flight retries / network re-sends), while reuse past the window is treated as a replay attack and hard-revokes the row. Two stacked rate limiters guard the endpoint: 10/min per-IP and 5/min per-refresh-token (so a leaked cookie cannot be brute-forced from a botnet).
- **PWA**: Installable to home screen for field techs.
- **Mobile UX**: Fixed bottom nav bar, mobile-first padding, responsive headers, quick actions.
- **Call Preference**: Per-user setting for 'integration' or 'personal' calling.
- **Lead Archive**: Soft-hiding leads with view/restore options.
- **Contacts Page**: Grid view with side sheet details, full deletion, search, and quick-links.
- **Smart Delete**: Orphan cleanup; deleting a lead/estimate/job also deletes the contact if no other records are linked.

## External Dependencies

- **PostgreSQL**: Primary database.
- **React**: Frontend UI.
- **Node.js/Express.js**: Backend runtime and framework.
- **Vite**: Frontend build tool.
- **Wouter**: Frontend routing.
- **TanStack Query**: Frontend data fetching and state management.
- **Radix UI**: Frontend component primitives.
- **Tailwind CSS**: CSS framework.
- **Zod**: Schema validation.
- **bcrypt**: Password hashing.
- **WebSockets**: Real-time communication.
- **Google APIs**: Gmail API, Google Places API.
- **Facebook Graph API**: For Lead Ads.
- **Dialpad API**: Telephony integration.
- **Housecall Pro API**: CRM and scheduling integration.
- **React Flow**: Workflow automation builder UI.
- **AES-256-GCM**: Encryption standard.
- **Twilio**: (Implied) SMS capabilities.
- **lucide-react**: Icon library.