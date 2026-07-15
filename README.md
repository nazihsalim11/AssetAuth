# AssetFlow — Enterprise Asset Lifecycle & AMC Platform

AssetFlow is a web application for tracking the full lifecycle of organizational
assets — procurement, allocation, movement, maintenance (AMC), depreciation, and
retirement — with QR-code identification, a helpdesk/SLA ticketing system,
role-based access control, and real-time dashboards and reports.

> Product and scope details live in [`PRD.md`](./PRD.md) and
> [`Instruction.md`](./Instruction.md). The Convex migration tracker is
> [`todo.md`](./todo.md).

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19 + Vite 8 (JavaScript / JSX), framer-motion, lucide-react, plain CSS. Tab-based SPA (no router library). |
| QR / export | `qrcode` (generation), `html5-qrcode` (scanning), `jspdf` (PDF), `xlsx` (Excel / CSV) |
| Backend | Node.js ≥ 22 + Express 4 — REST API, all routes under `/api` |
| Data & files | [Convex](https://convex.dev) (serverless) — functions in `backend/convex/`, schema in `backend/convex/schema.js` |
| Auth | [WorkOS](https://workos.com) User Management — embedded email + password; HTTP-only JWT session cookie; RBAC roles stored in the app's Convex data |
| Notifications | `nodemailer` (SMTP email) + `twilio` (SMS), scheduled with `node-cron` (or driven over HTTP via `/api/internal/cron/*`) |
| Hosting | Backend on Render (Node web service); frontend static build on Vercel; Convex Cloud for data |

## Repository layout

```
src/                 React frontend
  features/          Page modules (assets, amc, finance, reports, users, …)
  context/           App-wide data context
backend/
  server.js          Express app entry point
  src/routes/        REST route handlers (auth, assets, tickets, …)
  src/middleware/    Auth middleware (WorkOS + JWT + RBAC)
  convex/            Convex functions + schema (the data store)
  notifications/     Email/SMS channels, templates, cron scheduler
PRD.md               Product Requirements Document
Instruction.md       Project scope document
todo.md              Convex migration tracker
```

## Prerequisites

- Node.js ≥ 22 (`backend/.nvmrc` pins 22)
- A [Convex](https://convex.dev) project (provides `CONVEX_URL`)
- A [WorkOS](https://workos.com) account with **Email + Password** authentication enabled

## Local development

**Frontend** (repo root):

```bash
npm install
npm run dev          # Vite dev server on http://localhost:5173
                     # (proxies /api → http://localhost:5000)
```

**Backend** (`backend/`):

```bash
cd backend
cp .env.example .env # then fill in the values below
npm install
npx convex dev       # first run: deploys Convex functions and prints CONVEX_URL
npm run dev          # Express API on http://localhost:5000 (node --watch)
```

**Create the first Super Admin** — either set `BOOTSTRAP_ADMIN_EMAIL` and sign in
once, or provision one directly (creates the WorkOS login and seeds the profile):

```bash
node createAdmin.js <email> <password>
```

## Environment variables

**Backend** (`backend/.env` — see [`backend/.env.example`](./backend/.env.example) for full notes):

| Variable | Purpose |
| --- | --- |
| `CONVEX_URL` | Deployment URL of the Convex project (the data store) |
| `JWT_SECRET` | Signs the session cookie — **required in production** |
| `WORKOS_API_KEY` / `WORKOS_CLIENT_ID` | WorkOS credentials (login is disabled without the API key) |
| `WORKOS_REDIRECT_URI` | OAuth callback URL (legacy hosted flow) |
| `BOOTSTRAP_ADMIN_EMAIL` | Email provisioned as Super Admin on first sign-in |
| `FRONTEND_URL` | Public site URL — logout/callback base |
| `ALLOWED_ORIGINS` | Comma-separated CORS allow-list |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` | Email delivery (unset ⇒ logged, not sent) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | SMS delivery (optional) |
| `DISABLE_INTERNAL_CRON` / `CRON_SECRET` | Use external cron instead of in-process `node-cron` |

**Frontend** (build-time, inlined by Vite):

| Variable | Purpose |
| --- | --- |
| `VITE_API_URL` | Backend API origin, e.g. `https://assetauth.onrender.com/api` (defaults to `http://localhost:5000/api`) |

## WorkOS dashboard setup (one-time, manual — not in the repo)

1. **Configuration → Authentication →** enable **Email + Password** (embedded login
   returns 401 without it).
2. **Redirects:**
   - App homepage URL → `FRONTEND_URL` (fixes the logout error page)
   - Logout redirect → `FRONTEND_URL`
   - Redirect URI → `FRONTEND_URL/api/auth/callback`
3. Create the bootstrap admin **with a password** (or use Forgot Password to set
   one), then sign in once to seed the Super Admin profile.

WorkOS is the sole owner of credentials — the app never stores passwords.

## Scripts

**Frontend** (root `package.json`):

| Script | Action |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Production build |
| `npm run preview` | Preview the production build |
| `npm run lint` | Oxlint |
| `npm test` | `node --test` (frontend + backend `.test.mjs`) |

**Backend** (`backend/package.json`):

| Script | Action |
| --- | --- |
| `npm start` | `node server.js` |
| `npm run dev` | `node --watch server.js` |
| `npm run wipe:convex` | Wipe the Convex data (dev utility) |
| `npm run cleanup:orphans` | Repair orphaned references (`--dry-run` for a preview) |

Live deployments:

- Frontend (Vercel): <https://asset-auth.vercel.app>
- Backend (Render): <https://assetauth.onrender.com>

Deployment notes:

- **Backend → Render** (Node web service). The free tier caps memory at 512 MB,
  which is why the backend runs on Convex rather than an in-process database. If
  the instance sleeps when idle, set `DISABLE_INTERNAL_CRON=true` + a `CRON_SECRET`
  and drive `/api/internal/cron/*` from an external scheduler so the daily expiry
  sweep, hourly SLA check, and failed-send retries still run.
- **Frontend → Vercel** static build. Set `VITE_API_URL` to
  `https://assetauth.onrender.com/api`.
- **Convex →** `npx convex deploy`.
