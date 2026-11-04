# Accounting exports

Module `accounting_exports` (depends on `payroll`; reimbursement journals also need `expenses`). Code: `src/modules/accounting/`. Tests: `test/accounting.test.ts`.

The module turns each **finalized or paid payroll run** and each **approved or paid reimbursement batch** into one journal voucher. You can download the voucher as CSV, or as **Tally XML** for import into TallyPrime / Tally.ERP 9.

## Ledger map (finance, `accounting.configure`)

Every head in a journal must map to one of your ledger names. Nothing is guessed. While a head is unmapped, the export is refused and the missing heads are listed.

| Head | Side | Examples |
|---|---|---|
| `earning:<CODE>` | Dr | `earning:BASIC`, `earning:HRA`, `earning:OT` |
| `deduction:<CODE>` | Cr | `deduction:PF_EE`, `deduction:PT`, `deduction:TDS`, `deduction:LOAN` |
| `employer_expense:<CODE>` / `employer_payable:<CODE>` | Dr / Cr | `PF_EPF_ER`, `PF_EPS`, `ESI_ER`, `LWF_ER` |
| `net_pay` | Cr | Net salary payable |
| `expense:<CATEGORY>` | Dr | `expense:LOCAL_TRAVEL` |
| `reimbursement_payable` | Cr | What a reimbursement batch pays |
| `travel_advance` | Cr | The part of a trip's claim set off against its travel advance (module `travel`) |

`earning:*`, `deduction:*`, `employer_expense:*`, `employer_payable:*` and `expense:*` are catch-alls for heads without their own mapping, such as one-off adjustments (`ADJ1`…) or a second loan (`LOAN2`). `GET /accounting/ledger-map` lists the heads this installation uses.

## Journals

- **Payroll run** (accrual basis), dated the last day of the month.
  - **Debit:** each earning and each employer contribution (as an expense).
  - **Credit:** each employee deduction, each employer contribution (as a payable) and the net pay.
  - Items on hold are included, because their pay is still owed.
  - Full-and-final runs are separate vouchers.
- **Reimbursement batch**, dated the day it was paid (or approved).
  - **Debit:** each expense category claimed.
  - **Credit:** the travel advances that trip claims used up, and reimbursements payable for the rest.

A journal that doesn't balance is never exported.

## Formats

- **CSV:** one row per ledger, with the columns `date, voucher, ledger, debit, credit, narration, head`.
- **Tally XML:** an `Import Data` / `Vouchers` envelope with one voucher of the type in `accounting.tally_voucher_type` (default `Journal`). The company comes from `accounting.tally_company`; when that is empty, the voucher goes to the company open in Tally. As Tally expects, debits are negative amounts with `ISDEEMEDPOSITIVE` Yes, and credits are positive with No.
  - **The ledgers must already exist in Tally with exactly the mapped names**, or Tally rejects the voucher.
  - **Import into a test company first** and check one month by hand before going live.

Every export is logged in `accounting_exports`, which is append-only, and in the audit trail. `GET /accounting/sources` shows the last export of each run and batch, so the same month isn't posted twice by mistake.

## Permissions

| Permission | Roles |
|---|---|
| `accounting.export` | finance manager, payroll manager |
| `accounting.configure` (ledger map, Tally settings) | finance manager |

## Not included

- **Payment vouchers.** There are no bank, payment or receipt vouchers for paying the salaries or batches; record those in your accounts as usual.
- **Cost-centre or department allocations.**
- **Direct posting** to an accounting system's API.
- **Account types.** The module doesn't check whether a ledger is an expense or a liability. That is your chart of accounts.
