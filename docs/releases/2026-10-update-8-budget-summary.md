# Update 8: Budget summary corrections

This is a code-only update. There is no migration and nothing is seeded, and no saved record, amount, control budget, file or user is changed. All totals are calculated from the records already in the database.

## What changed
- **Shared calculation** (`itemizedBudget` in `shared/calc.ts`): the budget page, the dashboard and the portfolio all use it.
  - **Finalized items subtotal** = active items with a finalized amount (fixed + finishing + other).
  - **Miscellaneous allowance** is unchanged: the editable % of eligible finishing items, with fixed costs excluded. It is added to the total **once**. It is not a budget item, so it can't be counted twice.
  - **Grand total including miscellaneous** = subtotal + miscellaneous.
  - **Difference** = grand total − confirmed control budget. A positive difference shows as "Above control budget". A negative one shows as "Budget not allocated to items", but only when every item has a finalized amount.
  - All amounts are calculated in cents. Archived items and categories are excluded, as before. Contract values and payments are never added.
- **Master Items & Budget:**
  - A new **Budget summary** shows fixed costs, finishing items, other items (if any), finalized items subtotal, + miscellaneous allowance, a prominent **grand total**, the confirmed control budget, and the difference.
  - "Approved / finalized total" is now **Finalized items subtotal**.
  - If any active item has no finalized amount, the total is marked **Incomplete** with the count of missing amounts, and no surplus is shown.
  - A note appears if a budget category name looks like a miscellaneous line (to avoid adding it twice).
- **Dashboard financial overview:**
  - Five figures: confirmed control budget, itemized total incl. misc., actual paid, scheduled unpaid, and **budget remaining after payments** (control budget − actual paid).
  - **Itemized costs above budget** shows a warning with a link to Master Items & Budget. It says this is planned cost, not money spent (for example, "nothing has been paid yet").
  - **Payments above budget** is shown separately, in the remaining tile.
  - Overdue stays a subset of scheduled unpaid.
- **Portfolio** shows the itemized total incl. misc. (marked Incomplete when amounts are missing).
- The **control budget** is never changed by item amounts or the miscellaneous %. The tests confirm this.

### "Existing project — budget needs confirmation"
This text is the project's saved **Status label** (`projects.status`). It was set when the project was first created, and the app does not generate it. The update leaves it as it is. To change it, open the project → **Settings & links** → **Status label**, enter e.g. "In progress", and save. The text that the app generates (the budget page note and the dashboard budget tile) already reflects the confirmed budget.

## Staging update

### 1. Before: back up and record the current figures
```bash
cd /opt/qonnect-smarthouse-staging
bash scripts/preflight.sh --update
bash scripts/backup.sh          # database dump + uploads archive — note the db-/uploads- file names it prints
ls -l backups | tail -4

docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT (SELECT count(*) FROM projects) projects, (SELECT count(*) FROM budget_items) budget_items,
       (SELECT count(*) FROM payment_milestones) milestones, (SELECT count(*) FROM payment_transactions) transfers,
       (SELECT count(*) FROM contracts) contracts, (SELECT count(*) FROM attachments) attachments, (SELECT count(*) FROM users) users;
SELECT code, control_budget, control_budget_confirmed, misc_percentage, status FROM projects ORDER BY code;
SELECT p.code, sum(i.approved_amount) AS finalized_subtotal, count(*) FILTER (WHERE i.approved_amount IS NULL) AS missing
  FROM budget_items i JOIN budget_categories c ON c.id = i.category_id JOIN projects p ON p.id = i.project_id
 WHERE i.archived_at IS NULL AND c.archived_at IS NULL GROUP BY p.code ORDER BY p.code;"' | tee ~/staging-before-update8.txt
```

### 2. Update (code only)
```bash
git rev-parse --short HEAD | tee ~/smarthouse-staging-previous-commit.txt
git fetch origin && git log --oneline HEAD..origin/main
git pull --ff-only origin main
sed -i "s/^APP_TAG=.*/APP_TAG=$(git rev-parse --short HEAD)/" .env
docker compose build app
docker compose stop app
docker compose run --rm app node dist-server/migrate.js   # expect: Database schema is up to date
docker compose up -d app
sleep 25; docker compose ps
bash scripts/smoke-test.sh http://127.0.0.1:8091
```
Don't run `seed.js`, and don't remove volumes or edit `.env` (other than the usual `APP_TAG` line).

### 3. After: compare
Run the same `psql` block again, saving the output to `~/staging-after-update8.txt`, then:
```bash
diff ~/staging-before-update8.txt ~/staging-after-update8.txt && echo "no data changed"
```

In the browser (http://localhost:8091 through the SSH tunnel; press Ctrl+F5):
1. **Master Items & Budget → Budget summary:** fixed + finishing (+ other) = finalized items subtotal, and subtotal + miscellaneous = grand total. The control budget matches the saved value (QAR 1,000,000.00), and the difference matches.
2. **Dashboard:** the itemized total equals the budget page grand total. Budget remaining after payments = control budget − actual paid.
3. Change one item amount, or the miscellaneous %, and the control budget stays the same. Undo the test change afterwards.
4. Open a few existing files (a payment slip, a contract document): preview and download still work.
5. As a viewer the totals are visible; as a contractor the financial overview is hidden.

## Rollback
Code only, which is enough because the data is unchanged: `git checkout $(cat ~/smarthouse-staging-previous-commit.txt)`, set `APP_TAG` to that commit, then `docker compose build app && docker compose up -d app`.

The backup from step 1 is there if ever needed: `bash scripts/restore.sh backups/db-<stamp>.dump backups/uploads-<stamp>.tar.gz --yes`. That restores to the moment of the backup.

## Production
Follow the same steps in `/opt/qonnect-smarthouse` after staging is accepted, with a fresh production backup first. Production is still at f6ac8a2, so `migrate.js` will apply `005_prerequisites.sql` from the earlier dashboard release (additive: an empty table). The smoke test URL is https://qonnectsh.duckdns.org.

## Files
New:
- `tests/budget-totals.test.ts`
- this file

Changed:
- `shared/calc.ts`
- `server/routes/budget.ts`
- `server/routes/dashboard.ts`
- `src/pages/Budget.tsx`
- `src/pages/Portfolio.tsx`
- `src/components/dashboard/FinanceOverview.tsx`
- `src/lib/dashboard.ts`
- `src/lib/types.ts`
- `tests/dashboard-ui.test.tsx`
