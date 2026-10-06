# Update 9.1: Contract finance summary

A calculation and display correction only. It adds no migration and no seed, and it does not change any contract, milestone, transfer, attachment, budget or link.

## Cause
"Pending" on a contract was the sum of the **linked milestones' unpaid balances** (scheduled amount − transfers).

**The example:** a QAR 180,000 contract with one QAR 40,000 advance milestone, fully paid. Pending was 40,000 − 40,000 = **0.00**. The QAR 140,000 not yet scheduled was never shown.

**A second issue:** the contract's paid total skipped milestones that were archived, so archiving a milestone hid money that had really been paid. A transfer is voided individually; archiving its milestone does not void it.

## What changed
The new shared calculation is in `shared/contractFinance.ts`. The server computes it once for both the list and the detail.

**Contract detail** shows four separate amounts:
- **Contract value:** "Not entered" when blank, which is different from zero.
- **Paid against this contract:** non-voided transfers on milestones that explicitly reference the contract. Archived milestones are included. Each transfer belongs to exactly one milestone, so nothing is counted twice.
- **Remaining contract balance:** contract value − paid, never below zero. Any excess is shown as **Overpaid**. It is shown as "Needs contract value" when no value is entered. A secondary line shows how much is not yet scheduled.
- **Scheduled unpaid:** positive unpaid balances of linked milestones that are not archived or cancelled. These are the same balances as the Payments page.

The detail also includes the note: "Remaining contract balance includes amounts not yet scheduled. It is not necessarily due now." The two overlapping figures are never added together.

**Contract list:** "Pending" is replaced by **Paid / Remaining**. Scheduled unpaid appears only as small secondary text when it's above zero, and Overpaid appears when it applies. The phone cards show the same information.

**Unchanged:**
- Links are never inferred from contractor name, category or budget item.
- Amendments don't change the contract value; the detail says so.
- The Payments page and dashboard keep their existing figures (their totals still leave archived milestones out).
- No milestone, due date, overdue flag, budget total or payment is created or changed.

## Files
Changed:
- `server/routes/contracts.ts`
- `src/lib/types.ts`
- `src/pages/Contracts.tsx`
- `tests/contracts.test.ts`

New:
- `shared/contractFinance.ts`
- `src/components/contracts/ContractFinance.tsx`
- `tests/contract-finance.test.ts`
- `tests/contract-finance-ui.test.tsx`
- this file

## Staging
Use the same steps as update 9, with the file names `update91`. Migrate should say "Database schema is up to date". To roll back, check out the previous commit and rebuild; there are no data changes to undo.
