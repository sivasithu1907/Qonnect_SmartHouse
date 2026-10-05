# Update 8.1: Dashboard and budget page presentation

A presentation-only update. There is no migration and no seed, and no saved value, description, file or setting is changed. The calculations from update 8 are unchanged: grand total = finalized items subtotal + miscellaneous (counted once); budget left after payments = control budget − actual paid.

## Dashboard
- **Financial overview** in two labelled groups:
  - **Budget planning:** Project budget and Total incl. miscellaneous (two equal columns).
  - **Payment tracking:** Actual paid, Scheduled unpaid and Budget left after payments (three equal columns).
  - Each figure has a short label, the same amount size, and an info popover (keyboard and touch) with its exact definition.
- **Budget left after payments** uses the normal text colour when it's zero or positive, with "Budget less recorded payments; unpaid commitments are not deducted." When it's negative it turns red and says "Overspent: payments exceed the budget by …".
- **Paid vs project budget** bar now shows "QAR paid of QAR budget · %".
- **Budget warning** is shorter:
  - "Itemized costs are QAR [difference] above budget ([%])."
  - "Includes miscellaneous allowance. Actual paid: QAR …"
  - A **Review budget** button.

  The values are live. It appears only when the difference is positive, shows no percentage for a QAR 0 budget, and says "at least … N items have no amount yet" when the total is incomplete.
- **Overview:** phase and milestone get more width than the dates. The missing-schedule note is one short line; **View timeline** in the header is its single action.

## Master Items & Budget
- The large yellow banner is replaced by one neutral line: "Amounts are managed here. Quote comparisons are available in the linked Google Sheet."
- **Budget summary** (two-thirds width on desktop, stacked on smaller screens):
  - fixed costs, finishing items;
  - finalized items subtotal and miscellaneous allowance;
  - the **grand total** in a light panel, using the app's surface colour instead of heavy dark rules;
  - confirmed control budget, then above budget / budget not allocated to items.

  Amounts are right-aligned, use tabular figures and don't wrap.
- **Contextual warnings** appear once, at the end of the summary, and only when they apply: missing finalized amounts, unconfirmed control budget (with Open settings for admins), or a category named like "Misc". Above budget is shown in the summary row itself.
- The **supporting column** (one-third) holds the miscellaneous card (percentage, eligible basis, allowance, the single **Edit %** button) and Scheduled vs paid.
- There is less gap between the summary, the Budget items / Manage categories tabs (with Show archived on the same row) and the item lists.

## Saved text you may want to edit (not changed by this update)
- **Project subtitle "Existing project — budget needs confirmation"**: this is the saved project **Status label**. Edit it under Dashboard → **Settings & links** → **Status label**.
- **"Approved / finalized amounts need confirmation." next to the Fixed Costs category**: this is that category's saved **notes**, from when the project was first created. Edit it under Master Items & Budget → **Manage categories** → Fixed Costs.

## Staging update
```bash
cd /opt/qonnect-smarthouse-staging
bash scripts/preflight.sh --update
bash scripts/backup.sh
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < ~/qcheck.sql > ~/staging-before-update81.txt
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
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < ~/qcheck.sql > ~/staging-after-update81.txt
diff ~/staging-before-update81.txt ~/staging-after-update81.txt && echo "no data changed"
```
`~/qcheck.sql` is the record-check file created during update 8.

**Rollback** (code only): `git checkout $(cat ~/smarthouse-staging-previous-commit.txt)`, set `APP_TAG` to that commit, then `docker compose build app && docker compose up -d app`.

For production, use the same steps in `/opt/qonnect-smarthouse` with a fresh backup. The smoke test URL is https://qonnectsh.duckdns.org.

## Files
Changed:
- `src/components/dashboard/FinanceOverview.tsx`
- `src/components/dashboard/ProjectOverview.tsx`
- `src/pages/Budget.tsx`
- `tests/dashboard-ui.test.tsx`

New:
- this file
