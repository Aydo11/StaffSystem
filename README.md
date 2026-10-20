# Valor & Wellbeing Hub

**People · Performance · Properties · Governance** — a workforce, property-operations and governance platform for Valor Housing Ltd, Wellbeing Homes Ltd and Wellbeing Housing Ltd.

This release delivers **stages 1–3** of the specification: design system, companies, sign-in and permissions; staff profiles, appointments and clearance; properties, visits, attendance, tasks, handover and timesheets. Later stages are listed in [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) and are shown in the Admin Centre as "Not built yet".

Tenant and support case management is deliberately **not** part of this system (see the specification's exclusions). The only link to it is the per-company "Open Support System" shortcut.

## Stack

| Layer | Choice |
| --- | --- |
| Web | React 19 + TypeScript, Vite, React Router. Inter font, no UI framework. |
| API | Node 22 + Express 5 + TypeScript, Zod validation |
| Data | PostgreSQL (Render Postgres in production). Plain SQL migrations in `db/migrations`. |
| Auth | The Hub's own: invitation links, email + password (scrypt), resets, TOTP two-step verification, server-side sessions. |
| Files | Stored in Postgres (`file_blobs`), read only through the API |
| Hosting | Render web service (`render.yaml`), single origin for web + API |

All business data lives in Postgres. Every table has row-level security switched on with **no** policies, so browsers cannot query tables directly; the API enforces permissions.

## Run it locally

Needs Node 22+. No Postgres install is needed.

```bash
npm ci
cp .env.example .env
npm run db:local        # terminal 1: starts a local Postgres (leave running)
npm run db:reset        # terminal 2: creates tables and fictional demo data
npm run dev             # API on :3000, web on http://localhost:5173
```

With `DEV_AUTH=true` the sign-in page shows **Demo sign-in** for the fictional accounts (for example Sam Rivers, who has appointments in all three companies, and Priya Shah, a Valor Housing manager).

## Tests

```bash
npm test                # 32 acceptance tests against a real Postgres database (hub_test)
npm run typecheck
```

Tests reset the `hub_test` database before each test. They refuse to run against a database whose name does not end in `_test`.

## Deploy

See [docs/ADMIN.md](docs/ADMIN.md) for Render setup, sign-in, environments, backups and the first administrator.

## Project layout

```
db/migrations/   numbered SQL migrations (applied once each by `npm run migrate`)
db/seed.sql      fictional demonstration data (refused in production)
server/          API: auth, permissions, visibility rules, routes
web/             React app and PWA files (web/public)
tests/           acceptance tests
scripts/         migrate, reset, local Postgres, icon generator
docs/            administrator guide and requirement tracker
```
