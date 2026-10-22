# Valor & Wellbeing Hub — handoff notes

Workforce, property-operations and governance platform for Valor Housing Ltd, Wellbeing Homes Ltd and Wellbeing Housing Ltd.
The full specification is in the original prompt (42 sections). **Agreed scope for this phase: stages 1–3** (foundation, staff/appointments/clearance, properties/visits/tasks/timesheets). Stages 4–8 are tracked as outstanding.

## Stack
- React + TypeScript + Vite (web/), Node + Express + TypeScript (server/), Render Postgres, hosted on Render (Supabase removed 20 Oct 2026 at the owner's request).
- Single package: `npm run dev` runs API (tsx) + Vite. `npm run build` → `vite build` + `tsc -p tsconfig.server.json`.
- Installed deps: express, pg, zod, multer, helmet, express-rate-limit, qrcode, @anthropic-ai/sdk, react, react-router-dom, @fontsource-variable/inter; dev: vite, vitest, supertest, playwright, @axe-core/playwright, tsx, concurrently.

## Done so far (stages 1–3 delivered 20 Oct 2026)
- Schema: `db/migrations/001–003` (003 adds scheduled_visits, notifications, lone-worker ack, dev-only file_blobs). Seed: fictional data, 17 properties.
- API (`server/`): auth.ts (opaque session tokens, MFA gate, leaver block), crypto.ts (scrypt, TOTP), routes/account.ts (login, links, MFA), perm.ts (per-company perms), visibility.ts (row rules reused by lists/search/files), clearance.ts, storage.ts (Postgres file_blobs), routes/{core,inbox,people,properties,visits,tasks,admin}.ts.
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
- Auth is the Hub's own (migration 010): sessions table stores sha256 of random tokens with aal1/aal2; invite/reset links are auth_tokens in the URL fragment; access emails bypass the outbox so links never sit in the delivery log. Privileged + aal1 → 403 `mfa_required` except /me and /auth/*. Only super admins issue links for privileged people or reset MFA. First admin: `npm run create-admin`.
- `DEV_AUTH=true` (never in production; refuse to boot) enables a dev sign-in for seeded fictional users, for local demo and Playwright.
- Visits: on approval create a single allocation for the full duration; splitting replaces allocations and must sum to the duration. Approved correction → visit back to `submitted`, allocations cleared.
- No self-approval of visits, corrections, timesheets.
- Ending an appointment: require task transfer target if open tasks exist, end property allocations, revoke that company's grants if no other active appointment there. Other appointments untouched.
- Clearance: company `clearance_rule` warn/block; override needs `clearance.override` + reason → `clearance_exceptions`.
- Timesheet cost = per-day minutes × effective rate, computed in SQL numeric; labelled "estimate — not payroll".
- Future migrations must re-run the RLS/revoke block for new tables.

## Next steps
Stage 5 done (migration 005, `routes/training.ts`, `routes/policies.ts`, `web/pages/Training.tsx`, `Policies.tsx`, `tests/training.test.ts`; SQL function `training_matrix(as_of)` is the single source for training status). Stage 6 done (migration 006; `routes/governance.ts`, `cases.ts`, `estates.ts`; pages Governance, Concerns, Estates; `tests/governance.test.ts`). Agent users: `Access.agentIds` (agent_users table), no company perms, agent-only shell. Stage 7 done (migrations 007/008, `routes/finance.ts`, `routes/messaging.ts`, `server/outbox.ts` email-only worker started in index.ts, pages Finance/Messages/News, `tests/finance.test.ts`). WhatsApp PAUSED by the owner: tables exist, no code sends. Note: Express 5 `/:step` routes must `next()` for unknown steps or they shadow later routes. Stage 8 done (migration 009, `routes/ai.ts`, `routes/dataops.ts`, `server/csv.ts`, pages Assistant/DataTools incl. /install; tests ai, csv, dataops). Leave/cover (`routes/leave.ts`, `pages/Leave.tsx`), job descriptions, competence, onboarding and probation (migration 012, `routes/development.ts`, `pages/Development.tsx`, Admin → Templates) done 20 Oct 2026. Audit findings 1–12 fixed. Not built: development pathways, shadowing, succession, complexity weighting. Motion: keep animations ≤ 280 ms ease-out and inside @media screen; the 1 ms reduced-motion rule covers them.

## Uploads and allocation (20 Oct 2026)
- `FilePicker` (web/ui.tsx) replaces every raw `<input type="file">`: drop/choose button, chosen files slide in as chips with previews. `instant` = upload on pick (no chip); remount with a `key` to clear after submit.
- Staff documents (CVs etc.): migration 013 adds `person_doc` files; `/people/:id/documents` (POST/DELETE), listed as `documents` on `/people/:id`. Visible to the person and `staff.edit` holders. Word .docx allowed only here (`saveFile({ allowWord })`).
- Visit photos: `/visits/:id/photos` (images only, max 20, worker or approver; kept once approved). Shown on the visit and the property page (`photos`). Live finish and manual log both take photos, uploaded after the visit saves.
- Allocation: `web/allocate.tsx` `AllocateDialog` ticks several at once from a person (properties) or a property (`/properties/:id/assignable`, staff). Clearance blocks are shown per row with one recorded exception reason.
- Manual visit log remembers last property/type/duration on the device and has "I've just finished" to fill the times. Tests: `tests/uploads.test.ts`.

## Profiles, CPD and navigation (20 Oct 2026)
- Profile overview above the tabs (`web/pages/ProfileOverview.tsx`, `GET /people/:id/overview`): availability now (away from approved leave, without the kind; on a visit; within usual hours), weekly hours (`people.working_hours`, `PUT /people/:id/working-hours`, self or staff.edit) and the CPD roadmap (`CPD_STEPS` in routes/people.ts, matched to training records by title; ticked when course-passed or verified).
- Support work (`support_work`, migration 014) is approved automatically on finish, manual log and after an approved correction (owner decision; overrides the review rule for this type only).
- Sidebar grouped (NAV `group`): People high up; time/leave and learning/policies together. Tests: `tests/availability.test.ts`.

## Chat and team KPIs (20 Oct 2026)
- Chat (`web/pages/Messages.tsx` `ChatShell`/`ChatThread`): list beside the open chat (one at a time on phones), bubbles with avatars, inline photos, emoji picker, paste-an-image, Enter to send, polling every 4 s (list 8 s). Groups are the existing `team` kind ("Group" in the UI).
- Reactions: migration 015 `message_reactions`, `POST /messages/:id/reactions` toggles one of `REACTIONS` (members only). Photo-only messages allowed (body may be empty when a file is attached).
- KPIs for each person: `GET /kpis/team?company&month` (performance.view_all), Performance → KPIs → "Each person" table; a name opens their full KPIs. Tests: `tests/chat.test.ts`.

## My story, profile layout and wording (21 Oct 2026)
- "My story" (migration 016, `web/pages/Story.tsx`, `/people/:id/story*` in routes/people.ts): chapters written only by the person; `people.story_visibility` private/managers/colleagues decides readers (`canReadStory`, also gates `story` photos in /files/:id). Tests: `tests/story.test.ts`.
- Profile: summary card (photo, current roles, contact, actions) above tabs Overview · Story · Skills & documents · Roles · Development…; tab kept in `?tab=`.
- UI says "role" for an appointment (owner request); tables, routes, permission keys and `type: 'appointment'` values keep the old name.

## News & updates (21 Oct 2026)
- `web/pages/News.tsx`: lead story + card grid with cover photos (category colour panel when none), category filter, article page `/news/:id` with standfirst, body and photo gallery. Editor: cover (alt text required), gallery photos (≤20), short summary.
- API (routes/messaging.ts): `GET /news/:id`, `POST /news/:id/photos`, `DELETE /news/:id/photos/:fid`; gallery = `news` files other than the cover; replacing the cover deletes the old one. Draft photos are readable only by the author and publishers.
- Migration 017: `update` category, `news_posts.summary`, six "Sample:" posts for all companies (skipped on an empty DB) — archive them once real news exists.
- Chat is in the sidebar ("Chat", `/messages`) as well as the top-bar icon. Tests: `tests/news.test.ts`.

## House mood, complaints and maintenance (21 Oct 2026)
- Visit finish and manual log take optional `rating` (1–5 per aspect: kitchen, bathroom, bedrooms, living_areas, garden, communal; null = not checked), `complaint` and `repair`, saved in the same transaction (`server/condition.ts`, `saveExtras` in routes/visits.ts). The web form requires the rating; the API does not.
- Migration 018: `condition_ratings`, view `property_condition` (latest rating of each aspect in 12 months → score 0–100), `property_complaints` (each creates a high-priority task, due in 10 days, for the company's Governance `complaints_oversight` lead → deputy → property manager; complaint is resolved when the task is completed).
- `POST /properties/:id/complaints` for any staff who can see the property. Property list/detail return `condition_score`, `open_complaints`, `open_repairs`, `condition`, `complaints`, `repairs`. `reportRepair` is shared from routes/estates.ts.
- Web: `web/condition.tsx` (fold-away `VisitExtras`, `ConditionBar`, suggestions). Card glow: red < 60%, amber < 80%, green above. Tests: `tests/condition.test.ts`.
- Migration 019: `governance_leads` is one row per person (`person_id`, `role` lead|deputy); any number per area. `POST /governance/leads` adds, `POST /governance/leads/:id/end` removes. Complaints go to the complaints lead with the fewest open complaint tasks; other leads are notified.
- Migration 020: `job_roles` (fixed list, each with `access_role_key`). `appointments.job_role_key` / `staff_registrations.job_role_key`. `loadAccess` grants `staff` plus the job role's access role for every current appointment (so access follows the role and goes when it changes). `server/jobroles.ts` `jobRole()`: staff-level roles need nothing extra, higher access needs `access.manage`, privileged (admin/HR/finance) needs a super admin; nobody changes their own job role. Old free-text titles keep basic staff access until a role is chosen. Public `GET /job-roles`; web `JobRoleSelect` in ui.tsx.
- Migration 021 + `server/aiops.ts`: AI in operations. Leave requests take a `handover_note`; approving leave calls `handOverTasks` (open tasks due by the end date or undated → colleagues working then; Claude matches via `autoRun` when the company's assistant is on, else allocated-to-property → fewest open tasks; `task_handovers`, task comment, notifications). Daily report (`ai_reports`, one per company per day, hourly worker in outbox.ts, `GET /ai/reports`, `POST /ai/reports/:company/run`): figures always, Claude summary when on; managers (performance.view_all) notified. New assistant tasks `analytics_question`, `property_audit`. `autoRun` (routes/ai.ts) records automatic runs as `accepted` (person may be null). Needs `ANTHROPIC_API_KEY` on Render and the assistant switched on per company (Admin → AI assistant).
- Migration 022 + `server/geo.ts` / `web/geo.tsx`: geotagging. `POST /visits/start` and `/finish` take optional `geo {lat,lng,accuracy}` (taken by the browser only when the button is pressed; refusal still starts the visit) → `start_*`/`finish_*` columns incl. distance from the property pin. Properties get `latitude/longitude/location_source` (postcode via postcodes.io, pinned in the background and hourly by `pinProperties`; a manual pin set by PATCH lat+lng is kept when the postcode changes). Maps are OpenStreetMap embeds (`MapEmbed`; CSP frameSrc allows openstreetmap.org). Visit list flags "Location not shared" and starts > 250 m away (`FAR`). Tests: `tests/geo.test.ts`.
- Migration 023: repairs workflow. Governance area `repairs` ("Repairs manager"). `reportRepair` (also used by the visit form, which now returns `repair_id`) creates a task (due = repair due date, priority from urgency) for the repairs lead with the fewest open repair tasks → deputy → property manager, links `repairs.task_id`, notifies. That task owner can run the repair (`loadRepair` treats them as manager). Verified close completes the task (`completed_at`). `POST /repairs/:id/photos` (images, ≤20; reporter, worker or manager); repair page shows a photo grid and time to fix. Property detail adds `repair_history` (days_to_fix, on_time). KPIs `repairs_on_time` (completed_on ≤ due_on) and `complaints_on_time` (task done by due). Tests: `tests/repairs.test.ts`.
