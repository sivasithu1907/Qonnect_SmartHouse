# Handover — Smart House production update

## What changed

The original ZIP was a front-end-only prototype (all data in React state from `src/data/mockData.ts`). It has been rebuilt into a persistent, multi-project application:

| Area | Result |
| --- | --- |
| Mock data | `src/data/mockData.ts` and every demo record (payments, references, vendors, contacts, deliveries, uploads, approvals, visits, completion dates, task progress) removed. The UI reads only from the API. |
| Persistence | PostgreSQL 16 with migration `migrations/001_init.sql`, forward-only migration runner, idempotent seed of source-backed values only. |
| Backend | New Express 5 API (`server/`) — sessions, CSRF, RBAC, project-scoped routes, audit log, uploads, CSV reports. |
| Multi-project | Portfolio + project selector (name + code always together), project CRUD/archive/restore (admin), unique codes, per-project links, misc %, control budget. |
| Header Drive button | Top-left, beside the selected project name/code; opens that project's Drive folder (dashed/disabled when not set). |
| Budget | Fixed costs + 16 categories with Variant A / B as reference values; approved amount stored separately and blank; misc allowance shows its % and basis; source summary figures preserved and flagged *Needs review*. |
| Payments | Milestones and actual transfers are separate; multiple transfers + slips per milestone; balances from transfers only; overdue/overpayment flags; duplicate-reference protection. Starts at QAR 0. |
| Materials | 40 source lines with scope notes; responsibilities per source; statuses *Status not confirmed*; only tile/marble dated 10 Oct 2026; gypsum *Contractor confirmation required*; contractors can update lines assigned to them. |
| Visits | Consultant and site visit registers (empty), follow-up actions, report/photo uploads, links to tasks/materials. |
| Timeline | 20-phase planning template with task-level dependencies and hold points; dates/status blank; completion requires an actual date and completed predecessors (override is audited). Contractor work updates. |
| Packaging | Dockerfile, isolated `docker-compose.yml`, `.env.example`, backup/restore/smoke-test scripts, README, DEPLOYMENT guide. |

### Files

- **Removed:** `src/data/mockData.ts`, `src/types/index.ts`, `src/utils/formatters.ts`, all of `src/components/*` from the prototype (replaced), `metadata.json`, `bun.lock`, Gemini/AI Studio config (`@google/genai`, `GEMINI_API_KEY`), unused `jspdf`, `motion`.
- **Kept / adapted:** `index.html`, `src/index.css`, `src/main.tsx`, `vite.config.ts` (adds `/api` dev proxy), `tsconfig.json`, `package.json` (new scripts and dependencies).
- **Added:** `server/**`, `shared/**`, `migrations/001_init.sql`, `src/App.tsx`, `src/components/**`, `src/pages/**`, `src/lib/**`, `tests/**`, `scripts/**`, `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.env.example`, `vitest.config.ts`, `README.md`, `DEPLOYMENT.md`, `HANDOVER.md`.

## Verification performed

- `npm run typecheck` — clean.
- `npm test` — 84 tests passing against real PostgreSQL 16: payment balances (multiple transfers, overpayment, voiding, overdue, duplicate refs, future dates), project isolation (lists, 404s, cross-project IDs and foreign keys, per-project totals, archived projects), permissions for all five roles, secure upload/download (type sniffing, size limit, role and project checks, archived files, unauthenticated access), CRUD/archive/restore workflows for projects, budget, materials, visits, timeline, and the seeded-data checklist.
- `npm run build` — SPA and server bundles built.
- Staging rehearsal with the production bundle (`npm ci --omit=dev`, compiled `migrate.js` / `seed.js` / `create-admin.js`, `NODE_ENV=production`) on a fresh database: smoke test passed; seed re-run skipped existing codes; UI checked in a browser for admin, contractor and viewer; payment → transfer → slip upload → Drive link flow worked end-to-end.
- Data checklist on the staging database: both codes present; PIN 70153699 fixed costs 509,500 / 28,000 / 35,000 with no approved amounts; Variant sums 628,586.50 / 473,106.80; only four dated material lines (Ceramic tiles, Porcelain tiles, Marble, Granite = 2026-10-10); gypsum has no date and shows *Contractor confirmation required*; 0 KNX matches; 0 payments, transfers, visits, uploads, work updates, approvals or scheduled tasks; PIN 70153016 has 0 copied values, 0 material lines, 0 source references.
- `pg_dump -Fc` → `pg_restore` round trip (the commands used by `backup.sh` / `restore.sh`) restored identical row counts.
- `docker compose config` validated.

**Not verified here:** building and running the Docker images. The build sandbox cannot reach Docker Hub, so `docker compose build` / `up` must be run for the first time in your staging step (DEPLOYMENT.md §3). The same bundle and commands were exercised outside Docker.

## Revision 2 — deployment decisions applied

- Branch `main`; repository `https://github.com/sivasithu1907/Qonnect_SmartHouse.git`.
- Separate stacks: `qonnect-smarthouse-staging` on `127.0.0.1:8091` and `qonnect-smarthouse` on `127.0.0.1:8090`, each with its own `.env` (`deploy/staging.env.example`, `deploy/production.env.example`), database, network and volumes.
- `scripts/preflight.sh` (read-only) checks that the stack's port is free, that its password is set and URL-safe, and that no resources with its project name exist yet.
- Database passwords are generated on the server with `openssl rand -hex 32`. Compose passes the credentials as separate `DB_*` values and the app URL-encodes them (unit-tested with Base64-style characters).
- Caddy: `deploy/Caddyfile.smarthouse.example` (host-mode and container-mode options) plus an optional override that attaches only the app to Caddy's network. Nothing is applied automatically; the Operations Monitor, its database and Caddy are not changed or restarted.
- Drive/Sheets links are blank; the control budget and approved amounts stay unconfirmed; Installation 15% and the source grand totals stay *Needs review*.
- Staging only for now (DEPLOYMENT.md Parts A–B). Production and the Caddy route are Part C, for later.

## Values and decisions still needed from you

1. Confirm the checkout paths (proposed `/opt/qonnect-smarthouse-staging` and `/opt/qonnect-smarthouse`) and SSH access.
2. The future subdomain and how Caddy runs (host or container) — decide when moving to production.
3. Admin email/name/password and database passwords — entered on the server only.
4. Google Drive / Sheets URLs per project — entered in the app when ready.
5. Owner decisions kept open: control budget, approved amounts, Installation 15% basis, treatment of the source grand totals.
6. Users per role and their project access; an off-server backup location.

## Known limitations

- Google Drive is linked, not integrated: the app does not read or write Drive.
- Budget categories hold one line each from the source (category-level estimates); add item-level lines as quotations arrive.
- Dates are entered in the browser's date picker; display is DD/MM/YYYY. Overdue checks use Asia/Qatar time.
- Login throttling is per-instance memory (fine for a single app container).
