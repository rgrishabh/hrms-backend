# Expenses and reimbursements

Module key: `expenses` (not in `default`; add it to `ENABLED_MODULES` / `enabled_modules`). Receipts use the same storage as documents (`STORAGE_DRIVER`), so storage must be configured.

## Flow

1. **Employee** creates a claim (title, business purpose, optional project / cost centre) and adds items: category, date, amount, description, merchant, and for GST categories the supplier GSTIN + invoice number. A receipt (PDF / PNG / JPEG / WebP, detected by content, not by file name) is required when the category says so.
2. **Submit** → approval workflow: step 1 the employee's reporting manager, step 2 anyone with `expenses.approve` (finance). Self-approval is blocked by the approval engine. Either step can approve, reject or return; a returned claim becomes editable and can be resubmitted.
3. **Finance** (`expenses.pay`) selects approved claims and prepares a **payment batch**. A *different* user must approve it (maker-checker, enforced by the API and by a database CHECK). Approved batches can be exported as CSV for the bank upload; after the transfer, finance records the payment reference and the claims become `paid` (employees are notified).

## Rules enforced by the server

| Rule | Where |
|---|---|
| Item date not in the future and within `expenses.claim_window_days` (setting, default 60) | add item |
| Per-item limit from the category (`max_amount`) | add item |
| Receipt required per category; content sniffed; SHA-256 stored; storage key generated server-side | add item |
| GSTIN and invoice number go together; GSTIN format checked | add item |
| The same GSTIN + invoice number can be claimed only once in the installation (unique index) | database |
| Same date + amount + category as another live item → flagged "possible duplicate" (not blocked) | add item |
| Totals computed with decimal arithmetic (no floating point) | server |
| Only draft / returned claims are editable; only the owner edits | API |
| Colleagues get 404; managers see their team; finance / auditors read all | API + RLS |
| Bank export: full account numbers only with `employees.bank.read`, otherwise masked; every export audited; cells that could be read as spreadsheet formulas are escaped | export |

## Permissions

| Permission | Default roles |
|---|---|
| `expenses.self` | everyone (employee) |
| `expenses.team.read` | reporting manager, department head, laboratory manager |
| `expenses.read` | finance manager, payroll manager, auditor |
| `expenses.approve` | finance manager |
| `expenses.pay` | finance manager, payroll manager |
| `expenses.manage` (categories) | finance manager |

## Not included / to verify

- Per-diem rules, mileage rates, multi-currency and corporate cards are not built. Travel requests and advances are in the `travel` module (docs/TRAVEL.md). A trip's claim first uses up its advance, and only the rest is reimbursed.
- Tax treatment of reimbursements (e.g. whether an item is a perquisite) and GST input-credit eligibility are **decisions for the organization's finance and tax advisers**; the module only captures the data.
- The CSV export is a generic layout; banks' upload formats differ and must be mapped per customer.
- Receipts are not OCR-read or malware-scanned beyond content-type detection.
