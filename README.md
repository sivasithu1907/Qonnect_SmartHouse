# Qonnect Smart House — Project Control

Secure, multi-project web application for Qonnect's real-estate construction projects: master items & budget, payments (milestones + actual transfers), material supply, consultant visits, site visits, the setup-to-handover timeline, contractor work updates, private document uploads and a full audit history.

- **Frontend:** React 19 + Vite + Tailwind (the existing light Qonnect style)
- **Backend:** Node 22 + Express 5 API (`server/`), TypeScript
- **Database:** PostgreSQL 16 with SQL migrations (`migrations/`)
- **Packaging:** Docker Compose (app + database, isolated network and volumes)

> Mock data from the original prototype has been removed. Only the two supplied projects and the owner-supplied source values are seeded (see [Seeded data](#seeded-data)).

## Quick start (local development)

Prerequisites: Node 22+, PostgreSQL 16 running locally.

```bash
npm ci
cp .env.example .env            # local dev: set DATABASE_URL, UPLOAD_DIR, COOKIE_SECURE=false
npm run db:migrate              # apply migrations
npm run db:seed                 # seed the two supplied projects (idempotent)
export ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name"
read -rsp "Admin password: " ADMIN_PASSWORD; export ADMIN_PASSWORD; echo
npm run admin:create            # create the first admin (no hard-coded credentials)
unset ADMIN_PASSWORD
npm run dev                     # API on :8080, web on :3000 (proxied /api)
```

Quality checks:

```bash
npm run typecheck
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/smarthouse_test npm test   # uses a throw-away database (schema is dropped!)
npm run build
```

Production / staging deployment: see **[DEPLOYMENT.md](DEPLOYMENT.md)**.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | yes (set by Compose) | port `5432` | Database connection parts; the app URL-encodes user/password |
| `DATABASE_URL` | alternative | — | Full connection string (used instead of `DB_*` if set, e.g. local dev) |
| `POSTGRES_PASSWORD` | yes (Compose) | — | Database password — generate with `openssl rand -hex 32` |
| `POSTGRES_DB`, `POSTGRES_USER` | no | `smarthouse` | Database name / user |
| `COMPOSE_PROJECT_NAME` | yes (Compose) | — | `qonnect-smarthouse-staging` / `qonnect-smarthouse`; namespaces containers, network, volumes, image |
| `APP_BIND`, `APP_PORT` | no | `127.0.0.1`; `8091` staging / `8090` production | Localhost port for the SSH tunnel / Caddy |
| `APP_ORIGIN` | recommended | — | Public URL, e.g. `https://smarthouse.example.com`; enables Origin checks |
| `COOKIE_SECURE` | no | `true` in production | Secure cookies (requires HTTPS) |
| `TRUST_PROXY` | no | `1` in Compose | Number of reverse proxies in front of the app |
| `SESSION_TTL_HOURS` | no | `12` | Sliding session lifetime |
| `UPLOAD_DIR` | no | `/data/uploads` (Docker) | Private file storage path |
| `MAX_UPLOAD_MB` | no | `15` | Upload size limit |
| `APP_TIMEZONE` | no | `Asia/Qatar` | Used for "today" / overdue calculations |
| `MIGRATE_ON_START` | no | `false` | Run migrations when the app starts |
| `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` | only for `create-admin` | — | Bootstrap an admin; unset afterwards |

No passwords, tokens or private URLs are stored in the code.

## Roles (enforced on the server)

| Capability | Admin | Project Manager | Contractor | Consultant | Viewer |
| --- | :-: | :-: | :-: | :-: | :-: |
| Create / edit / archive / restore projects, misc %, control budget | ✔ | | | | |
| Manage users and project assignments | ✔ | | | | |
| Edit project Drive / Sheets links | ✔ | ✔ | | | |
| Budget (master items) — read | ✔ | ✔ | | | ✔ |
| Budget — edit, approve amounts | ✔ | | | | |
| Payments — read | ✔ | ✔ | | | ✔ |
| Payments — create / edit / void transfers, upload slips | ✔ | ✔ | | | |
| Material supply — full edit | ✔ | ✔ | | | |
| Material supply — update delivery/status/qty on lines **assigned to them**, upload delivery notes | | | ✔ | | |
| Consultant visits — manage any | ✔ | ✔ | | | |
| Consultant visits — manage **own** (reports, findings, actions) | | | | ✔ | |
| Site visits — manage | ✔ | ✔ | | | |
| Site visits — update findings/status on visits **assigned to them** | | | ✔ | ✔ | |
| Timeline — edit phases/tasks | ✔ | ✔ | | | |
| Contractor work updates — post (edit own) | ✔ | ✔ | ✔ | | |
| Audit history — read | ✔ | ✔ | | | |
| Read materials, visits, timeline | ✔ | ✔ | ✔ | ✔ | ✔ |

Admins see all projects. Every other user sees only the projects they are assigned to; any other project (or a record ID belonging to another project) returns *404*. Archived projects are hidden from non-admins and are read-only until restored.

## Security summary

- Opaque session token in an `HttpOnly`, `SameSite=Strict`, `Secure` cookie; only its SHA-256 is stored. Sliding expiry, logout and password change/deactivation revoke sessions.
- Per-session CSRF token required on every state-changing request; optional Origin check (`APP_ORIGIN`).
- scrypt password hashing, 12+ character policy, account lockout after 5 failed logins (15 min) plus IP throttling.
- Helmet security headers with a strict Content-Security-Policy.
- Zod validation on every input; parameterised SQL only; PATCH requests only change fields the client actually sent.
- Uploads: PDF / JPG / PNG / WEBP / HEIC / DOCX / XLSX detected from file content (magic bytes), size-limited, stored under random names outside the web root, and downloaded only through an endpoint that re-checks project membership and role (`nosniff`, sandbox CSP, `no-store`).
- Important records are archived/voided, never hard-deleted by the app. Audit log records who changed what (before/after) for payments, budget edits and approvals, delivery-date changes, project edits, archive/restore, uploads and logins.
- Duplicate bank/cheque references are blocked per project (database unique index + API check). Overpayments require explicit confirmation and are flagged. Transfer dates cannot be in the future.

## Google Drive / Sheets

Drive folders (project, payments, materials, consultant reports, site visits) and the Google Sheets link are **external links** stored per project and validated as `http(s)` URLs. The header **Drive** button opens the selected project's Drive folder. The app does **not** synchronise with Google Drive; files uploaded in the app are stored privately on the server.

## Seeded data

`npm run db:seed` (or `node dist-server/seed.js` in the container) creates, only if the code does not exist yet:

- **Umm Garn — PIN 70153699** (existing project): fixed costs (Contractor 509,500.00; Consultant 28,000.00; Kahramaa 35,000.00), 16 Master Sheet categories with Variant A / Variant B reference estimates (Landscape, Insulation, Foam/Cladding: Variant B *Not priced*), the source dashboard summary figures as *Needs review* references, 40 material supply lines + 7 category scope notes, and the 20-phase timeline template. All approved amounts blank, all material statuses *Status not confirmed*, only the four tile/marble lines carry the 10 Oct 2026 supply due date, gypsum shows *Contractor confirmation required*.
- **Umm Garn — PIN 70153016** (new project): budget category/item names and the timeline template only — no prices, quantities, materials, payments, dates, visits or progress.

No payments, visits, uploads, suppliers, approvals or completions are seeded. There are no KNX items.

## Project structure

```
server/            Express API (routes/, seed/, cli/, lib/)
shared/            Types, enums and calculation helpers shared by API and UI
src/               React app (pages/, components/, lib/)
migrations/        Forward-only SQL migrations
tests/             Vitest + Supertest against a real PostgreSQL database
scripts/           build-server.mjs, preflight.sh, backup.sh, restore.sh, smoke-test.sh
deploy/            staging/production env templates, Caddy route example, optional Caddy-network override
Dockerfile, docker-compose.yml, .env.example, DEPLOYMENT.md, HANDOVER.md
```
