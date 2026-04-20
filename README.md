# HCP CRM

A multi-tenant CRM built for field service businesses — HVAC contractors and similar trades. Manages the full customer lifecycle: lead capture, estimates, job scheduling, automated follow-ups, and two-way communication (SMS, calling, Gmail), all from a single interface.

---

## Features

- **Leads, Estimates & Jobs** — Full pipeline management with a kanban and list view, status tracking, bulk actions, and real-time updates via WebSockets
- **Contacts** — Unified contact records linked across leads, estimates, and jobs with deduplication, tagging, and follow-up scheduling
- **Workflow Automation** — Visual drag-and-drop builder (React Flow) for automated sequences triggered by business events: send SMS/email, update statuses, assign users, add delays, run AI actions, and branch on conditions
- **Gmail Integration** — Per-user OAuth connection; syncs inbox automatically and captures email threads against contact records
- **SMS & Calling** — Dialpad integration for two-way SMS conversations and click-to-call directly within the CRM; unified message threads per contact
- **Housecall Pro Sync** — Webhook-driven import of customers, jobs, and estimates from HCP; bidirectional status mapping
- **Scheduling** — Unified calendar view, appointment slot enforcement, and auto-assignment algorithm for salespeople
- **AI Monitor** — Conversation analysis, lead scoring, and AI-generated responses via xAI (Grok)
- **Dashboard & Reports** — Live metrics (speed-to-lead, set rate, conversion), follow-up widgets, and trend charts (Recharts)
- **Multi-Tenancy** — Complete data isolation per company; users can belong to multiple companies and switch between them without re-logging in
- **Role-Based Access** — Four roles: `super_admin`, `admin`, `manager`, `user` with per-route enforcement
- **PWA** — Installable on mobile home screens; fixed bottom navigation bar optimised for field technicians

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite |
| Routing | Wouter |
| Server state | TanStack Query v5 |
| UI | Radix UI primitives, shadcn/ui, Tailwind CSS, Lucide icons |
| Workflow builder | React Flow |
| Charts | Recharts |
| Backend | Node.js, Express.js, TypeScript (`tsx`) |
| Database | PostgreSQL (Neon serverless), Drizzle ORM |
| Validation | Zod + drizzle-zod |
| Auth | JWT (HTTP-only cookies), bcrypt, token revocation table |
| Real-time | WebSockets (`ws`) |
| Email (transactional) | SendGrid |
| SMS / Calling | Dialpad API |
| Gmail | Google OAuth 2.0 |
| AI | xAI (Grok) API |

---

## Project Structure

```
├── client/                  # React frontend (Vite)
│   └── src/
│       ├── components/      # Shared UI components
│       ├── hooks/           # Custom React hooks
│       ├── lib/             # API client, query setup
│       └── pages/           # Route-level page components
├── server/                  # Express backend
│   ├── middleware/          # Auth, rate limiting, error handling
│   ├── providers/           # SMS, email, calling provider adapters
│   ├── routes/              # REST API route handlers
│   ├── services/            # Business logic (workflow engine, AI, deduper, etc.)
│   ├── storage/             # Drizzle query layer (one file per domain)
│   └── utils/               # Shared server utilities
├── shared/
│   └── schema/              # Drizzle table definitions + Zod schemas (shared by client & server)
├── migrations/              # Auto-generated Drizzle migration files
└── .env.example             # Environment variable reference
```

---

## Prerequisites

- **Node.js** 20+
- **PostgreSQL** database (local or [Neon](https://neon.tech) recommended)
- A `.env` file — copy `.env.example` and fill in the required values

---

## Local Setup

```bash
# 1. Clone the repo
git clone https://github.com/your-org/hcp-crm.git
cd hcp-crm

# 2. Install dependencies
npm install

# 3. Configure environment variables
cp .env.example .env
# Edit .env — DATABASE_URL and JWT_SECRET are the minimum required values

# 4. Push the database schema
npm run db:push

# 5. (Optional) Seed an admin account
npx tsx server/scripts/seed.ts

# 6. Start the development server
npm run dev
```

The app runs on **http://localhost:5000** by default. The Express API and Vite dev server share the same port.

---

## Environment Variables

All variables are documented in `.env.example` with descriptions and generation commands. The minimum set to get the app running locally:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Random 64-byte hex string used to sign tokens |
| `CREDENTIAL_ENCRYPTION_KEY` | Random 32-byte hex string for encrypting stored OAuth tokens |
| `NODE_ENV` | `development` or `production` |

Optional variables enable specific integrations: `GOOGLE_OAUTH_CLIENT_ID` / `SECRET` for Gmail, `SENDGRID_API_KEY` for transactional email, `DIALPAD_API_KEY` for SMS/calling, `XAI_API_KEY` for AI features. The app starts and runs without them — those features are simply disabled.

---

## Available Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start Express + Vite dev servers on port 5000 |
| `npm run build` | Build frontend (Vite) and backend (esbuild) to `dist/` |
| `npm run start` | Run the production build |
| `npm run check` | TypeScript type-check (no emit) |
| `npm run db:push` | Sync Drizzle schema to the database |

---

## Database

The schema lives in `shared/schema/` as Drizzle table definitions, split by domain (`contacts.ts`, `jobs.ts`, `leads.ts`, etc.). All tables are re-exported through `shared/schema/index.ts`.

After any schema change, run:

```bash
npm run db:push
```

> **Note:** `drizzle.config.ts` is pre-configured and should not be modified.

---

## Authentication

- Credentials are stored with bcrypt (12 rounds)
- JWTs are issued on login and set as `httpOnly` cookies (7-day sliding expiry)
- Individual tokens can be revoked (stored in `revoked_tokens` table)
- All active sessions for a user can be invalidated at once via the `tokenVersion` column on `users`
- Multi-company users receive a new JWT on each company switch — no re-login required

---

## Deployment

Build the app:

```bash
npm run build
```

This produces:
- `dist/public/` — Static frontend assets (serve with any CDN or Express static middleware)
- `dist/index.js` — Bundled Express server

Set `NODE_ENV=production` and all required environment variables on your host, then:

```bash
npm run start
```

The server serves both the API and the static frontend from the same process on `PORT` (default 5000).
