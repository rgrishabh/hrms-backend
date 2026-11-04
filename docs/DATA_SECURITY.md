# Data security

How personal and pay data is classified, who may see it, how it is stored and how reads are recorded. The rules live in `src/core/policy/`.

## Classification

`src/core/policy/classification.ts` gives every column one level. `test/data-classification.test.ts` reads `information_schema` and fails on a column with no level, unless it is on the explicit exempt lists at the top of that file.

| Level | Examples | Who |
|---|---|---|
| L1 | Name, designation, department, work email | All employees |
| L2 | Manager, joining date, work location, attendance summary | Self, manager chain, HR |
| L3 | Personal phone and address, date of birth, emergency contacts, leave reasons, documents | Self, HR above them in the hierarchy |
| L4 | Salary, CTC, payslips, bank account, PAN, Aadhaar, loans and advances, tax regime | Self, authorised roles above them |

There is no photo column today. "HR" for L3 means holding `employees.manage`, or `documents.read` for files. A manager reads a leave, overtime or field-duty reason while a request from their team is pending, because deciding needs it (D39).

## Salary hierarchy

`users.salary_access_level` holds a stored level. The effective level is the stored level, raised to the floor of the person's roles and held under their ceiling (`levels.ts`). Effective level is computed from one table in TypeScript and in SQL.

| Role | Floor | Ceiling |
|---|---|---|
| `owner` | 100 | 100 |
| `tenant_admin` | 90 | 100 |
| `it_admin` | 60 | 89 |
| `finance_manager` | 50 | 89 |
| `payroll_manager` | 40 | 89 |
| `hr_admin` | 40 | 59 |
| `hr_executive`, `auditor` | 30 | 59 |
| Manager roles | 10 | none |
| `employee` | 0 | none |
| Custom roles | 0 | 59 |
| Employee without a login | 0 | |

With several roles the highest floor and highest ceiling count. Employee and manager roles set no ceiling, so they cannot lift HR's. Someone with no role that sets a ceiling is capped at 89.

**The rule:** a viewer sees L4 for a subject only if they are the subject, or they hold an L4 permission and their effective level is strictly above the subject's.

- Designated senior payroll is a `payroll_manager` with a stored level such as 85.
- Managers see no team salaries. `security.manager_team_salaries` turns that on, and the level cap still applies.
- `PUT /tenant/users/:id/salary-level` changes a level. Nobody changes their own, sets a level at or above their own, or edits someone at or above them. Each change is audited.
- A role change counts as setting a level: one that raises someone's effective level to the actor's own or above is refused, for everyone. Nobody changes the roles or status of someone at or above them. The last active owner stays, and only the bootstrap command works outside this (D40).

## Where the policy applies

`salary.ts` provides `l4RowFilter` and `l3RowFilter` (SQL fragments), `maskFields`, and `auditL4`.

| Path | Behaviour |
|---|---|
| Salaries, payslips, statutory, bank, loans, F&F suggestions | Subject out of reach: 404. Otherwise masked, or revealed and audited |
| `GET /payroll/runs`, `/runs/:id`, compute | Hidden people are left out of items and totals; `excluded` gives the count |
| Register CSV and XLSX | Hidden people left out; `x-excluded-subjects` header gives the count |
| Bank, bank-released, PF, ESI files; reimbursement bank file; journal and its export | Whole or refused: 403 `requires_higher_level` (D38) |
| `payroll_cost`, `department_overview`, their exports | Added up in Node over visible people, with `excluded` and a note. A group with someone hidden and fewer than 3 visible people has its amounts withheld, and they leave the totals too |
| Scheduled reports | A report with pay is run again per recipient at their level and sealed for them. A reader whose level has since dropped gets 404 |
| Audit views | Amount and identity keys are removed when written, were removed from old rows by the migration, and are removed again on read |
| Notifications, email, approval summaries | No figures: callers no longer write them, and `scrubAmounts` removes what gets through |
| Search, dashboards | Carry no L4; the matrix test asserts it |
| Overtime and field-duty reasons | Self, HR above them, and who decides while pending. Everyone else who can read the request gets it masked |
| Documents | Level check on HR access, including the direct download URL |
| Recruitment CTC | `recruitment.compensation`, then masked unless revealed. Candidates have no level |

No payslip file and no PDF export exist: printing a payslip happens in the browser from the payslip API.

## Masking

L4 fields come back masked, for allowed users and for the person themselves. `?reveal=1` is the only explicit reveal. The single shape:

```json
{ "id": "...", "net": null, "gross": null, "masked": true, "maskedFields": ["net", "gross"] }
```

Masked fields are null, and the object says so beside them. A field that is simply empty stays out of `maskedFields`. An object with nothing masked has neither key. L3 fields use the same shape when the reader is not allowed.

`GET /payroll/runs/:id?reveal=1` is the bulk reveal for payroll work. It writes one audit row per person.

PAN and Aadhaar never leave the server whole: reveal shows the last four characters.

## Audit

Each reveal and each export writes a row: who (`actor_id`), whose record (`target_id`), which fields and path (`change_metadata`), when, `ip`, and device (`user_agent`). Actions are `l4.reveal`, `l4.read`, `l4.export`. A masked answer carries no figure and writes no row. Aggregates write one row against the report or run, since they have no single subject.

Changes to L3 and L4 record field names, not values.

`audit_logs` is an append-only hash chain per tenant:

- A `BEFORE INSERT` trigger takes the row lock on `audit_chain_heads` and sets `chain_seq`, `prev_hash` and `row_hash`. That lock is held until commit, so audited writes of one tenant run one at a time (D37).
- Triggers refuse `UPDATE`, `DELETE` and `TRUNCATE` for every role. The app role has no grant on them either, and cannot read the heads.
- `audit_chain_verify(tenant)` walks the chain and names the first row that does not fit.
- `GET /tenant/audit/chain` and `GET /tenant/audit/chain/verify` are for the Owner and Super-admin only.

A table owner can still disable the triggers. The chain then shows the change, unless they also rewrite every later hash and the head.

## Logs

`core/logging.ts`: classified fields are redacted by name, logged URLs have no query string, and database error detail is dropped because it quotes rows. Pino's wildcards reach two levels, so a test covers top-level and one-level-nested objects. Error messages no longer contain balances. No route or query parameter carries L3 or L4, which a test checks.

## Encryption

AES-256-GCM at application level. Each token names its key: `v2.<keyId>.<iv>.<tag>.<data>`. Older `v1` tokens are still read.

| Sealed | Column |
|---|---|
| Bank account number | `employee_bank_accounts.account_number_enc`, `employee_bank_changes.account_number_enc` |
| PAN, Aadhaar | `employee_statutory.pan_enc`, `aadhaar_enc` |
| Salary | `employee_salaries.amounts_enc`, `annual_ctc_enc` |
| Payroll item: lines, amounts, warnings | `payroll_items.data_enc` |
| Run totals | `payroll_runs.totals_enc` |
| Adjustment amount and note | `payroll_adjustments.data_enc` |
| Journal total | `accounting_exports.total_enc` |
| Report rows and totals | `report_snapshots.data_enc` |

F&F is held in the same run and item tables. Loans stay plaintext under access control. Candidate CTC, UAN, PF and ESI numbers also stay plaintext.

**Keys.** Production: `KMS_KEY_ID` and `DATA_KEY_CIPHERTEXT`, unwrapped once at startup with `@aws-sdk/client-kms`. The cipher is synchronous after that. Development: `DATA_ENCRYPTION_KEY`. KMS takes priority. The migration step needs the same variables when there are rows to seal.

**Rotation.**

1. Load the new key as active and the old one as previous: `DATA_KEY_CIPHERTEXT_PREVIOUS` or `DATA_ENCRYPTION_KEY_PREVIOUS`.
2. Restart the API and worker.
3. Run `rotate-keys`. Each batch commits, rows already on the active key are skipped, and a second run finds nothing.
4. Remove the old key.

`src/core/crypto/columns.ts` lists every encrypted column, and a test checks it against the schema.

**Rules moved to the application** (`payroll/sealed.ts`, tested):

| Was | Now |
|---|---|
| `payroll_adjustments.amount <> 0` | `checkAdjustmentAmount`, plus money must be positive |
| `employee_salaries.amounts NOT NULL`, `annual_ctc numeric(12,2)` | `checkSalary` |
| `net >= 0` in the release guard trigger | Checked in the hold and release routes |

## Aadhaar

Storing Aadhaar numbers is limited by Indian law: the Aadhaar Act 2016, the Supreme Court's 2018 judgment, and data protection rules restrict who may ask for and keep one. **Collection is off.** An administrator can turn on `security.aadhaar_collection`, and should do so only with legal advice and a lawful basis. Until then the API refuses the field with 409. This is a technical control and not legal advice.

## Migration

`043_encrypt_l4_data.code` is a typed code step in the runner (`src/db/code-migrations.ts`), ordered with the SQL files.

- `042` adds columns, `043` seals in committed batches, `044` drops the plaintext and turns on the chain.
- An interrupted run resumes: the step is recorded only when finished, and it skips sealed rows.
- `down` puts the values back, for batch E's rollback, once a down for `044` re-adds the columns.
- Not reversible: text scrubbed of amounts, audit metadata scrubbed of amounts, and old `payroll_cost` and `department_overview` snapshots, which are deleted because they were made at their owner's level.

## Performance

`scripts/perf-payroll-cost.ts`, 1,000 employees, 12 paid runs, 12,000 items, seven requests each through the app:

| `payroll_cost` | Plaintext, SQL | Sealed, Node |
|---|---|---|
| By month, median | 16.7 ms | 255.8 ms |
| By department, median | 18.1 ms | 249.4 ms |

Both give the same totals on this dataset. That is about 15 times slower: the cost is opening each item and working out each subject's level per row, on a report that is run occasionally. Measured on one laptop with no concurrent load, and with a viewer who can see everyone.

The report reads its input in pages of 5,000 and caps only what it shows. Capping the input at 5,000 rows would have understated totals on this dataset (D41).
