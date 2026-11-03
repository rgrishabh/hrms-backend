# Implementation plan and status

Legend: ✅ implemented and covered by automated tests · 🟡 partial · ⬜ not started · 🔒 deliberately deferred (needs an external decision or input)

Baseline (start of work): the repository held only `README.md` and `LICENSE`. There was no code, no tests and no infrastructure, so there were no pre-existing failures to record.

## Status by specification section

| § | Area | Status | Notes |
|---|---|---|---|
| 2 | Repository docs | ✅ | This set of documents |
| 3 | Platform / tenant / self-service / core services separation | ✅ | See ARCHITECTURE.md |
| 4 | Isolation, domains | ✅ | **Deployment-level isolation** (one installation per customer: Compose project or AWS account). Domains from deployment config; the app answers only those hosts. In-database tenant scoping kept as defence in depth |
| 5 | Feature registry, module states, safe disable | ✅ | `ENABLED_MODULES` per installation, validated at startup; supported/enabled/configured/operational; 10 available, 26 `planned` |
| 6 | Configuration layers, precedence | ✅ | Deployment config (env, validated) / secrets (`.env` 600 or Secrets Manager → env) / business settings (DB). Deployment defaults layer for timezone and date format |
| 7 | Admin settings | 🟡 | General, attendance, security, org, users, audit ✅; read-only Installation view (branding, organization, domains, modules) ✅. Sections for unbuilt modules ⬜ |
| 8 | Roles & permissions | 🟡 | 12 system roles, segregation of duties, server-side checks ✅. Custom roles: schema + enforcement ✅, management UI/API ⬜. Delegation ⬜. MFA ⬜ (see SECURITY.md) |
| 9 | Employee information | 🟡 | Master, history, import, duplicates, bank details ✅. Contracts, documents, education, certifications, nominees, statutory IDs, transfers workflow, correction workflow ⬜ |
| 10 | Recruitment & lifecycle | 🟡 | **Recruitment ✅**: approved requisitions, candidates with consent + retention/erasure, pipeline with history, interviews with blind panel feedback, approved offers (restricted CTC, budget flag), hire → pre-joining employee (docs/RECRUITMENT.md). Onboarding checklists, offer letters, careers page, exit/F&F ⬜ |
| 11 | Attendance, shifts, rosters | 🟡 | Engine, overnight shifts, grace, half-day, weekly off, holidays, regularization, locking ✅. Rotating rosters, comp-off, field duty, break tracking policy beyond pairing, offline mobile queue ⬜ |
| 12 | Biometric integration | 🟡 | Vendor-neutral push contract, device keys, drift, dedupe, unmapped queue, reprocessing, health ✅. Vendor-specific adapters 🔒 (need the actual hardware/API) |
| 13 | Mobile attendance | 🟡 | Responsive web + policy-driven location ✅. Offline queueing, native apps ⬜ |
| 14 | Leave & holidays | 🟡 | Holidays ✅. **Leave ✅**: configurable types, append-only ledger, accruals (annual/monthly, pro-rated), year-end carry/lapse, requests with half days and sandwich rule, approval, cancellation with reversal, attendance `on_leave` (docs/LEAVE.md). Comp-off, encashment, attachments, notifications, scheduler ⬜ |
| 15 | Payroll & statutory | ⬜🔒 | Needs a verified statutory rule register (INDIAN_PAYROLL_COMPLIANCE.md) before any calculation work |
| 16 | Expenses & travel | 🟡 | **Expenses ✅**: categories with receipt/limit/GST rules, claims with receipts, manager → finance approval, duplicate GST invoice prevention, maker-checker payment batches, bank CSV export (masked unless permitted), ageing (docs/EXPENSES.md). Travel requests, advances, per diem, mileage ⬜ |
| 17 | Policies & handbook | 🟡 | **Policies ✅**: versioned text/PDF, maker-checker publication, branch/department audiences, acknowledgements bound to a content hash (immutable), reports + CSV, weekly overdue reminders, dashboard prompt (docs/POLICIES.md). Rich text, quizzes, e-signature ⬜ |
| 18 | POSH & grievance | ⬜ | |
| 19 | Lab competency & training | 🟡 | **Training records ✅** (courses with validity, records, revoke, expiry reminders) and **competency ✅** (methods with training prerequisites, assessments, quality-approved technical authorizations with maker-checker, periodic review and expiry, suspension/reinstatement, matrix, `/check` for LIMS) — docs/COMPETENCY.md. Training plans/sessions, effectiveness evaluation, LIMS API keys ⬜ |
| 20 | Performance, assets, exit | ⬜ | |
| 21 | Workflow engine | 🟡 | Sequential, maker-checker, comments, history ✅. Parallel, conditional/amount routing, delegation, escalation ⬜ |
| 22 | Notifications & integrations | 🟡 | **In-app + email ✅** (transactional outbox, SMTP, retries, branded templates, opt-out, approval alerts and daily reminders; docs/NOTIFICATIONS.md). SMS, push, other integrations ⬜ |
| 23 | Reporting | 🟡 | Daily attendance and exception views ✅. Exports (CSV/XLSX/PDF) and the other reports ⬜ |
| 24–25 | Data model | 🟡 | Implemented for the modules above |
| 26 | API | ✅ | `/api/v1/...`, zod validation, consistent errors, pagination, rate limiting. See docs/API.md |
| 27 | UI/UX | 🟡 | Screens for implemented modules. Not yet checked in a real browser in CI (see TESTING.md) |
| 28 | AWS | 🟡 | Account-per-customer Terraform with branding/organization/modules variables; validated + offline module tests (mock providers); **not yet applied** — see infra/README.md |
| — | Docker Compose | 🟡 | `deploy/compose/`: validated with `docker compose config` and resolved-config checks; command sequence rehearsed locally; **not yet run on a Docker engine** (CI job added) |
| — | White-label branding | 🟡 | UI, login, page title, favicon, theme colour, support contacts ✅. Emails, payslips, PDFs and exports ⬜ (features not built) |
| — | Administrator bootstrap | ✅ | Setup link / temporary password with forced change, idempotent, recovery path |
| 29 | Security & privacy | 🟡 | See SECURITY.md for the implemented/outstanding split |
| 30 | Testing | 🟡 | 79 automated API tests + 16-check smoke script. Browser E2E, load tests and RDS restore tests ⬜ (local restore drill passed) |
| 31 | CI/CD & ops | 🟡 | CI, multi-account Release (staging → canary → rest) and Infrastructure workflows written (not yet run on GitHub). Release script + DB provision/bootstrap tasks ✅ (rehearsed locally). Docker image not built locally (Docker unavailable) |
| 32 | Compliance register | 🟡 | Register structure created; every item is **unverified** |
| 33 | Phases | Phases 1–2 done; Phases 3–4 partially done | |

## Next steps (dependency order)

1. **Harden the foundation.** Run the Compose stack on a real Docker engine (CI job added); ~~MFA~~ (done: TOTP, enforced for privileged roles); custom-role management; Playwright browser tests in CI.
2. ~~Document storage~~ (done: local volume / S3, categories, restricted access, content-type detection, integrity check, expiry reminders; docs/DOCUMENTS.md). Next: malware scanning hook; attachments on leave and expenses.
3. ~~Notifications~~ (done: in-app + SMTP email via outbox; approval alerts and reminders). Expiry alerts arrive with their modules.
4. ~~Leave management~~ (done; next: compensatory off from overtime, scheduled accrual job, encashment with payroll).
5. ~~Background jobs~~ (done: in-app, DB-claimed scheduler with retries; close-day, leave accrual, session cleanup). Next: reminders once notifications exist.
6. **Statutory rule register.** Payroll design starts only after the register in INDIAN_PAYROLL_COMPLIANCE.md has been reviewed by a qualified Indian payroll/legal reviewer.
7. **Payroll engine.** decimal.js arithmetic (already a dependency), versioned rule snapshots, preview → maker-checker → lock → payslips.
8. **AWS go-live.** Set up Organizations/Control Tower + Shared Services, onboard the staging account, run the first real `plan`/`apply` and release, rehearse an RDS restore (infra/README.md).
9. ~~Expenses~~ → ~~Lab competency/training~~ → ~~Policies~~ → ~~Recruitment~~ → Onboarding → POSH/grievance → Performance/assets/exit.

## Known limitations of what exists

- Daily attendance rows are created when events arrive, on explicit recalculation, or on period lock. There is no nightly job yet, so an employee with no punches shows "Not calculated" until one of those happens.
- Shift edits don't recalculate existing days automatically. HR triggers recalculation, and locked days are never changed.
- If an employee's shift changes from one day to the next, the punch windows of the two days can overlap or leave a gap (documented in docs/ATTENDANCE.md).
- Branding files come from deployment config (URL or mounted folder); there's no in-app upload, by design.
- The bulk import accepts JSON rows (the UI parses CSV client-side). XLSX is not supported.
- Settings are re-read from the database on every use. That's fine at the current scale. Add per-request memoization if profiling shows otherwise.
- `tenant_integrations` and `custom roles` have schema but no management endpoints.
