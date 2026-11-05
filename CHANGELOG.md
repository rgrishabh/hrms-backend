# Changelog

## Unreleased

### Added after batch G

* Printable ID and business cards: `GET /api/v1/employees/{id}/id-card.pdf`, `/business-card.pdf`, and for everyone `/api/v1/employees/cards/id-cards.pdf`, `/business-cards.pdf`; `PUT /api/v1/employees/{id}/photo` for the photo (all `employees.manage`).
* `PUT /api/v1/recruitment/candidates/{id}/resume` (`recruitment.manage`): add or replace the resume of an active candidate, audited as `recruitment.resume_replaced`. The replaced file is deleted from storage.

### CI in batch H

* `publish-develop.yml` and `release.yml` call `_app-publish.yml` at `@main`, not a commit (D65, ADR-020 in `hrms-deployment`, which must merge first).

### Contract changes in batch H

No route or field was renamed or removed.

* `GET /recruitment/applications/:id`: `offers[]` also has `legal_entity_id`, `branch_id`, `department_id` and `contract_end_date`.
* `GET /lifecycle/separations/:id`: new `exit_interview_recorded`, for HR and the person. `exit_interview` in the document is now a map of strings: it named two keys.
* Newly refused: `POST /lifecycle/separations/:id/exit-interview` over existing answers by someone not shown them (409).

### Contract changes in batch G

No route or field was renamed or removed.

* `GET /health`, `GET /health/live`: new field `version`, the image tag; `dev` outside an image.
* Every JSON route now has a response schema in `openapi.json`. Existing ones are corrected where they said less than the app answers: fields a column can leave null are nullable, and a field once `unknown` has its column's type.
* New optional variable `PUBLIC_URL`: the address for links, with its port. `APP_VERSION` is now read.
* `AUTH_RATE_LIMIT_PER_MINUTE` defaults to 300, was 20. The per-address limits on MFA verify, enable, email enrolment and sending a code follow it.

### Contract changes in batch F

Each is a security fix or a correction to what the document said. No route or field was renamed or removed.

* `GET /loans/requests`, `GET /loans/requests/:id`: `installments`, `first_period`, `skip_periods`, `disbursement_reference` and `cancel_reason` are now masked with the other L4 fields: null, and named in `maskedFields`, unless `?reveal=1` and the viewer may see them.
* `GET /lifecycle/separations/:id`: `reason` and `fnf_note` are masked for anyone but the person, HR above them, and whoever decides while it is pending. `exit_interview` and `leaveBalances` are withheld from readers without L3 reach, auditors included.
* `GET /employees/:id/history`: `change_metadata` is null, except for the record's own changes, for readers without L3 reach. An unknown id now answers 404, not an empty list.
* `POST /employees/import`, `POST /employees`, `PATCH /employees/:id`: duplicate warnings no longer compare phone or date of birth with people above the viewer.
* Newly refused, with the answer named: `POST /payroll/runs/:id/adjustments`, `DELETE .../adjustments/:adjId`, `PUT /payroll/employees/:id/statutory` on your own record (403). `POST /approvals/delegations` naming yourself as delegate for someone else (403). `POST /approvals/:id/reassign` to someone delegating to you (400). `POST /tenant/users` with `employeeId` and an address not on the record, without standing (403). `PATCH /employees/:id` changing `status` or `reportingManagerId` of someone at or above you (404) or your own (403). `POST /lifecycle/separations` on someone at or above you (404). `POST /lifecycle/separations/:id/exit-interview` with `lifecycle.read` alone (403). `POST /lifecycle/tasks/:id/done` on HR, IT or finance tasks of your own exit (404). `POST /loans/requests` for, and `disburse`, `cancel`, `repayment`, `defer` on, someone above you (404). `POST /documents`, `POST /documents/:id/archive` on someone above you (404). `PUT /tenant/users/:id/salary-level` and `PATCH /tenant/users/:id {unlock}` under the limits of the rest of user management (403). `POST`/`PUT /tenant/roles` with a permission of a module that is off (400).
* Response schemas in `openapi.json` corrected to what the app answers, where they said less: nullable fields of `GET /loans/requests`, `GET /payroll/runs`, `GET /payroll/runs/:id` when masked, plus `masked` and `maskedFields`; a null body on `GET /employees/:id/bank-account`; null `pending`; `updated_at` optional on statutory; `amounts` and `salary` as a record of any component; a nominee's `dateOfBirth` nullable; `GET /attendance/me/today` as the union with `{ linked: false }` that someone with no employee record gets; `date` and `overdue` optional on `GET /policies/mine`. A client generated earlier typed these as always present.
* New status on any route: `400 invalid_value` for a value the database cannot take, such as a NUL byte, which used to be 500. Uploads newly refused with 415: a PDF with active content in hex-escaped names, an Office file with macros.

### Security

* Abuse suite in `test/security`, over real HTTP. 28 findings fixed: see `QA_REPORT.md` batch F and `SECURITY_REPORT.md`.
* `Cache-Control: no-store` by default on the API (D64). Per-route and global rate limits count a signed-in person, not their office's address (F-127, F-128); sign-in and exports stay per address.
* CSV: one writer for every export, stronger against formulas and forged rows. AES-GCM refuses a shortened tag.

### Added

* Contract tests in `test/contract`: `openapi.json` byte for byte against the code and the running app, every GET per persona against its declared response, each management mode with flags on, default and off, and every declared permission tried both ways.
* `load/`: k6 scripts, seed and a `close_day` measurement. `.github/workflows/security.yml`: Semgrep, CodeQL, Trivy, SBOM, ZAP. `docs/THREAT_MODEL.md`, `SECURITY_REPORT.md`.
* `openapi.json` is committed, no longer git-ignored, and CI fails on a difference.

### Removed

* `continue-on-error` from the coverage job: the gate is real.
* Two guards no input can reach: `if (f > 0)` in `approvedLeaveByDate`, `?? ''` in `balanceOf`. Constraints `leave_requests_check1` and `loan_recoveries_check` make them dead.

### Changed (breaking)

* `POST /loans/requests/:id/defer` refuses your own loan, like disburse and repayment.
* `GET /notifications/unread-count` no longer counts as activity for idle sign-out.
* Errors are RFC 7807 `application/problem+json` from one handler: `type`, `title`, `status`, `detail`, `instance`, `code`, `errors[]`. Removed: `{ error: { code, message, details } }`, with no compatibility shape. Object `details` are now top-level members (`duplicates`, `confirmable`, `problems`, `hiddenSubjects`).
* Removed from error answers: database constraint names, and framework messages, which could quote the request body.

### Added

* ESLint with type-aware rules, Prettier, `.editorconfig`, a pre-commit hook, coverage thresholds (`npm run test:coverage`) and mutation runs (`npm run test:mutation`).
* `DB_READ_HOST`: report runs and exports read from a replica. Indexes from the audit, built concurrently (`048`). Per-request memo of settings and feature state. `page`, `pageSize`, `total` on the lists the audit named. Workbooks compress off the event loop.
* `GET /metrics` (Prometheus text) with `METRICS_TOKEN`. `OTEL_EXPORTER_OTLP_ENDPOINT` for traces. `x-request-id` on every response. Probes are not rate limited, and readiness answers within two seconds.
* `GET /approvals/stuck` for `users.manage`. `POST /travel/requests/:id/resubmit`. `released_count` on payroll runs and `hold_released_at` on their items. `selfie_id` on `GET /attendance/daily` with the selfie feature on.
* Company details (Layer 3): `GET` and `PUT /tenant/company`, signature and stamp under `/tenant/company/images/:kind`, permission `company.manage`. GSTIN (with its check digit), PAN, TAN, CIN, IFSC and bank account formats are checked. PAN and the bank account number are sealed. `loadCompanyProfile` reads them.
* Grades and designations: `POST` and `PUT /org/grades`, `/org/designations`, listed in `GET /org`, seeded from values in use. Once a list has entries, a new value must be on it. An import adds what is new and says so.
* Data rights (`docs/DATA_RIGHTS.md`): `GET /tenant/data-rights/employees/:id/export`, `/candidates/:id/export`, `/retention`, and `/erasure-requests` with `execute` and `reject`. Permissions `data_rights.manage`, `data_rights.execute`.
* Retention settings in a new `retention` group, and jobs `retention.operational`, `retention.documents_after_exit`, `data_rights.erasure_followup`, all running with modules off. **Their first run deletes what is already past its date**: notifications over 365 days, sent or failed mail over 90 days, finished job runs over 365 days, and documents of people who left over 36 months ago. Change the periods first if that is not wanted.
* `src/db/factories.ts`: deterministic organizations for each mode. `npm run demo` now creates 100 people (63 before) with an invented company, masters and company details, and no real organization's name.

* PDF documents, branded from Layer 2 and Settings, Company (D52): `GET /payroll/payslips/:id/payslip.pdf`; `GET /lifecycle/employees/:id/letters/appointment.pdf`, `experience.pdf`, `relieving.pdf`; `GET /reports/:key/export.pdf` and `/reports/snapshots/:id/export.pdf`. All audited, and counted as exports for the rate limit. Amounts print with the ISO currency code. Adds `pdfkit`.

* `npm run openapi` writes `openapi.json` from the code with no database. CI publishes it as an artifact. Every route declares its input, permission and feature metadata.
* `REDIS_URL`: optional cache for settings and organization lookups, invalidated on write. Without it, or with it down, the app reads the database.
* `BRAND_LOGO_DARK_URL`, `BRAND_FONT_FAMILY`, `BRAND_LOCALE`, `S3_ENDPOINT` for MinIO, CORS limited to `BRAND_DOMAIN`. Amounts in messages follow `BRAND_CURRENCY` and `BRAND_LOCALE`; payslips carry the brand.
* `FEATURE_*` flags, one per module, with a registry entry (`envName`) each. New: `FEATURE_SALARY_ADVANCE` (split from loans), `FEATURE_COMP_OFF` (split from overtime), `FEATURE_ATTENDANCE_GEOFENCE` (location policy, plus branch geofences), `FEATURE_ATTENDANCE_SELFIE`, `FEATURE_PUSH_NOTIFICATIONS`.
* `MFA_AVAILABLE`, `MFA_ENFORCED`, `MFA_METHODS`, `ORG_MANAGEMENT_MODE`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.

* `ORG_MANAGEMENT_MODE` is now enforced: `single`, `single_hr`, `multi`, with an `owner` role, one `buildSteps` route, self-approval on the record for the owner of the smaller modes, and delegation, reminders and escalation on the one-step HR route.
* Data classification registry, salary hierarchy (`users.salary_access_level`, `PUT /tenant/users/:id/salary-level`), central L3 and L4 policy, masking with `?reveal=1`, audit rows for every reveal and export.
* Hash-chained audit log: `GET /tenant/audit/chain`, `GET /tenant/audit/chain/verify`.
* Application-level encryption of salary, payroll items, totals, adjustments and journal totals. `KMS_KEY_ID`, `DATA_KEY_CIPHERTEXT`, `DATA_KEY_CIPHERTEXT_PREVIOUS`, `DATA_ENCRYPTION_KEY_PREVIOUS`, the `rotate-keys` command, typed code migrations in the runner.
* Aadhaar: encrypted, last four only, off until `security.aadhaar_collection` is on. `security.manager_team_salaries`.
* `docs/DATA_SECURITY.md`.

* Argon2id passwords with upgrade from scrypt at sign-in, a password policy with a bundled leaked-password list, back-off by who is failing, a list of sessions with revoke one and log out everywhere, an idle timeout, token rotation.
* Password reset and invitations by email. Email one-time codes (`MFA_METHODS=email`). `/auth/me` carries `mfa.suggested`. Security email that cannot be opted out of, including a new-device notice.
* ClamAV scanning of every upload (`CLAMAV_HOST`, `CLAMAV_PORT`), metadata stripped from images. `EXPORT_RATE_LIMIT_PER_MINUTE`. `documents.payroll` and `payroll_related` on document categories. `hrms bootstrap --make-owner`, `--issue-link`.
* `docs/AUTH.md`.

* Reversible migrations: `migrations/down/` for every migration, `hrms migrate-down --steps N | --to NAME | --all`, `npm run migrate:down`. The structure returns; dropped and scrubbed data does not, see "Rolling back migrations" in `README.md` (D49).
* `-- hrms:no-transaction` as the first line of a migration runs it statement by statement, for `CREATE INDEX CONCURRENTLY`. Such a file must be idempotent.

### Removed

* MFA for privileged roles only, and the `security.mfa_enforcement` setting: the deployment decides, with `MFA_AVAILABLE` and `MFA_ENFORCED` (D45). `mfaRequired` and `privileged` in role listings.
* `initialPassword` on `POST /tenant/users`: people choose their own from an invitation.
* An administrator appointing a peer administrator (D40). `documents.read` for payroll managers and auditors (D43).
* The account lock after failed sign-ins (`users.failed_logins` and `locked_until` are unused, and stay for a rollback).
* Plaintext columns: `employee_salaries.amounts`, `annual_ctc`; `payroll_items.lines`, `gross`, `deductions`, `net`, `employer_cost`, `warnings`; `payroll_runs.totals`; `payroll_adjustments.amount`, `note`; `accounting_exports.total`; `report_snapshots.rows`, `totals`.
* Amounts in loan, travel and expense approval summaries and notifications, in audit metadata, and in loan and travel error messages. Existing rows are scrubbed, which cannot be undone.
* Stored snapshots of `payroll_cost` and `department_overview`, which were made at their owner's level. They are deleted by the migration.
* The `outstanding` field of `POST /loans/requests/:id/repayment`.

* Renamed to the contract: `MAIL_TRANSPORT` (gone), `MAIL_FROM_ADDRESS` and `MAIL_FROM_NAME` (`BRAND_EMAIL_FROM`, display name `BRAND_PRODUCT_NAME`), `PRODUCT_NAME` (`BRAND_PRODUCT_NAME`), `BRAND_SHORT_NAME` (gone), `APP_URL` and `APP_EXTRA_DOMAINS` (`BRAND_DOMAIN`, `BRAND_EXTRA_DOMAINS`), `ORGANIZATION_NAME` and `ORGANIZATION_LEGAL_NAME` (`BRAND_NAME`, `BRAND_LEGAL_NAME`), `ORGANIZATION_COUNTRY`, `_TIMEZONE`, `_CURRENCY`, `_DATE_FORMAT` (`BRAND_*`), `ORGANIZATION_FY_START_MONTH` (`BRAND_FINANCIAL_YEAR_START`), `BRANDING_DIR` and `/branding/*` (fixed `/brand` mount, `/brand/*`), `SMTP_SECURE=true/false` (`tls`, `starttls`, `none`), `GET /api/v1/public/config` (`GET /api/v1/config/public`).
* `ENABLED_MODULES` and `MFA_ENFORCEMENT`: the server refuses to start while they are set. Module key `advances_loans` is now `loans` and `salary_advance`.
* The `feature_unavailable` error. A module that is off answers 404; one that is on but not set up answers 409 `feature_not_configured`.
* SMS, entirely: the `sms_templates` and `sms_outbox` tables and `users.sms_notifications` (migration 039), `notifications.sms`, `/api/v1/sms/*`, `SMS_*`, `smsNotifications` in `/auth/me` and `PATCH /auth/preferences`.
* `JOBS_ENABLED`: replaced by `PROCESS_ROLE=api|worker`. Only the worker runs the scheduler and sends email.

### Changed

* **BREAKING for the frontend.** L4 fields are null with `masked: true` and `maskedFields` unless the request has `?reveal=1`:
  - `GET /payroll/employees/:id/salaries`: `amounts`, `annual_ctc`. The person themselves may now call it.
  - `GET /payroll/runs`: `totals`. With reveal, each run also has `excluded`.
  - `GET /payroll/runs/:id`: `totals`; items' `gross`, `deductions`, `net`, `employer_cost`, `lines`, `warnings`; adjustments' `amount`, `note`. People out of reach are absent, and `excluded` counts them.
  - `POST /payroll/runs/:id/compute`: `totals`.
  - `GET /payroll/payslips/mine`, `/payslips/:id`: amounts, `lines`, `uan`, `pan`, `account`, `ifsc`.
  - `GET /payroll/employees/:id/statutory`: `uan`, `pf_member_id`, `esi_ip_number`, `pan`, plus new `aadhaar`. The person themselves may now call it.
  - `GET /payroll/fnf-suggestions/:id`: `salary`.
  - `GET /employees/:id/bank-account`: `accountNumber` (new; full number on reveal), `accountHolder`, `ifsc`, `bankName`. `accountNumberMasked` stays. `/pending`: `accountHolder`, `ifsc`, `bankName`.
  - `GET /loans/requests`, `/requests/:id`: `amount`, `installment_amount`, `outstanding`, `purpose`, and on detail `balance`, `schedule`, `recoveries`.
  - `GET /reports/payroll_cost`, `/reports/department_overview`: money columns. Reports also return `excluded`, and notes say what was left out.
  - `GET /accounting/sources`: runs' `totals`.
  - Recruitment: `budget_ctc_max`, `expected_ctc`, offers' `annual_ctc`.
* **BREAKING.** 403 `requires_higher_level` with `details.hiddenSubjects`: `/payroll/runs/:id/bank.csv`, `bank-released.csv`, `pf.csv`, `esi.csv`, `/expenses/batches/:id/export.csv`, `/accounting/payroll-runs/:id/journal`, `/export`.
* **BREAKING.** Subjects out of reach answer 404 where a permission alone used to answer 200, on the L4 routes above, `/employees/:id/profile`, `/documents/:id/download` and document lists. Exports add an `x-excluded-subjects` header.
* **BREAKING.** `GET /employees` and `/employees/:id` for directory readers no longer return `status`, `branch_id`, `branch_name` (L2). Someone in the manager chain gets `view: 'team'` with those, `reporting_manager_*` and `date_of_joining`.
* **BREAKING.** Full employee readers below the subject, or without `employees.manage`, get `phone` and `date_of_birth` null with `masked: true`. `reason` on `GET /leave/requests` and `/attendance/regularizations` likewise. Payroll and auditor roles no longer read `/employees/:id/profile`.
* `GET /auth/me` adds `mode`, `views`, `salaryLevel`, and `group` on each role. `GET /tenant/roles` adds `group`, and lists `owner`. `GET /tenant/users` adds `salary_access_level`, `effective_salary_level`.
* `/tenant/roles*` answer 404 in `single` and `single_hr`. `POST /tenant/users` and `PATCH /tenant/users/:id` refuse roles outside the mode (400), a second owner in `single` (409), and roles at or above the caller's level (403).
* Approval requests: `summary` has no amounts, and regularizations no reason. Approvals can be escalated from an HR step; the inbox can show the owner their own request in the smaller modes.
* `tenant_admin` gains `employees.read`, `employees.bank.read`, `payroll.read`, `payroll.approve`, `loans.read` (D36). `DATA_ENCRYPTION_KEY` is optional when KMS is configured. The first administrator is also `owner`.

* Off means absent: routes of a module that is off are not registered and answer 404, signed in or not. Pending approvals of that module leave the inbox and answer 404, and resume unchanged when the flag returns. Its settings, jobs, permissions, reports, snapshots, notifications, seed and demo data, and its fields on other records, are gone with it. Retention jobs still run.
* `GET /api/v1/tenant/settings` no longer has `featureEnabled`; off settings are not listed. `/tenant/installation` lists only what is on.
* `POST /api/v1/tenant/jobs/:key/run` answers 202 with `{ runId, status: "queued" }`; the worker runs it.

## [1.1.0](https://github.com/rgrishabh/hrms-backend/compare/v1.0.0...v1.1.0) (2026-11-04)


### Features

* **accounting:** payroll and reimbursement journals as CSV or Tally XML ([#24](https://github.com/rgrishabh/hrms-backend/issues/24)) ([5f78797](https://github.com/rgrishabh/hrms-backend/commit/5f78797ea5ac3b7aa163c013003fcdfcdae1eb99))
* add /health and /ready endpoint aliases ([4d54193](https://github.com/rgrishabh/hrms-backend/commit/4d54193114278a2e92d23c9962345ef334dbf472))
* **api:** HRMS API with attendance, leave, documents, MFA, expenses, competency and policies ([f4d53da](https://github.com/rgrishabh/hrms-backend/commit/f4d53da9c8517077e3e3706ba37f8f6a58903348))
* **approvals:** delegation while away and time-based escalation ([#29](https://github.com/rgrishabh/hrms-backend/issues/29)) ([b1a0008](https://github.com/rgrishabh/hrms-backend/commit/b1a000850415170594e2d5e6eb86f1c3fffd5d54))
* **attendance:** rotating shift rosters with staggered crews and one-day overrides ([#31](https://github.com/rgrishabh/hrms-backend/issues/31)) ([edee8d6](https://github.com/rgrishabh/hrms-backend/commit/edee8d65f97c581d23e06f4ea0c20a1c8871a0a6))
* **auth:** Hiring Approver role for management sign-off on hiring ([1135d99](https://github.com/rgrishabh/hrms-backend/commit/1135d991aefe448d6dfdc90e64534ea5e118c70a))
* **cases:** people lookup for IC membership and handler assignment ([5bb4067](https://github.com/rgrishabh/hrms-backend/commit/5bb40677684047e33c24c83f86a194ce94c4fbb9))
* **cases:** POSH complaints for the Internal Committee and grievances, encrypted, with timelines ([13150d7](https://github.com/rgrishabh/hrms-backend/commit/13150d7614167296d096ed555c830eeee7911045))
* **dashboard:** role-aware dashboard summary; clock-in card shows only today ([710a2de](https://github.com/rgrishabh/hrms-backend/commit/710a2defde5fe1fe5feac9926dd91381c9810115))
* **db:** synthetic demo-data generator for empty dev installations ([e1b509b](https://github.com/rgrishabh/hrms-backend/commit/e1b509b565d4a1cf092e037e920951b81e39fcb8))
* **employees:** personal details — emergency contacts, addresses, nominees, education, previous employment ([#28](https://github.com/rgrishabh/hrms-backend/issues/28)) ([485136e](https://github.com/rgrishabh/hrms-backend/commit/485136ea5b8745fe9180c5cb62846a8c0e2044b1))
* **expenses:** per-diem and mileage allowances from effective-dated policy rates ([#32](https://github.com/rgrishabh/hrms-backend/issues/32)) ([4466e87](https://github.com/rgrishabh/hrms-backend/commit/4466e87a23d76f1decf13609c9ea8fcd12dbec9b))
* **field-duty:** field duty requests counted as paid on-duty days in attendance ([e1b6780](https://github.com/rgrishabh/hrms-backend/commit/e1b67804c3d9f795b65fa9a772f577dca271f206))
* **lifecycle:** onboarding/exit checklists, probation reviews, separations with clearance and access end ([ea1139d](https://github.com/rgrishabh/hrms-backend/commit/ea1139db11e33bcac63fb5c61ee085ee8a3869dd))
* **loans:** salary advances and interest-free loans recovered through payroll ([#23](https://github.com/rgrishabh/hrms-backend/issues/23)) ([f2fe3bc](https://github.com/rgrishabh/hrms-backend/commit/f2fe3bc63e3edef79e228bd2edfcb6240dc469fd))
* **overtime:** overtime claims paid through payroll or taken as compensatory off ([9d5a7bd](https://github.com/rgrishabh/hrms-backend/commit/9d5a7bdc32e564719cdb34f0fe49871de30d15d3))
* **payroll:** components, approved salaries, verified statutory rules, runs with LOP, approval, finalize lock, payslips, exports, F&F ([507740a](https://github.com/rgrishabh/hrms-backend/commit/507740a33d6cbef9fb99b5d3e3e660153c0fbf6e))
* **performance,assets:** review cycles, goals and reviews; asset register with issue/return, calibration and exit check ([8161935](https://github.com/rgrishabh/hrms-backend/commit/81619359a72199a7bcaf2a9cb31d26d32eb0baa3))
* **recruitment:** panel user lookup for scheduling interviews ([594cb9c](https://github.com/rgrishabh/hrms-backend/commit/594cb9cbd1cc77c642722081c6c8724a9879fd53))
* **recruitment:** requisitions, candidates with consent and retention, interview pipeline, approved offers and hire ([ad42afb](https://github.com/rgrishabh/hrms-backend/commit/ad42afb7974d68fa4dbd2dedbfdf081afb7c4989))
* **reports:** Excel (.xlsx) export for reports, payroll register and policy acknowledgements ([#33](https://github.com/rgrishabh/hrms-backend/issues/33)) ([207a1e8](https://github.com/rgrishabh/hrms-backend/commit/207a1e85c321cfc869fe935bad7da9c046e8333c))
* **reports:** reports module with CSV export ([67c86fa](https://github.com/rgrishabh/hrms-backend/commit/67c86fa9cdb0b0b35fddf7b3fcb955edb9581de9))
* **reports:** saved and scheduled reports; department overview ([#26](https://github.com/rgrishabh/hrms-backend/issues/26)) ([a27d255](https://github.com/rgrishabh/hrms-backend/commit/a27d25557d52e3566f744ef946ad50140c72f491))
* **roles:** organizations define their own roles; MFA follows permissions ([#30](https://github.com/rgrishabh/hrms-backend/issues/30)) ([280ca43](https://github.com/rgrishabh/hrms-backend/commit/280ca439ddc0274e8152788988e4a14ff2d35d7d))
* **sms:** SMS notifications through the organization's provider with DLT templates ([#25](https://github.com/rgrishabh/hrms-backend/issues/25)) ([0dfc7bf](https://github.com/rgrishabh/hrms-backend/commit/0dfc7bf37231100ecc6a43a94e8f210978a3c8e8))
* **travel:** trip requests with estimates and advances, settled against the trip's claim ([b0376dd](https://github.com/rgrishabh/hrms-backend/commit/b0376dd59ac679a85c8133aad2d971c5657426f1))


### Bug Fixes

* **api:** configurable global rate limit, default 3000/min per IP ([3bcf8f0](https://github.com/rgrishabh/hrms-backend/commit/3bcf8f0166f67e008a6f356f5685d9bbc9814a60))
* **demo:** count only the leave requests actually recorded ([749d78b](https://github.com/rgrishabh/hrms-backend/commit/749d78b792b25415db9d458b7e35178a65ca5fe1))
* **docker:** apk upgrade in the runtime image ([fb6dfb6](https://github.com/rgrishabh/hrms-backend/commit/fb6dfb67c4da25649d1796aaca74e3f42e223f8e))
* **docker:** drop npm, npx, corepack and yarn from the runtime image ([d498741](https://github.com/rgrishabh/hrms-backend/commit/d49874188a02c02ef66356ca7b6c1bc91a39c3d6))
* **features:** every route of a switched-off module is refused ([56204c7](https://github.com/rgrishabh/hrms-backend/commit/56204c7ec23879a52e51f0763f3ac2bb037414b1))
* ignore only the top-level storage/ directory, not src/core/storage ([3a6b647](https://github.com/rgrishabh/hrms-backend/commit/3a6b6471f15c1ac08100f65cf9f33397269383a7))
* **security:** segregation of duties and confidentiality hardening ([8af5b74](https://github.com/rgrishabh/hrms-backend/commit/8af5b74eafce9a9b16ee1dafc9111d2b9aa0428b))
* **security:** user management cannot escalate privileges ([12f0c1a](https://github.com/rgrishabh/hrms-backend/commit/12f0c1a8af42b0b8aab6e78fbaf9309d39797995))
* send 201 responses after the transaction commits ([afa1ca3](https://github.com/rgrishabh/hrms-backend/commit/afa1ca36467ca02b56dcf7ca6387421c161f9100))
* stay ready on a newer schema so a release can be rolled back ([38ba57b](https://github.com/rgrishabh/hrms-backend/commit/38ba57b3da57a5470692284235313d2b3bd9e710))
* the clock-in card listed yesterday evening's punches as today's. ([710a2de](https://github.com/rgrishabh/hrms-backend/commit/710a2defde5fe1fe5feac9926dd91381c9810115))
