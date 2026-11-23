# Data rights

What the installation does about the rights of a person under India's Digital Personal Data Protection Act 2023: seeing what is held about them, having it erased, and having it not kept longer than it must be. Code: `src/modules/data-rights/`. Who sees what follows `docs/DATA_SECURITY.md`.

**This is a technical control and not legal advice.** The periods below are defaults, as best known, for the records this product holds. Your advisers decide what applies to your establishment and state, and any of the periods can be changed in Settings.

## Export

| Route | Who |
|---|---|
| `GET /api/v1/tenant/data-rights/employees/:id/export` | The person. HR (`employees.manage`) or whoever may carry out erasure (`data_rights.execute`), strictly above them in the hierarchy. Anyone else gets 404 |
| `GET /api/v1/tenant/data-rights/candidates/:id/export` | `recruitment.manage` or `data_rights.manage`. Expected CTC needs `recruitment.compensation` or `data_rights.execute` |

- JSON, one section per kind of record, from every module that holds it. A module that is off keeps its data, so its section is there.
- `src/modules/data-rights/map.ts` lists every table. A test fails on a table with a person's id in it that is neither listed nor exempt with a reason, so a new module cannot be forgotten.
- Columns come by their level in the classification registry. L4 goes to the person, or to someone holding an L4 permission above them. Otherwise the section says `maskedColumns`, and `l4Included` is false.
- Sealed salary, payslip and case values are opened for an allowed viewer. PAN and Aadhaar appear by their last four characters, the bank account by its last four digits, as everywhere else.
- A case someone raised goes to them alone: for anyone else the section is `withheld`, with no count. A case naming someone as respondent is not in their export (POSH Act s.16, confidentiality).
- Files are listed by name and are not embedded.
- Each section gives up to `limit` rows (default 500, at most 2000). `nextOffset` says there is more, `?section=<key>&offset=<n>` fetches it, and `complete` says whether this answer holds everything.
- Rate-limited as an export. Each answer writes `data_rights.exported`, and `l4.export` naming the fields if it carried any L4.

## Erasure

Two steps: a request, and carrying it out.

| | Raise | Carry out |
|---|---|---|
| `multi` | The person, or `data_rights.manage` (HR Administrator, Super-admin) | `data_rights.execute` (Super-admin, Owner), and never whoever raised it |
| `single_hr` | The person, HR, or the Owner | The Owner. The Owner may carry out their own request, since nobody is above them, and the audit row says `selfApproved` |
| `single` | The person, or the Owner | The Owner, the same way |

```
POST /api/v1/tenant/data-rights/erasure-requests            { subjectType, subjectId, reason? }
GET  /api/v1/tenant/data-rights/erasure-requests[/:id]
POST /api/v1/tenant/data-rights/erasure-requests/:id/execute { note? }
POST /api/v1/tenant/data-rights/erasure-requests/:id/reject  { note? }
```

The approval engine is not used: see D55.

**Refused with 409 `erasure_refused`:** someone with status `active` or `on_notice`, a hired candidate (their data goes with the employee), a candidate with a live offer. A person must be separated, or never have joined. The last administrator is refused too.

**Idempotent.** Raising twice answers with the same request. Carrying out twice answers with the same report and `alreadyDone: true`, and changes nothing.

**What happens at once:**

- The employee row keeps its id, department and dates. Name becomes `Erased`. Work email, phone, date of birth, designation, grade and manager go. `erased_at` is set.
- The account is disabled, its email replaced, its password and MFA cleared. Sessions, devices, roles, notifications, mail, push and saved reports are deleted.
- Addresses, emergency contacts, education, experience and nominees are deleted. Reasons, comments and review text are emptied wherever they are kept.
- Files are deleted: selfies, a linked resume, and every document outside a payroll category. Where someone stood at a punch is emptied. Aadhaar is emptied at once: nothing requires it to stay.

Files go after the transaction commits, listed on the request first. One that could not go is reported as `filesPending`, and the follow-up job finishes it.

**What stays, and until when, is in the answer:**

```json
{ "status": "retained", "retainedUntil": "2034-03-31", "report": {
  "erased": { "employee_addresses": 2, "notifications": 14 }, "filesDeleted": 3, "filesPending": 0,
  "retained": [{ "category": "payroll", "label": "Payroll and statutory records", "tables": ["payroll_items", "employee_statutory"], "rows": 40, "until": "2034-03-31", "basis": "..." }],
  "auditLog": "...", "notLegalAdvice": "..." } }
```

The report holds counts, tables and dates only. Someone who never joined has no carve-out.

A statutory record must still say whose it is. While the payroll carve-out runs, name, date of birth and employee code are sealed on the request (`retained_identity_enc`), and the employee row no longer has them. No route reads them yet: a statutory query needs an operator today.

### Carve-outs

Each period counts financial years from the end of the financial year (31 March) of the last relevant date: last working day, last payroll period for payroll, and for disputes the closing of the latest case. A case still open counts from the day of the erasure.

| Category | Setting | Default | Holds | Basis, as best known |
|---|---|---|---|---|
| Payroll and statutory | `retention.payroll_years` | 8 | Payroll runs and items, payslips, salaries, adjustments, TDS, PF, ESI and PAN details, bank account, loans, overtime, expense claims and receipts, travel, payroll-category documents | Companies Act 2013 s.128(5): books of account, 8 financial years. Income-tax Rules 6F: 6 years from the end of the assessment year, longer if a reassessment is open. ESI Regulations and PF and wage registers: commonly 5 years |
| Attendance and leave | `retention.attendance_years` | 5 | Attendance days and punches, corrections, shifts, leave, field duty | Labour registers: 5 years commonly applied. Varies by state and establishment. Labour Codes rules may change this |
| Disputes | `retention.claims_years` | 3 | Separation, checklists, grievance and POSH cases, acknowledgements, assets, training and competence | Limitation Act 1963: 3 years for most claims. No fixed period is known for POSH records. A laboratory's accreditation may ask for competence records for longer |

The DPDP Act 2023 (s.8(7), s.12) allows data to be kept where the law requires it. These are the longest periods commonly cited for each group, so shorter duties are covered.

### When a period ends

The daily job `data_rights.erasure_followup`:

- **Payroll:** deletes statutory details and bank details, remaining documents and receipt files; clears the sealed identity; replaces the employee code with `ERASED-…`.
- **Attendance:** nothing further.
- **Disputes:** replaces the text of closed cases.

Payslip, salary and attendance rows stay as figures of nobody. Finalized runs are immutable (the `payroll_guard_finalized` trigger) and their totals must keep adding up, and after this step nothing links them to a person.

## The audit log

`audit_logs` is append-only and hash-chained, and is never rewritten or purged. Erasure adds a row and changes none.

Checked against the code, and asserted in `test/data-rights.test.ts`: it holds no L3 or L4 values, because changes to those record field names. It **does** hold L1 and L2 values, so "field names without values" is true only for L3 and L4:

- `employee.updated` records old and new of a name, work email, designation or manager (`employees/routes.ts`).
- `auth.login_failed` and user creation record an email address.
- `employee.created` and `employee.bulk_imported` record employee codes.
- Every row can hold an IP address and device.

These stay after an erasure, on the basis of security and accountability, and every erasure report says so. The DPDP Rules 2025 are understood to require logs for at least a year. If your advisers want names out of old rows, the chain has to be re-based by an operator: nothing in the app can do it, by design.

## Retention

All run with their module off, from `retention: true`, since data must not outlive its date because a flag changed. Settings are in the `retention` group (`settings.manage`). `GET /api/v1/tenant/data-rights/retention` gives the periods in force and their basis.

| Job | Period | Does |
|---|---|---|
| `recruitment.retention` | `recruitment.retention_months`, 12 | Anonymizes candidates, deletes resumes |
| `attendance.selfie_retention` | `attendance.selfie_retention_days`, 90 | Erases selfies |
| `retention.operational` | `retention.notifications_days` 365; `retention.email_outbox_days` 90, sent or failed only; `retention.job_runs_days` 365, finished only | Deletes notifications, outbox rows, job runs. Also expired report copies |
| `retention.documents_after_exit` | `retention.documents_after_exit_months`, 36. 0 keeps | Deletes the documents of people who left. Payroll categories wait for `retention.payroll_years` |
| `data_rights.erasure_followup` | Carve-outs above | Finishes file deletions and ends carve-outs |

The first run after an upgrade acts on everything already past its date. Check the periods before the first night's run.

The scheduled pass (`jobActive`), a retry, and a queued run (`runQueued`) all let a `retention` job through with its module off. `test/data-rights.test.ts` proves each by the data being gone.

## Not done

- `PATCH /employees/:id` refuses an erased record. Profile routes, such as a new address entered by HR, do not check yet.
- Files are not in the export.
- No screen or route reads the sealed identity during a carve-out.
