# Valor & Wellbeing Hub — handoff notes

Workforce, property-operations and governance platform for Valor Housing Ltd, Wellbeing Homes Ltd and Wellbeing Housing Ltd.
The full specification is in the original prompt (42 sections). **Agreed scope for this phase: stages 1–3** (foundation, staff/appointments/clearance, properties/visits/tasks/timesheets). Stages 4–8 are tracked as outstanding.

## Stack
- React + TypeScript + Vite (web/), Node + Express + TypeScript (server/), Postgres via Supabase, hosted on Render.
- Single package: `npm run dev` runs API (tsx) + Vite. `npm run build` → `vite build` + `tsc -p tsconfig.server.json`.
- Installed deps: express, pg, jose, zod, multer, helmet, express-rate-limit, @supabase/supabase-js, react, react-router-dom, @fontsource-variable/inter; dev: vite, vitest, supertest, playwright, @axe-core/playwright, tsx, concurrently.

## Done so far (stages 1–3 delivered 20 Oct 2026)
- Schema: `db/migrations/001–003` (003 adds scheduled_visits, notifications, lone-worker ack, dev-only file_blobs). Seed: fictional data, 17 properties.
- API (`server/`): auth.ts (Supabase JWT or dev token, MFA gate, leaver block), perm.ts (per-company perms), visibility.ts (row rules reused by lists/search/files), clearance.ts, storage.ts (Supabase bucket or Postgres blobs in dev), routes/{core,inbox,people,properties,visits,tasks,admin}.ts.
- Web (`web/`): React app, pages per area, styles.css tokens, PWA (manifest, sw.js shell-only, PNG icons from scripts/icons.ts).
- Tests: `tests/acceptance.test.ts`, 32 passing on real Postgres (`hub_test`). axe-core: 0 WCAG 2.2 A/AA violations on 16 pages + dialogs.
- Docs: README.md, docs/ADMIN.md, docs/REQUIREMENTS.md (tracker — keep it updated), render.yaml, .env.example.
- Local DB: `npm run db:local` (embedded Postgres in .pgdata, UTF-8). Dev: `npm run dev` (API_PORT=3000, Vite 5173 proxies `^/api/`).

## Stage 4 (20 Oct 2026)
- Migration 004 + `server/kpi.ts` (one SQL computes all KPI counts; definition version chosen by month) + `routes/performance.ts` + `web/pages/Performance.tsx`. Tests: `tests/performance.test.ts` (10). Chart colour token `--chart-1` (#008C80, validated).

## Gotchas learned
- Zod 4 applies `.default()` inside `.partial()` — keep defaults on create schemas only, or PATCH silently resets fields.
- Relative imports use `.ts` extensions (tsx in dev, `rewriteRelativeImportExtensions` on build).
- `position:absolute` sr-only text inside scroll containers escapes them unless the container is `position:relative`.
- Teal #0E8A7D fails AA for text on white; use `--teal-text` #0A6B61.
- Visits under a minute round to 0 and allocate nothing (never invent time).

## Design decisions to keep
- An active appointment implicitly grants the `staff` permission set in that company; explicit `role_grants` add more. Access = appointment OR grant.
- Backend auth: verify Supabase JWT (HS256 via `SUPABASE_JWT_SECRET`, else JWKS from `SUPABASE_URL`). Link `people.auth_user_id` on first login by email. If person holds a privileged role and `aal !== 'aal2'` → 403 `mfa_required`.
- `DEV_AUTH=true` (never in production; refuse to boot) enables a dev sign-in for seeded fictional users, for local demo and Playwright.
- Visits: on approval create a single allocation for the full duration; splitting replaces allocations and must sum to the duration. Approved correction → visit back to `submitted`, allocations cleared.
- No self-approval of visits, corrections, timesheets.
- Ending an appointment: require task transfer target if open tasks exist, end property allocations, revoke that company's grants if no other active appointment there. Other appointments untouched.
- Clearance: company `clearance_rule` warn/block; override needs `clearance.override` + reason → `clearance_exceptions`.
- Timesheet cost = per-day minutes × effective rate, computed in SQL numeric; labelled "estimate — not payroll".
- Future migrations must re-run the RLS/revoke block for new tables.

## Next steps
Stage 5 done (migration 005, `routes/training.ts`, `routes/policies.ts`, `web/pages/Training.tsx`, `Policies.tsx`, `tests/training.test.ts`; SQL function `training_matrix(as_of)` is the single source for training status). Stage 6 done (migration 006; `routes/governance.ts`, `cases.ts`, `estates.ts`; pages Governance, Concerns, Estates; `tests/governance.test.ts`). Agent users: `Access.agentIds` (agent_users table), no company perms, agent-only shell. Stage 7 done (migrations 007/008, `routes/finance.ts`, `routes/messaging.ts`, `server/outbox.ts` email-only worker started in index.ts, pages Finance/Messages/News, `tests/finance.test.ts`). WhatsApp PAUSED by the owner: tables exist, no code sends. Note: Express 5 `/:step` routes must `next()` for unknown steps or they shadow later routes. Stage 8 done (migration 009, `routes/ai.ts`, `routes/dataops.ts`, `server/csv.ts`, pages Assistant/DataTools incl. /install; tests ai, csv, dataops). Leftovers: onboarding templates, job descriptions, competence, leave/cover. Audit findings 5–13 open.
