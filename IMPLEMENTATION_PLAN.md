# Implementation plan and status

Legend: ✅ implemented and covered by automated tests · 🟡 partial · ⬜ not started · 🔒 deliberately deferred (needs an external decision or input)

Every module in the feature registry (34) is built and `available`; none is `planned`. What remains is depth inside modules, listed under each area and gathered in **Next steps**.

## Status by specification section

| § | Area | Status | Built | Outstanding |
|---|---|---|---|---|
| 2 | Repository docs | ✅ | This set; per-module guides in `docs/` | |
| 3 | Platform / tenant / self-service / core services separation | ✅ | See ARCHITECTURE.md | |
| 4 | Isolation, domains | ✅ | One installation per customer (Compose project or AWS account); hosts from deployment config; tenant scoping and Postgres RLS kept as defence in depth | |
| 5 | Feature registry, module states, safe disable | ✅ | `FEATURE_*` per installation, validated at startup; supported / enabled / configured / operational; every route of a switched-off module refused | |
| 6 | Configuration layers, precedence | ✅ | Deployment config (env, validated) / secrets / business settings (DB) / deployment defaults | |
| 7 | Admin settings | ✅ | General, attendance, security, organization, users, audit, installation view; module settings (payroll, expenses, accounting, …) | |
| 8 | Roles & permissions | ✅ | 12 system roles, segregation of duties, grantable-role limits, server-side checks; TOTP MFA enforced for privileged roles; organization-defined roles (Settings → Roles) within the same grant limits, MFA-enforced when they carry privileged permissions; approval delegation (docs/APPROVALS.md) | |
| 9 | Employee information | ✅ | Master, history, import, duplicates, encrypted bank details, statutory IDs (PAN encrypted, UAN, ESIC), documents with restricted access and expiry; emergency contacts, addresses, nominees, education, previous employment, with employee changes to the verified sections approved by HR (docs/EMPLOYEE_RECORD.md) | |
| 10 | Recruitment & lifecycle | ✅ | Requisitions, candidates with consent and erasure, pipeline, blind panel feedback, approved offers, hire; onboarding / exit checklists, probation, separations, exit interview, access ended after last working day (docs/RECRUITMENT.md, docs/LIFECYCLE.md) | Offer-letter documents, careers page ⬜ |
| 11 | Attendance, shifts, rosters | ✅ | Engine (calc v3), overnight shifts, grace, half day, weekly off, holidays, regularization, locking; rotating rosters with staggered crews and one-day overrides, followed by attendance and leave (docs/ATTENDANCE.md); overtime with pay or compensatory off (docs/OVERTIME.md); field duty as paid on-duty days (docs/FIELD_DUTY.md) | Employee swap requests ⬜; offline mobile queue ⬜ (§13) |
| 12 | Biometric integration | 🟡 | Vendor-neutral push contract, device keys, drift, dedupe, unmapped queue, reprocessing, health | Vendor-specific adapters 🔒 (need the actual hardware/API) |
| 13 | Mobile attendance | 🟡 | Responsive web, policy-driven location | Offline queueing, native apps ⬜ |
| 14 | Leave & holidays | ✅ | Configurable types, append-only ledger, accruals, carry/lapse, half days, sandwich rule, approval, cancellation with reversal, comp-off credit from overtime, notifications, scheduled jobs (docs/LEAVE.md) | Leave encashment outside F&F ⬜; attachments on leave ⬜ |
| 15 | Payroll & statutory | 🟡 | Components, effective-dated salaries, verified statutory rule register (no shipped rates), runs from attendance LOP, adjustments, second-person approval, finalize lock, payslips, bank / PF / ESI / register exports, F&F; loan and advance recovery (docs/ADVANCES_LOANS.md); accounting journals as CSV / Tally XML (docs/ACCOUNTING_EXPORTS.md) | Employee tax declarations and proofs ⬜; Form 16 / 24Q / EPFO ECR files ⬜ (formats need the compliance review in INDIAN_PAYROLL_COMPLIANCE.md) |
| 16 | Expenses & travel | ✅ | Expenses with GST rules, receipts, approvals, payment batches, bank CSV; per-diem and mileage allowances from effective-dated policy rates; travel requests with estimates, advances, settlement against the trip's claim (docs/EXPENSES.md, docs/TRAVEL.md) | Multi-currency, corporate cards ⬜ |
| 17 | Policies & handbook | ✅ | Versioned text/PDF, maker-checker publication, audiences, hash-bound acknowledgements, reminders (docs/POLICIES.md) | Quizzes, e-signature ⬜ |
| 18 | POSH & grievance | ✅ | IC membership, encrypted complaints with statutory timelines, anonymous grievances with SLA (docs/CASES.md) | Hearing minutes, attachments ⬜ |
| 19 | Lab competency & training | ✅ | Training records with validity; competency, technical authorizations with maker-checker, expiry, suspension, matrix, `/check` for LIMS (docs/COMPETENCY.md) | Training sessions, effectiveness evaluation, LIMS API keys ⬜ |
| 20 | Performance, assets, exit | ✅ | Review cycles, weighted goals, self / manager / HR reviews; assets with calibration and exit clearance | 360° feedback, PIPs, asset depreciation ⬜ |
| 21 | Workflow engine | ✅ | Sequential steps, maker-checker, approval parties with exclusions, comments, history, subject withdrawal; delegation while away and time-based escalation (docs/APPROVALS.md) | Parallel steps ⬜ (amount-based routing lives in the modules, e.g. travel and expenses) |
| 22 | Notifications & integrations | ✅ | In-app + email (outbox, retries, templates, opt-out, reminders)| Push ⬜ |
| 23 | Reporting | ✅ | Report registry with team / organization scope, CSV and Excel (.xlsx) export, also for the payroll register and policy acknowledgements; saved and scheduled reports delivered in HRMS; department overview (docs/REPORTS.md) | PDF export ⬜ |
| 24–25 | Data model | ✅ | Implemented for every module above | |
| 26 | API | ✅ | `/api/v1/...`, zod validation, consistent errors, pagination, rate limiting (docs/API.md) | |
| 27 | UI/UX | ✅ | Screens for every module; Playwright browser tests in CI against the published backend image | |
| 28 | AWS | 🟡 | Account-per-customer Terraform, offline module tests with mock providers | **Not yet applied** — see infra/README.md |
| — | Docker Compose | ✅ | Installation kit; the dev environment runs on it (dev.rgrishabh.in) with smoke test and rollback | |
| — | White-label branding | 🟡 | UI, login, title, favicon, theme colour, support contacts, email templates | Payslip / PDF branding ⬜ |
| — | Administrator bootstrap | ✅ | Setup link / temporary password with forced change, idempotent, recovery path | |
| 29 | Security & privacy | 🟡 | See SECURITY.md | |
| 30 | Testing | 🟡 | 300+ API tests (vitest, real Postgres), browser E2E in CI, dev smoke test | Load tests, RDS restore test ⬜ |
| 31 | CI/CD & ops | 🟡 | CI with Trivy and gitleaks, develop images to GHCR, dev auto-deploy with smoke test and rollback, release-please | Multi-account production release not yet run (needs AWS go-live) |
| 32 | Compliance register | 🟡 | Register structure | Every item still needs review by a qualified Indian payroll/legal reviewer |

## Next steps (suggested order)

1. ~~Employee record completion~~ (done: docs/EMPLOYEE_RECORD.md).
2. ~~Workflow delegation and escalation~~ (done: docs/APPROVALS.md).
3. ~~Custom-role management~~ (done: Settings → Roles).
4. ~~Rotating shift rosters~~ (done: docs/ATTENDANCE.md → Rotating rosters).
5. ~~Travel per diem and mileage~~ (done: docs/EXPENSES.md → Allowances).
6. ~~XLSX export~~ (done: reports, report snapshots, payroll register, policy acknowledgements).
7. **Tax declarations, then Form 16 / 24Q / ECR**: only after the compliance register review (INDIAN_PAYROLL_COMPLIANCE.md).
8. **AWS go-live**: Organizations / Control Tower, first real `plan` / `apply`, RDS restore rehearsal (infra/README.md). Needs explicit approval.

## Known limitations of what exists

- Shift edits don't recalculate existing days automatically. HR triggers recalculation, and locked days are never changed.
- If an employee's shift changes from one day to the next, the punch windows of the two days can overlap or leave a gap (docs/ATTENDANCE.md).
- Branding files come from deployment config (URL or mounted folder); there's no in-app upload, by design.
- The bulk import accepts JSON rows (the UI parses CSV client-side). XLSX is not supported.
- Settings are re-read from the database on every use. Add per-request memoization if profiling shows the need.
- `tenant_integrations` has schema but no management endpoints.
