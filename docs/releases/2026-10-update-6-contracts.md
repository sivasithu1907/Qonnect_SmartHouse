# Update 6: Contracts & Documents

A project-specific contract register. Each project keeps its own contractor, finishing-works, consultant and other agreements, together with their files and amendments.

## What users get
- **New section: Contracts & Documents** in the project navigation, between Payments and Material Supply.
- **Contract register.** You can add, view, edit, archive and restore contracts. Each contract has:
  - title and category;
  - contractor / company name;
  - optional contract reference and signed date;
  - optional contract value in QAR;
  - status: Draft, Signed, Active, Completed or Terminated;
  - notes and an optional Google Drive folder link;
  - an optional link to a budget item in the same project.
- **List.** Search by title, company, reference, category or notes, and filter by category and status. "Show archived" lists archived contracts too.
  - Desktop and tablet show a table.
  - Phones show one card per contract.
- **Details view.** Opening a contract shows:
  - its summary;
  - **Documents**: the existing secure uploads, with document types Signed contract, Quotation, BOQ, Amendment and Supporting document. Each file shows its name, document type, uploader and upload date, with Preview (PDF / images) and Download;
  - **Amendments**: each one has a date, description, optional reference and notes, plus its own files;
  - **Linked payments**: shown only to users with financial access.
- **The original agreement is kept.** Amendments are separate records, so they never replace the contract or its signed file. A project manager cannot archive a *Signed contract* file; only an admin can.
- **Payments link.** The payment milestone form has an optional **Contract** field, listing only contracts from the same project.
  - A milestone that references a contract shows "Contract: …" in the Payments list, linking to the contract.
  - The contract shows those milestones with the existing Scheduled / Paid / Pending balances, using the same calculation as the Payments page.
- **Categories.** New projects, and every existing project after the migration, get four default categories: Main Contractor, Finishing Works, Consultant, Other. Admins manage them from **Categories** on the Contracts page, in the same way as budget and material categories: add, rename, reorder, archive / restore, and delete only when unused.
- **No automatic changes.** Saving a contract, entering or changing its value, or uploading a file never:
  - changes approved budget amounts;
  - creates payment milestones;
  - marks anything paid.

  The tests check this.
- The section starts empty for every project. No sample contracts or values are created.

## Permissions
| Role | Contracts & files | Contract value & linked payments | Budget item link |
|---|---|---|---|
| Admin | read + write; manage categories; may archive signed-contract files | yes | yes |
| Project manager | read + write (add / edit / archive contracts, amendments, files) | yes | yes |
| Viewer | read only (view and download files) | yes (viewers already have financial read access) | yes |
| Contractor, Consultant | no access (the register holds other parties' agreements and values) | — | — |

- Two new capabilities, `contracts.read` and `contracts.write`, are added to the existing role matrix.
- Contract value and linked payments are shown only to roles that can read payments. The budget item name is shown only to roles that can read the budget. Both are removed from the API response for other roles.
- **Project isolation (enforced on the server):**
  - Contracts, amendments, files, downloads, categories, budget item links and payment links must all belong to the selected project.
  - Another project's id returns 404, or 400 when used as a link.
  - Archived contracts cannot be linked to new payments.
- **Audit log:** contract, amendment, category and file changes are all recorded (create, update with before/after, archive, restore, upload).
- **Archived projects are read-only:** writes return 409, as in the rest of the app.

## Database migration: `004_contracts.sql` (required, additive)
- New tables: `contract_categories` (with the four defaults for each existing project), `contracts` and `contract_amendments`.
- `payment_milestones.contract_id`: a new **nullable** column. Existing milestones keep NULL, and no amounts change.
- The `attachments` CHECK constraints are widened to allow the new record types (`contract`, `contract_amendment`) and document types (`signed_contract`, `quotation`, `boq`, `amendment`). Existing files and values are unchanged.
- Nothing is deleted or overwritten. The previous app version keeps working on the migrated database, so a code-only rollback is enough.

## Staging update (backup first)

```bash
cd /opt/qonnect-smarthouse-staging
bash scripts/preflight.sh --update
bash scripts/backup.sh                                   # note the db-/uploads- file names it prints
git rev-parse --short HEAD | tee ~/smarthouse-staging-previous-commit.txt
git fetch origin && git log --oneline HEAD..origin/main
git pull --ff-only origin main
sed -i "s/^APP_TAG=.*/APP_TAG=$(git rev-parse --short HEAD)/" .env
docker compose build app
docker compose stop app
docker compose run --rm app node dist-server/migrate.js  # expect: Applying migration 004_contracts.sql
docker compose up -d app
sleep 25; docker compose ps
bash scripts/smoke-test.sh http://127.0.0.1:8091
```

Optional checks after the migration (read only):

```bash
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT p.code, count(c.id) AS contract_categories FROM projects p LEFT JOIN contract_categories c ON c.project_id = p.id GROUP BY p.code;"'   # expect 4 per project
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) AS contracts FROM contracts;"'   # expect 0
```

These use the database user and name already set inside the db container. Don't run `seed.js`. Caddy, the Operations Monitor and other services are not touched.

### Manual checks on staging (through the SSH tunnel, http://localhost:8091)
1. As an admin or project manager, open a project, go to **Contracts & Documents** and confirm the list is empty.
2. Add a contract, upload a signed PDF, Preview it, then Download it.
3. Record an amendment and attach a file to it.
4. In **Payments**, edit or schedule a milestone and choose the contract.
   - The contract shows it under Linked payments.
   - Budget amounts and payment totals are unchanged.
5. Switch to the other project: the contract does not appear there.
6. Sign in as a viewer: you can read and download, but there are no Add / Edit / Upload buttons.
7. Sign in as a contractor: there is no Contracts & Documents tab.
8. Open **Audit**: the contract, amendment and upload entries are listed.

## Production (after staging is accepted)
Same steps in `/opt/qonnect-smarthouse`, saving the previous commit to `~/smarthouse-production-previous-commit.txt`. The smoke test is `bash scripts/smoke-test.sh https://qonnectsh.duckdns.org`.

## Rollback
- **Code only (normally enough):** `git checkout $(cat ~/smarthouse-staging-previous-commit.txt)`, set `APP_TAG` in `.env` to that commit, then `docker compose build app && docker compose up -d app`. The new tables and column stay but go unused, and existing data is unaffected.
- **Code and database:** after the code rollback, `bash scripts/restore.sh backups/db-<stamp>.dump backups/uploads-<stamp>.tar.gz --yes` with the backup taken above. Anything entered after that backup is lost.

## Files
New:
- `migrations/004_contracts.sql`
- `server/routes/contracts.ts`
- `src/pages/Contracts.tsx`
- `src/lib/contractFilters.ts`
- `tests/contracts.test.ts`
- `tests/contracts-ui.test.tsx`
- this file

Changed:
- `server/app.ts` (route)
- `server/permissions.ts` (capabilities)
- `server/routes/attachments.ts` (contract record types, document-type check, signed-file rule)
- `server/routes/categories.ts` (contract kind)
- `server/routes/payments.ts` (`contract_id` with same-project check, contract title)
- `server/routes/projects.ts` and `server/seed/apply.ts` (default categories for new projects)
- `shared/constants.ts`
- `src/App.tsx`
- `src/components/Header.tsx`
- `src/components/Attachments.tsx` (document types per record, uploader label, per-file archive rule)
- `src/components/ManageCategories.tsx` (contract tab)
- `src/lib/types.ts`
- `src/pages/Payments.tsx` (Contract field and link)
- `tests/migration.test.ts`
