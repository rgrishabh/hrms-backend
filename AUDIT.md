# HRMS backend audit

Branch `feature/hrms-revamp` at `030af9c` (release 1.1.0). Audit date 2026-11-05. Read-only: this file is the only change.

## How this was checked

- **Read in full:** app bootstrap, config, all of `src/core`, auth, MFA, payroll, loans, leave, overtime, attendance (calc, service, routes, device ingest, roster logic), employees, tenant admin, reports, dashboard, accounting, documents, and the migrations for those areas.
- **Read in part:** expenses (flows and exports), lifecycle (approvals, separation, daily job).
- **Delegated, then spot-checked:** recruitment, cases, policies, competency, performance, assets, travel, field duty, org, notifications. A second reader went through these in full. I re-read a sample against the code (cases `:245`, recruitment `:212`, competency service, performance review steps). Findings from this group are tagged `[delegated]`.
- **Not read closely:** `attendance/roster-routes.ts`, `expenses/allowances.ts`, `core/http/xlsx.ts`, `db/demo.ts`.
- **Executed:**
  - `tsc --noEmit`: clean.
  - `npm audit --omit=dev`: 0 advisories.
  - Pure functions `calculate` and `calculateDay` run through `tsx` on edge cases, marked **probe** below.
- **Test baseline:** not executed during the read-through, but run separately before the audit against an isolated PostgreSQL 17: 336 of 336 passed, 42 files. Static count of `it(` calls is 351; the difference has not been investigated.

**Labels.** CONFIRMED means the code path was traced to the stated effect. SUSPECTED means the code permits it but reach or impact was not fully proven.

**Paths.** `file:N` means line N. Paths are relative to `src/`, or to `src/modules/` and `src/core/` where unambiguous, except `migrations/`, `test/`, `docker/`, `Dockerfile` and `hrms-deployment/`. Short names: `auth.ts` and `mfa.ts` are `src/modules/` unless written `core/auth/`; `engine.ts` is `core/workflow/engine.ts`; `state.ts` and `registry.ts` (features) are `core/features/`; `session.ts` is `core/auth/session.ts`; `context.ts` is `core/http/context.ts`; `env.ts` is `config/env.ts`; `installation.ts` is `config/installation.ts`; `templates.ts` is `core/notify/templates.ts`. A bare `calc.ts` under F-4, F-5 is `payroll/calc.ts`.

---

## 1. Stack, structure, how it runs

| Item | Value |
|---|---|
| Runtime | Node >=22 (`package.json` engines); image `node:22-alpine` |
| Framework | Fastify 5.12.8, `@fastify/cookie` 11.1.5, helmet 13.2.0, multipart 10.1.7, rate-limit 11.2.2 |
| Language | TypeScript 7.0.2, ESM, strict, `noUncheckedIndexedAccess` |
| Data | `pg` 8.23.1 raw SQL, PostgreSQL 17 with RLS, 31 forward-only migrations, 105 `CREATE TABLE` statements |
| Validation | zod 4.6.7, called inside handlers |
| Other | decimal.js 10.6.0, nodemailer 10.3.1, `@aws-sdk/client-s3` 3.1161.0 |
| Tests | vitest 5.1.0 against real PostgreSQL, serial (`vitest.config.ts`) |

```
src/app.ts            buildApp: plugins, onRequest auth hook, error handler, route registration
src/server.ts         process entry: env, pool, RLS role check, reconcile, scheduler, listen
src/config/           env.ts (zod env schema), installation.ts (public config, domain reconcile)
src/core/             audit, auth, crypto, features, http, jobs, notify, settings, storage, tenancy, workflow
src/db/               migrate, provision, bootstrap, seed, demo, pool, tx, ssl
src/modules/          feature modules, usually routes.ts + service.ts
migrations/           001..031 SQL
docker/entrypoint.sh  serve | migrate | migrate-status | provision | bootstrap | demo | exec anything else
```

**Run flow.**
1. `server.ts:11` loads env, `:21` builds the app.
2. `:31` refuses a superuser or BYPASSRLS role.
3. `:38` reconciles tenant name and domains.
4. `:47` starts the in-process scheduler if `JOBS_ENABLED`.
5. `:59` listens.

**Request flow.** `app.ts:119` `onRequest`:
1. Resolve host to tenant.
2. Load the session.
3. Check CSRF on unsafe methods.
4. Check the MFA and forced-password-change allowlists.

The handler then calls `tenantActor(req, ...perms)` (`core/http/context.ts:42`) and runs SQL in `withTenant` (`db/tx.ts:10`).

**Single-organization model.** `installation.ts:68` fails if more than one tenant exists, but tenant columns and RLS remain throughout.

---

## 2. Module status

| Module | Feature key | Status | Reason |
|---|---|---|---|
| Auth (`modules/auth.ts`) | always on | **Partial** | Login, lockout, sessions, CSRF work. No forgot-password, no admin password reset, no invite flow, no new-device alert |
| MFA (`modules/mfa.ts`) | always on | Complete | TOTP, replay guard, recovery codes. Coverage gap in F-11 |
| Tenant admin | always on | Complete | Settings, roles, users, jobs, audit view |
| Org | `core.org_structure` (never gated) | Complete | `[delegated]` department `parentId` cycle not prevented (`org/routes.ts:58`) |
| Employees + profile | `core.employees` | Complete | Bank change has no control (F-9) |
| Self-service | `core.self_service` | **Dead flag** | Key appears only at `registry.ts:45`. Turning it off changes nothing |
| Attendance | `attendance*`, `shifts`, `holidays` | **Partial** | Engine solid; regularization defect (F-8); no unlock |
| Leave | `leave` | **Broken at year-end** | Carry-forward duplicates days (F-2); year-end is manual only |
| Overtime + comp-off | `overtime` | Complete | Minor issues in section 4 |
| Field duty | `field_duty` | Complete | `[delegated]` no lock against concurrent inserts; overlap checked one way only |
| Payroll | `payroll`, `payroll.payslips`, `payroll.statutory` | **Broken on money edge cases** | F-1, F-3 to F-7. No Form 16 or 24Q, no PAN export, no payslip file (JSON only) |
| Loans | `advances_loans` | **Partial** | Recovery capped at net; held-pay and race defects (F-12, F-13) |
| Expenses | `expenses` | Complete | Per-diem and mileage not deeply reviewed |
| Travel | `travel` | Partial | `[delegated]` `returned` is a dead status with no edit or resubmit route |
| Accounting exports | `accounting_exports` | Complete | Journal logic balances |
| Recruitment | `recruitment` | Partial | `[delegated]` requisition checks missing at offer and hire; anonymization leaves PII |
| Lifecycle | `core.onboarding`, `core.offboarding` | Complete | Status PATCH bypass in section 4 |
| Performance | `performance` | Partial | `[delegated]` reviews can block cycle close with no skip or reassign |
| Competency / training | `training`, `lab.competency` | Complete | `[delegated]` exited staff can stay authorized |
| Policies | `core.policies` | Complete | |
| Assets | `assets` | Complete | |
| Cases (POSH, grievance) | `posh`, `grievance` | Partial | `[delegated]` anonymity leak, confidentiality gaps in notifications |
| Documents | `core.documents` | Complete | Minor visibility gaps in section 4 |
| Notifications | always on | Complete | No outbox purge possible |
| Reports | per report; `reports.advanced` | Complete | Snapshot leak (F-10) |
| Dashboard | always on | Complete | No salary figures shown |
| Approvals engine | always on | **Partial** | Stuck requests (F-14), `feature` unused |

---

## 3. Dead code

All verified by grep over `src`.

**DB tables never used by the app:** `tenant_branding`, `tenant_feature_entitlements`, `tenant_modules`, `tenant_integrations` (all `migrations/001_foundation.sql`). `feature_definitions` is write-only (`core/features/sync.ts`). `platform_settings` is read on every setting resolution (`core/settings/service.ts:33`) but nothing writes it, so each setting lookup spends a query on an always-empty table.

**DB columns:**
- `tenants.locale`.
- `users.mfa_required`: never referenced as a column (`mfa_required` in `app.ts:137` is an error code).
- `users.status='locked'`: value allowed by the check in `001`, never set. Lockout uses `locked_until`.
- `user_roles.scope_type`, `scope_id`: `loadPermissions` ignores them (`core/auth/session.ts:73`), so branch or department-scoped roles do not exist.
- `tenant_domains.tls_status`, `verification_token`: written at `installation.ts:77-80`, never read.
- `requires_entitlement`: hard-coded false at `sync.ts:14`.

**Code:**
- `FeatureDefinition.requiredPermission` (`registry.ts:31`): never read.
- `ApprovalHandler.feature` (`engine.ts:34`): every handler sets it, the engine never reads it.
- `core.self_service` flag.
- `employee_statutory.pan_enc`: encrypted and stored, never decrypted anywhere.

**Routes:** 325 static route declarations were compared to `hrms-frontend/src`.
- `GET /payroll/fnf-suggestions/:employeeId` (`payroll/routes.ts:519`) has no caller.
- `GET /competency/check` has no frontend caller. It is documented for external LIMS use, so it is not necessarily dead.
- This check matched on the last path segment, so other unused routes can hide behind shared segment names.

**Env vars:**
- `APP_VERSION` is set at `Dockerfile:33` and never read.
- `DATABASE_MIGRATION_URL` is in the schema (`env.ts:30`) but migrate reads `process.env` directly (`db/migrate.ts:84`).
- `ORGANIZATION_CURRENCY` and `ORGANIZATION_COUNTRY` only reach public config, while `₹` is hard-coded in server strings (`loans/routes.ts:92,107,168`, `settings/registry.ts:97`).
- `ORGANIZATION_FY_START_MONTH` only reaches public config. Leave year uses the separate setting `leave.year_start_month`, default January (`settings/registry.ts:116`).

**Deps:** all runtime dependencies are imported. **Docker stages:** all three used. **CI steps:** none dead.

**Tooling:**
- `src/core/jobs/cli.ts` is not wired into `docker/entrypoint.sh` (reachable only by the fall-through) and is not usable as a worker, see impact map (e).
- `demo` ships in the production image (`entrypoint.sh:13`), guarded at runtime by `DEMO_DATA_ALLOWED` (`db/demo.ts:544`).

---

## 4. Bugs and security issues

### 4.1 Headline findings

**F-1 CONFIRMED. Half-day leave with the other half unworked is paid in full.**
`payroll/service.ts:41`: `half_day` costs `lf > 0 && paid !== false ? 0 : 0.5`. But `attendance/calc.ts:172,188-191` only yields `half_day` alongside leave when the other half was **not** completed; a worked half gives `present`.
Probe: half paid leave and no punches gives `half_day`, fraction 0.5, so LOP is 0, should be 0.5. With half **unpaid** leave and no work, LOP is 0.5, should be 1.0.

**F-2 CONFIRMED. Year-end carry-forward duplicates leave.**
`leave/jobs.ts:102-103` lapses the excess in year Y and credits the carry in Y+1, but never removes the carried days from Y. The existing test encodes this: `test/leave.test.ts:201-202` expects balance 10 in both years. Consequences:
- `evaluateRequest` (`leave/routes.ts:60-97`) has no closed-year check, so backdated leave in Y spends those days again while Y+1 still holds them.
- `GET /payroll/fnf-suggestions` sums the ledger across **all** years (`payroll/routes.ts:526-527`), inflating encashment inputs.

Related:
- `runYearEnd` has no date guard, so HR can close the current year mid-year (`leave/jobs.ts:89`, `leave/routes.ts:329`). A re-run is a no-op, so a premature close cannot be repeated or undone by the same call.
- No job performs year-end (`core/jobs/registry.ts` has none), so balances never lapse unless someone triggers it.

**F-3 CONFIRMED. F&F and regular runs both pay the same days.**
`payroll_runs_regular_uq` covers only `kind='regular'` (`migrations/016:106`). `POST /runs` has no F&F duplicate or overlap check (`payroll/routes.ts:257-274`). `computeRun` includes an exited employee in a regular run when `exit_date >= period start` and in the F&F run (`payroll/service.ts:65-70`), each computing salary from the same days. Multiple F&F runs for one employee are also allowed. Overtime and loans dedupe; salary does not.

**F-4 CONFIRMED. One-off earnings are annualized for TDS.**
`calc.ts:88` adds taxable adjustments to `taxableMonthly`, `:134` multiplies by 12. Probe with sample slabs: ₹50,000 salary gives TDS 0; adding a one-off ₹100,000 bonus gives **₹18,850 that month**. The same applies to overtime arrears and F&F encashment. Also no YTD true-up and no marginal relief at the rebate limit (`:136`); the absence of true-up is documented in the code comment at `:130`.

**F-5 CONFIRMED. ESI coverage is decided on prorated wages.**
`calc.ts:111` tests `esiWage.lte(threshold)` after proration. Probe: ₹30,000 salary with threshold ₹21,000 owes no ESI at full pay, but with 15 paid days ESI is charged (₹113 employee, ₹488 employer). There is no contribution-period logic, so a covered employee is also dropped mid-period on a raise.

**F-6 CONFIRMED. A mid-month salary change applies to the whole month.**
`payroll/service.ts:81-82` takes the single latest `effective_from <= period end`. No split by days, so an increment effective on the 20th pays the full month at the new rate.

**F-7 CONFIRMED. A run can finalize with stale attendance.**
`/finalize` (`payroll/routes.ts:384-386`) checks that a lock exists, not that the run was computed after it. Sequence: compute, approve, then a regularization or leave approval changes attendance, then lock, then finalize. Items keep the old LOP, and the finalize trigger makes them immutable.

**F-8 CONFIRMED. Approved attendance corrections can leave the day as `missing_punch`.**
`attendance/routes.ts:49-51` adds correction events alongside originals; `calc.ts:124-135` treats same-direction neighbours as unmatched.
Probe: original in 09:30, out 18:00 plus corrected in 09:00 gives `missing_punch` (`consecutive_in_punches`). Original out 13:00 plus corrected out 18:00 gives `missing_punch` (`out_without_in`). With `payroll.missing_punch_is_lop` default true, that is a full day of LOP after an **approved** correction. Only the case of a truly absent punch works.

**F-9 CONFIRMED. Bank account changes have no second person and no alert.**
`employees/routes.ts:191-207`: `employees.bank.manage` writes directly, with no approval, no self-edit block, and no notification to the employee. An HR Admin can redirect anyone's salary. Payroll bank file uses the current value (`payroll/routes.ts:462`).

**F-10 CONFIRMED. Scheduled report snapshots leak payroll figures across permissions.**
`department_overview` needs only `employees.read` (`reports/registry.ts:408`) but adds payroll gross, employer cost and expense columns from the **owner's** permissions (`:435-439`). Recipient checks use `scopeOf(def, v) === 'all'` only (`reports/service.ts:107`, `reports/routes.ts:123,185`). So a payroll-permitted owner can send these columns to an HR Executive, or any custom role, with `employees.read` but no `payroll.read`. `loadSnapshot` also omits `def.feature` (`reports/routes.ts:178-186`), so snapshots stay readable after the module is off.

**F-11 CONFIRMED. MFA "privileged" level excludes roles that read salary.**
`PRIVILEGED_ROLES` (`core/auth/mfa.ts:14`) omits `finance_manager` and `auditor`. `PRIVILEGED_PERMISSIONS` (`:19-22`) subtracts anything a non-privileged role holds, so `payroll.read`, `payroll.approve`, `loans.approve`, `accounting.export` and `recruitment.compensation` never trigger it. Probe of `mfaRequiredFor`: `finance_manager` false (approves payroll), `auditor` false, `hiring_approver` false. A custom role with `payroll.read` also escapes.

**F-12 CONFIRMED. Held pay still counts as loan recovery, and held pay has no release.**
`/hold` needs status `computed` (`payroll/routes.ts:342`). Bank export excludes holds (`:459`), and finalize blocks item changes (`migrations/016:163-171`), so there is no route to release a held item after finalization. Meanwhile `balanceOf` treats recoveries in finalized runs as final (`loans/service.ts:17`), and `closeRepaid` can close the loan (`payroll/routes.ts:388`). The employee owes less on paper for pay not received.

**F-13 CONFIRMED by code, SUSPECTED by reach. Loan over-recovery race.**
`/repayment` locks the loan row (`loans/routes.ts:194`). `computeRun` reads balances without any lock (`loans/service.ts:33-39`) and inserts the recovery. Concurrent compute and repayment each see the full balance. The `greatest(0, ...)` at `loans/routes.ts:25` then hides the overshoot from the UI.

**F-14 CONFIRMED. Approvals can stick forever.**
- A user step for a disabled approver: `tenant/routes.ts:329` and `lifecycle/routes.ts:33` disable logins without reassigning steps. Only escalation frees it, and `approvals.escalate_after_days` defaults to 0, meaning off (`settings/registry.ts:121-122`).
- Step builders mostly check `employees.status` but never `users.status` (`leave/routes.ts:232-233`, `attendance/routes.ts:226-228`). `overtime/routes.ts:140` checks neither.
- A permission step whose only active holder is the requester or an excluded person stays pending, and is never escalated (`engine.ts:124` filters user steps only; `:281` escalates user steps only). No warning is raised.
- Steps are frozen at creation, so a changed reporting manager does not re-route.

**F-15 CONFIRMED on AWS. Login rate limit and audit IP can be spoofed.**
`app.ts:75` passes `trustProxy: env.TRUST_PROXY` as a boolean. Terraform sets it true (`hrms-deployment/terraform/modules/hrms-stack/compute.tf:202`) and the ALB config has no XFF override (`edge.tf:104` only drops invalid headers), so by AWS's default the ALB appends to client-supplied `X-Forwarded-For`. Not tested against a live ALB. Trust-all makes `req.ip` the leftmost entry, which the client controls. Every per-IP limit (`app.ts:95`, `auth.ts:44`, MFA `mfa.ts:50`) and audit `ip` follow it. Account lockout still applies but can then be used to lock any known email. Unlimited scrypt at about 32 MB per attempt is a CPU and memory DoS path. Compose behind Caddy was not evaluated.

### 4.2 Other confirmed business-logic bugs

**Payroll**
- `PATCH /employees/:id` can set `status='exited'` with no `exit_date` (`employees/routes.ts:80-100`, `exit_date` is not in `COLS`). `computeRun` keeps paying them (`payroll/service.ts:68-69`), and the login stays active.
- Salary approval does not re-check for a finalized run covering the date; the check runs only at proposal (`payroll/routes.ts:126-128` against `:43-46`).
- LWF is charged with zero gross (`payroll/calc.ts:126`), giving negative net and an automatic hold.
- Maker-checker only blocks the submitter, not whoever computed or adjusted (`payroll/routes.ts:371`).
- Attendance gap: `duePeriod` only ever offers today (`core/jobs/registry.ts:236-241`), so scheduler downtime skips that close-day. The lock recalculates everyone (`attendance/routes.ts:194`), so this only matters for runs computed before the lock (F-7). Until then, uncalculated days are **paid** with a warning (`payroll/service.ts:93`).
- `PUT /employees/:id/statutory` overwrites `uan` and `esi_ip_number` with null when omitted (`payroll/routes.ts:153-155`).
- `csvCell` prefixes negative numbers with `'` (`core/http/csv.ts:4`), so negative net amounts in a register CSV are text.

Statutory items checked with no defect: February uses calendar days consistently; PF ceiling is applied after proration; PT month overrides support February; rounding is half-up per line. A 26-day or 30-day pay basis is not supported, only calendar days.

**Leave and comp-off**
- Monthly accrual retro-credits capped months. `capped` returns 0, `credit` inserts nothing for zero (`leave/jobs.ts:27,75-76`), and the loop revisits every earlier month, so room freed by consumption back-fills them. The cap defers accrual instead of limiting it.
- Carry-forward ignores `max_balance` (`jobs.ts:103`).
- `perMonth` rounds to 2 dp (`jobs.ts:71`): 20 days/year accrues 20.04.
- An annual credit is not prorated for a known exit date (`jobs.ts:61-66`).
- Sandwich counting mismatch: unpaid leave with `count_non_working_days` debits weekly offs in the ledger, but LOP skips them (`attendance/calc.ts:148-156`, `payroll/service.ts:37-45`).
- Two half-day requests on one date are refused because overlap is date-only (`leave/routes.ts:90-93`).
- `balanceOf` plus insert runs with no lock or exclusion constraint, so concurrent submissions can both pass. Two pending requests that together exceed the balance then block each other at approval, since each counts the other as reserved (`leave/routes.ts:110-111`).
- Attendance lock checks only pending regularizations (`attendance/routes.ts:189`). Pending leave in a locked period can never be approved (`leave/routes.ts:107`), leaving the employee absent with LOP.
- Comp-off is credited to the leave year of **approval**, not work date, as `adjustment` (`overtime/routes.ts:86-88`). It has no expiry, and year-end lapses it under `carry_forward_max`.
- Cancelled comp-off inflates `used`: reversal is negative and credit is not in the `used` filter (`leave/routes.ts:185`, `overtime/routes.ts:221`).
- `POST /leave/adjustments` allows a leave manager to credit their own balance (`leave/routes.ts:340-355`).

**Loans**
- Recovery can take 100% of net pay (`loans/service.ts:55-58`). No statutory wage-deduction cap is modelled. SUSPECTED compliance issue under the Payment of Wages Act; confirm with counsel.
- Salary lower than EMI: partial recovery with warning, the rest stays outstanding, and the schedule tail extends. Works as designed.
- Early closure: repayment is bounded by `outstanding`, which excludes in-progress runs, and closes when `final >= amount`. Works, subject to F-13.
- An F&F shortfall leaves the loan `disbursed` indefinitely, with no write-off path.

**Attendance**
- Overnight: windows are `[start-4h, start+20h)` and overnight shifts pair correctly.
- Minor: a punch before midnight for a shift starting after midnight is not recalculated until the next punch, as `candidateDates` only covers local date and the day before (`attendance/service.ts:44-47`).
- Duplicate punches: gap filter plus idempotency key are correct.
- Location bypass: `channel` is client-chosen, so `channel:'web'` skips `mobile_location_mode='required'` (`attendance/routes.ts:70-78`).

**Approvals when the approver is the requester.** User steps are filtered and the engine blocks at `engine.ts:158-161`. Correct. Concurrency is correct: `FOR UPDATE` on request and step.

**Double payroll run.** Regular runs are safe, by the partial unique index, surfaced as 409, and `computeRun` locks the run. F&F runs are not (F-3).

**Delegated findings, sampled as above**
- `cases/routes.ts:245`: the error text identifies the complainant of an anonymous grievance to a handler who tries user IDs.
- `cases/routes.ts:141,298-300`: respondents on the committee or holding `grievance.manage` receive case notices and deadline reminders.
- `competency/service.ts:54-68`: `/check` can return authorized for an exited employee; lifecycle never touches `lab_authorizations`.
- `recruitment/routes.ts:212`: submit lacks the ownership check that edit has.
- `recruitment/routes.ts:563,566,650-651`: offer and hire do not check requisition status.
- `recruitment/routes.ts:627,458,388`: an accepted offer has no decline path, a dead end if the candidate reneges.
- `recruitment/routes.ts:680-683`: anonymization leaves notes and event text.
- `recruitment/routes.ts:260`: `avg_rating` bypasses blind panel feedback.
- `performance/routes.ts:66-68,178-179`: reviewer status is unchecked and the manager step waits on the self-review, so a leaver blocks cycle close.
- `performance/routes.ts:126`: `agree` has no status check and can revive a dropped goal.
- `field-duty/routes.ts:61-67`: no overlap re-check at approval; `src/modules/leave` never checks field duty.
- `travel/routes.ts:27,287`: `new Decimal('abc')` inside a zod transform gives a 500.

### 4.3 OWASP-style review

**A01 Access control**
- F-10, F-11.
- `POST /tenant/users` with `employeeId` (`tenant/routes.ts:297-300`) lets any `users.manage` holder, including IT Admin, bind a new login to an unlinked employee, then read that person's payslips and masked bank details as self.
- Administrator self-grant: `isAdministrator` skips all grant checks with no self-block (`tenant/routes.ts:272-273,315-324`), so "Tenant Administrator cannot read bank details" (`permissions.ts:3-4`) is audit-only.
- `GET /employees/:id/history` (`employees/routes.ts:169-175`) shows `previousLast4`, `newLast4` and IFSC to `employees.read` holders without bank permission.
- `/tenant/audit` shows the same data plus loan amounts, adjustments and payroll totals, see impact map (b).
- `POST /documents/:id/archive` has no restricted check (`documents/routes.ts:188-197`). Download does not check `status`, so archived documents still download (`:165-168`).
- `documents.expiry` notifies `documents.manage` holders about restricted documents, title included (`core/jobs/registry.ts:129-136`).
- `GET /employees/:id` returns directory fields for any status, unlike the list (`employees/routes.ts:58-60`).

No cross-tenant IDOR was found. Every query examined filters on `tenant_id`, with RLS beneath it. RLS relies on `app.platform_bypass`, which the runtime role can set itself, so SQL injection would defeat it. No injectable interpolation was found: `${...}` in SQL is limited to fixed fragments and validated integers.

**A02 Crypto**
- AES-256-GCM is sound (`core/crypto/index.ts:36-54`). A single key covers bank, PAN, TOTP and POSH text, with a `v1` prefix but no key ID and no rotation path.
- Scrypt N=2^15 for passwords is acceptable.
- Plaintext at rest: all salary and payroll amounts, UAN, ESI number, IFSC, candidate CTC, loan amounts.
- `LocalStore` writes documents unencrypted (`core/storage/index.ts:39-45`); S3 uses SSE-KMS.

**A03 Injection.** No SQL injection found. CSV formula neutralized. HTML escaped in email (`templates.ts:7`). Tally XML escaped.

**A04 Design.** No maker-checker on bank (F-9). Self-dealing leave adjustments. F-12.

**A05 Misconfiguration.** Helmet and per-path CSP good. No CORS plugin, so same-origin only. Error details return DB constraint names (`app.ts:160,163`), low.

**A06 Vulnerable deps.** `npm audit --omit=dev`: 0 at audit time. `npm audit` high-level gate in CI (`_app-ci.yml:66`).

**A07 Authentication.** F-11, F-15. No password reset flow. Password policy is length only (min 12), no breach check. No idle timeout, absolute TTL only. MFA failure counter is per session, so re-login resets the 5-try limit; SUSPECTED low impact as the password is needed first.

**A08 Integrity.** Migration checksums present; downloads verified by SHA-256; no AV scan on uploads. PDF filter is a regex over the file (`storage/sniff.ts:14`), which can miss obfuscated names (SUSPECTED).

**A09 Logging.** Exports, bank views and own payslip views are audited, but L4 **reads** by staff are not, see impact map (b). Logs redact cookies and tokens (`app.ts:73`).

**A10 SSRF.** None found.

**Secrets.** None found in tracked code; `DEV_PASSWORD` at `db/seed.ts:16` is dev-only, guarded at `:19,23`. gitleaks runs in CI.

**Mass assignment.** Guarded: employees via `COLS` with unknown-key rejection (`employees/routes.ts:88`); other routes use explicit zod objects.

---

## 5. Performance

**Per-request overhead, no caching (CONFIRMED).**
- `resolveHost` is 1 transaction per request (`core/tenancy/resolve.ts:33`).
- `loadSession` runs session, roles, employee and settings queries (`session.ts:48-69`), about 6 statements plus BEGIN, `set_config`, COMMIT.
- `gateFeatures` calls `evaluateFeatures` in a new transaction (`context.ts:77`). Each `resolveSetting` costs 2 queries (`settings/service.ts:33-34`), plus biometric and overtime checks.
- Most routes then call `requireFeature`, which evaluates everything again (`state.ts:147`).
- `featureOn` is the same full evaluation; `computeRun` calls it 4 times (`payroll/service.ts:58-61`).
- A typical gated route costs an estimated 20-30 statements before business logic (counted from code, not measured). The comment at `settings/service.ts:26-29` chooses no cache on purpose. A short TTL or per-request memo would remove most of this.

**N+1 and long transactions**
- `computeRun`: a loop per employee with salary, LOP, 2 settings queries, adjustments, overtime and loans (`payroll/service.ts:80-130`), in a single transaction.
- `attendance.close_day`: about 12+ queries per employee, one transaction (`core/jobs/registry.ts:57-60`). Same for `POST /attendance/recalculate` and `/locks` (`attendance/routes.ts:165,194`).
- Payroll exports `bank`, `pf`, `esi`: one query per row (`payroll/routes.ts:461-464,470-473,479-482`). `closeRepaid` likewise (`loans/service.ts:73-76`).
- `GET /reports/saved/:id/recipients`: a `viewerOf` per user (`reports/routes.ts:149`).
- Employee import: 2-4 queries per row, up to 2000 rows (`employees/routes.ts:143-154`).

**Missing indexes (derived from query shapes; not run through EXPLAIN)**
- `expense_claims (tenant_id, batch_id)`: `accounting/service.ts:79-80`.
- `overtime_claims (tenant_id, payroll_run_id)`: `payroll/service.ts:63`.
- `loan_recoveries (tenant_id, payroll_run_id)`: `payroll/service.ts:64`, as the existing index leads with `loan_id`.
- `payroll_adjustments (tenant_id, run_id, employee_id)`: `payroll/service.ts:96`, once per employee.
- `payroll_items (tenant_id, employee_id)`: `payroll/routes.ts:126,492`, as the unique index leads with `run_id`.
- `approval_requests (tenant_id, requester_id, created_at)`: `core/workflow/routes.ts:19-20`.
- `approval_requests (tenant_id, status)` and `approval_steps (tenant_id, status)` partial on active/pending: the inbox query (`engine.ts:232-248`).
- Trigram on `employees` search: `ILIKE '%x%'` cannot use `employees_name_idx` (`employees/routes.ts:40`).
- `overtime/routes.ts:163`: `to_char(work_date,...)` is not sargable.

**Unpaginated endpoints**
- `GET /payroll/runs/:id` returns every item with `lines` (`payroll/routes.ts:296-298`).
- No limit: `/attendance/locks`, `/attendance/device-mappings`, `/attendance/shifts`, `/payroll/components`, `/employees/:id/salaries`, the `missing_personal_details` report (`reports/registry.ts:473`), `payroll_cost` report.
- Fixed caps without paging, silently truncated: inbox 200 (`engine.ts:248`), `/approvals/mine` 100, `/payroll/runs` 100, cases 200 `[delegated]`, jobs 100, unmapped events 500.

**Blocking calls**
- `deflateRawSync` in XLSX (`core/http/xlsx.ts:118`), up to 5000 rows.
- `buf.toString('latin1')` regex over uploads up to `STORAGE_MAX_FILE_MB` (`storage/sniff.ts:12-14`).
- SHA-256 of whole files on the event loop.
- Uploads and downloads are fully buffered (`documents/routes.ts:122,175`, `storage/index.ts:62`).
- Jobs run in the API process, and "Run now" runs synchronously inside the request (`tenant/routes.ts:126`).

**Unbounded growth.** `email_outbox`, `notifications` have DELETE revoked from the runtime role with no purge job. `audit_logs` is append-only without retention. `job_runs` is not purged.

---

## 6. DevOps

**Good, verified**
- Multi-stage build; `USER 1000:1000` (`Dockerfile:50`); npm and yarn removed from the runtime image; `HEALTHCHECK` present (`:52`).
- Liveness `/health` and readiness `/ready` split (`app.ts:102-117`). Readiness fails on pending migrations.
- SIGTERM handled (`server.ts:50`).
- Compose: `read_only`, `cap_drop: ALL`, `no-new-privileges` (`hrms-deployment/environments/dev/docker-compose.yml:16-19`).
- CI: Trivy, gitleaks, hadolint, npm audit, actions pinned to SHAs within the workflow.

**Gaps (CONFIRMED)**
- Base images use tags, not digests (`Dockerfile:8,17,22`), though `.hadolint.yaml:3` claims they are pinned.
- RDS CA bundle fetched by `curl` with no checksum (`Dockerfile:19-20`).
- `HEALTHCHECK` hard-codes port 4000 while `PORT` is configurable (`:52`), and checks liveness only.
- Source maps ship in `dist` (`tsconfig.json:12`).
- `.github/workflows/*.yml` call `_app-*.yml@main`, not a pinned ref.
- CI triggers only on PRs to `develop` and `main` (`ci.yml:5`). `feature/hrms-revamp` gets no CI until a PR exists.
- `npm run lint` is `tsc --noEmit`; no ESLint and no coverage gate.
- Trivy gates on CRITICAL only (`_app-ci.yml:92-103`).
- No metrics or tracing; logs only.
- `scheduler.stop()` does not await a running job (`core/jobs/scheduler.ts:113`, `server.ts:55`). `pool.end()` can abort it, leaving it `running` for up to 60 minutes before retry.
- No missed-day catch-up for jobs (section 4.2).
- Single `DATA_ENCRYPTION_KEY` with no rotation tool.

---

## 7. Prioritised plan

### P0: wrong money or direct data exposure. Fix before the revamp ships.
1. F-1 half-day LOP. Add payroll tests for all `half_day` + leave combinations. Decide recompute policy for open runs and bump `CALC_VERSION`.
2. F-2 carry-forward: add a closing `carry_out` entry in Y; guard closed years in `evaluateRequest`; filter `leave_year` in F&F suggestions; date-guard year-end. Needs a data fix for already-closed years.
3. F-3 F&F overlap guard; exclude F&F employees from regular runs for that period, or the reverse.
4. F-4 and F-5 TDS and ESI logic. Treat one-offs separately; add ESI contribution periods.
5. F-6 mid-month salary split.
6. F-7 finalize requires `computed_at >= lock time`.
7. F-8 regularization semantics: superseded punches must be excluded.
8. F-9 bank change maker-checker and employee notification.
9. F-10 snapshot recipient check per column block, and feature check on load.
10. F-12 hold release path, and exclude held items from recovery.

### P1: control gaps and reliability
11. F-11 MFA: make it permission-based on an explicit L4 list, including `finance_manager` and `auditor`.
12. F-14 approvals: reassign on disable, fallback owner, default escalation on, warn when no eligible holder.
13. F-15 `trustProxy` with a hop count or CIDR; rate-limit logins per account too.
14. F-13 lock loans in `computeRun`; add exclusion constraints for leave and field duty overlap.
15. Audit L4 reads; remove amounts from loan notifications and audit metadata.
16. Password reset and invite flows.
17. `PATCH` status guard; lock check for pending leave; monthly accrual cap fix.
18. Delegated P1s: cases anonymity leak, recruitment requisition checks, competency exited staff.
19. Indexes in section 5; per-request settings memo.

### P2: hygiene
20. Remove dead tables, columns, flags and `platform_settings` reads.
21. Outbox and notification retention.
22. Fix `z.coerce.boolean` (see below).
23. Pagination on the section 5 list.
24. ESLint, coverage gate, digest pinning, CA checksum, CI on all branches, health port.
25. Key rotation tool.
26. Stream uploads, move XLSX off the event loop.

`z.coerce.boolean` turns `"false"` into true at: `attendance/routes.ts:132`, `competency/routes.ts:118`, `policies/routes.ts:280`, `leave/routes.ts:127`, `notifications/routes.ts:11`.

---

## Revamp impact map

### a) Feature gating

**How it works today**
- `core/features/registry.ts:41`: 34 `FEATURES`, keys with dots (`payroll.statutory`). Fields include `dependencies`, `core`, `requiredSettings`.
- `core/features/state.ts:24`: `resolveEnabledModules(spec)` parses `ENABLED_MODULES` (`config/env.ts:80`), validates unknown keys and dependencies at startup, throwing.
- `app.ts:59`: `setEnabledModules`. Process-wide variable (`state.ts:17`), defaulting to `default` before that call.
- `state.ts:106`: `evaluateFeatures(db, tenantId)` computes per request `usable = supported && enabled && dependenciesMet && configured`. `configured` reads the database and transports through `requiredSettings` and `CONFIG_CHECKS` (`state.ts:74-104`).
- `core/http/context.ts:73` `gateFeatures`: plugin `preHandler` hook. `context.ts:63` `requireFeature`: per-route.

**Off today returns 403, not 404.** `core/http/errors.ts:11` `feature_unavailable`, with a reason string naming the module. Without a session, the gate passes and the handler returns 401 (`context.ts:76`), so anonymous callers cannot distinguish.

**Plan-changing facts**
1. **Enabled and usable are different.** `usable` includes runtime state, so unregistering routes can only implement `enabled`. These stay runtime-gated and still need a response:
   - `overtime`, unusable until setting `attendance.overtime_enabled` (`state.ts:88-91`)
   - `attendance.biometric`, unusable until a device exists; device registration special-cases this at `attendance/routes.ts:366-368`
   - `core.documents`, needs storage (`state.ts:75`)
   - `notifications.email`, needs a transport

   Decide what those return: keep `requireFeature`, change its status or code.
2. **Approval handlers register inside route plugins.** 15 calls to `registerApprovalHandler` at the top of plugin bodies: `salary_change`, `payroll_run` (`payroll/routes.ts:40,52`), `leave_request` (`leave/routes.ts:101`), `attendance_regularization` (`attendance/routes.ts:40`), `employee_loan` (`loans/routes.ts:57`), `overtime_claim` (`overtime/routes.ts:73`), `expense_claim` (`expenses/routes.ts:60`), `separation`, `probation_review` (`lifecycle/routes.ts:41,56`), `employee_profile_change` (`employees/profile.ts:135`), `job_requisition`, `job_offer` (`recruitment/routes.ts:119,130`), `lab_authorization` (`competency/routes.ts:51`), `travel_request` (`travel/routes.ts:105`), `field_duty` (`field-duty/routes.ts:59`).
   Unregistering a plugin leaves pending requests with no handler: `handlers.get(type)!` then throws TypeError, a 500 (`engine.ts:172,187,192,221`). `createApprovalRequest` throws for any cross-module caller (`engine.ts:121`). Move handlers out of plugins, and define behaviour for pending approvals of a disabled module.
3. **The approvals plugin is ungated, and `h.feature` is unused.** Off-module approvals remain visible in the inbox and can be approved, running side effects (`core/workflow/routes.ts`, `engine.ts:34`).
4. **Direct imports cross modules through `routes.ts`.** `core/jobs/registry.ts:10-13` imports `recruitmentRetention`, `lifecycleDaily`, `caseDeadlines`, `assetsDaily` from route files. `lifecycle/routes.ts:15` imports `openAssets` from `assets/routes.ts`. These still work when unregistered, since imports differ from registration. A static import keeps them loaded.
5. **Runtime cross-feature checks**, all through `featureOn` (`lifecycle/service.ts:11`):
   - `payroll/service.ts:58-61,139`, `payroll/routes.ts:388`
   - `accounting/routes.ts:33,36,65,75`
   - `overtime/routes.ts:62-63`
   - `travel/routes.ts:77,272`
   - `recruitment/routes.ts:667`
   - `lifecycle/routes.ts:453,481,495`
   - `employees/profile.ts:167`

**What honours gating today**

| Surface | Honours? | Where |
|---|---|---|
| Module routes | Yes, 403 | 18 `gateFeatures` plugins |
| Ungated plugins | No gate | auth, mfa, tenant, org, employees, approvals, notifications, reports (per report), dashboard (per block) |
| Device ingest | Yes | `attendance/device-routes.ts:54` |
| Jobs | Yes, `usable` | `core/jobs/scheduler.ts:61`, `registry.ts:228`. Retention **skips** when off, so PII outlives `retain_until` `[delegated]`. **Corrected 2026-11-05:** no longer so. A job marked `retention: true` runs with its module off (`core/jobs/registry.ts`, `core/jobs/scheduler.ts`); `test/feature-off.test.ts` covers it |
| Manual job run | Yes | `tenant/routes.ts:120-124` |
| Reports | Yes | `reports/service.ts:29`, `routes.ts:59`; `department_overview` per block |
| Report snapshots | **No** | `reports/routes.ts:178-186`, checks `reports.advanced` only |
| Report exports | Yes | through `runReport` |
| Payroll, accounting, expense exports | Yes | inside gated plugins |
| Dashboard | Yes | `usable()` per block |
| In-app notifications | **No** | `notifyUsers` always writes (`core/notify/service.ts:35`). Email checks `isModuleEnabled` |
| `/auth/me` capabilities | Reports state | `auth.ts:119` |
| `/public/config` modules | Enabled only | `installation.ts:53` |
| `/tenant/settings` | **Lists all** with `featureEnabled` | `tenant/routes.ts:33` |
| `/tenant/jobs` | **Lists all** with `active` | `tenant/routes.ts:106-110` |
| `/tenant/roles` | **Lists all permissions** | `tenant/routes.ts:142` |
| Seeds | **No** | `db/seed.ts`, `db/demo.ts` insert everything |
| Response fields | Mostly not field-level | `employees/profile.ts:167` is one exception |

**Migration work for FEATURE_* with 404**
- `env.ts:80`: replace `ENABLED_MODULES` with one var per key (dots need a mapping, e.g. `FEATURE_PAYROLL_STATUTORY`). `config/env.ts` has a zod schema at `:19` and `installationSchema` at `:153`.
- `app.ts:171-198`: conditional registration. Keep the 404 envelope at `core/http/web.ts:92`.
- `core/jobs/cli.ts` does not call `setEnabledModules`, see (e).
- Deployment repo: `terraform/modules/hrms-stack/compute.tf:118`, `variables.tf:115`, `environments/dev/docker-compose.yml:115`, `.env.example:39`, tfvars templates, and `tests/stack.tftest.hcl:108`.
- Tests: `feature_unavailable` asserted in `feature-gates`, `features-settings`, `payroll`, `policies`, `overtime`, `competency`, `recruitment`, `lifecycle`, `cases`, `leave`. `setEnabledModules` needs care, because each test builds its own app in one process. Registration time differs from the current mutable global, and tests toggling a module after `buildApp` will break.
- Frontend: no `feature_unavailable` reference, decides from `capabilities`, so it should keep working.

### b) Permissions and L4 data

**Definitions.** `core/auth/permissions.ts:7` `PERMISSIONS`, `:115` `SYSTEM_ROLES` in code; custom roles in `tenant_roles` (`migrations/029`). Assignments in `user_roles`.

**Checks.** `tenantActor(req, ...all)` (`context.ts:42`), `tenantActorAny` (`:57`), `a.has()`. Inside handler bodies, so permissions are not route metadata. Loaded per request by `loadPermissions` (`session.ts:72`). Scope is global per tenant, with team scope computed by `teamEmployeeIds` (`attendance/service.ts:141`). `usersWithPermission` is at `core/notify/service.ts:66`.

**L4 holders** (probe of role table):
- `payroll.read`: hr_admin, payroll_manager, finance_manager, auditor.
- `employees.bank.read`: hr_admin, payroll_manager.
- `loans.read`: hr_admin, payroll_manager, finance_manager, auditor.
- `loans.team.read`: department_head, laboratory_manager, reporting_manager.
- `recruitment.compensation`: hr_admin, finance_manager, hiring_approver.
- `accounting.export`: payroll_manager, finance_manager.
- tenant_admin can self-grant any of them.

**L4 read paths.** "Audited" means a row is written for that read.

| Path | Data | Gate | Audited |
|---|---|---|---|
| `GET /payroll/employees/:id/salaries` `payroll/routes.ts:103-110` | amounts, CTC | payroll.read/manage | No |
| `GET /payroll/runs` `:247` | totals | payroll.read/manage/approve | No |
| `GET /payroll/runs/:id` `:289-303` | full register, lines, adjustments | same | No |
| `GET /payroll/payslips/mine` `:487` | own gross, net | payslips.self | No |
| `GET /payroll/payslips/:id` `:496-514` | payslip, UAN, PAN last4, account last4, IFSC | own or payroll.read/manage | Own only (`:512`). **Staff reads not audited** |
| `GET /payroll/employees/:id/statutory` `:141-149` | UAN, ESI, PF id, PAN last4 | payroll.read/manage | No |
| `GET /payroll/fnf-suggestions/:id` `:519` | salary amounts, leave | payroll.manage | No |
| Exports `register`(.csv/.xlsx), `bank`, `pf`, `esi` `:451-484` | amounts, **full account number if `employees.bank.read`**, UAN, ESI | payroll.read/manage | Yes (`:434`) |
| `GET /employees/:id/bank-account` `employees/routes.ts:178` | masked, holder, IFSC | bank.read or self | Yes |
| `GET /expenses/batches/:id/export.csv` `expenses/routes.ts:412-432` | **full account number** with bank.read | expenses.pay | Yes |
| `GET /loans/requests*` `loans/routes.ts:113,130` | amount, EMI, outstanding, recoveries, purpose | self, team, or read/approve/manage | No |
| Reports `payroll_cost` `reports/registry.ts:300`; `department_overview` `:405` | aggregates | payroll.read; see F-10 | Export only (`reports/routes.ts:217`) |
| Report snapshots `reports/routes.ts:165-202`, stored in `report_snapshots.rows` | stored aggregates in plaintext JSONB for 90 days | recipient | Export only |
| `GET /accounting/sources`, `/payroll-runs/:id/journal`, export `accounting/routes.ts:57,98,102` | run totals, journal | accounting.export | Export only (`:88`) |
| Recruitment `recruitment/routes.ts:151,253,264,348,356,437,440` | budget, expected and offered CTC | redacted without recruitment.compensation | No `[delegated]` |
| `GET /tenant/audit` `tenant/routes.ts:345`; `GET /employees/:id/history` `employees/routes.ts:169` | metadata below | audit.read; employees.read | No |
| `GET /approvals/inbox`, `/:id` `core/workflow/routes.ts` | summary text; loan amounts | step approvers | No |
| Notifications, email | see below | recipient | n/a |

**Audit metadata carrying L4, not caught by `REDACT_KEYS` (`core/audit/audit.ts:17`):**
- `payroll.run_computed` totals (`payroll/routes.ts:284`).
- `payroll.adjustment_added` amount (`:318`).
- `loans.requested` and `loans.disbursed` amounts (`loans/routes.ts:108,169`), `loans.repaid` (`:201`).
- `employee.bank_updated` last4 and IFSC (`employees/routes.ts:204`).
- `accounting.exported` total (`accounting/routes.ts:88`).
- `audit.read` is held by tenant_admin, hr_admin and auditor, so tenant_admin sees these without `payroll.read`.

**Notifications carrying L4 despite `templates.ts:2-4`:**
- Loan approval summary with ₹ amount (`loans/routes.ts:107`), which `notifyActiveApprovers` puts in the body (`engine.ts:101`). It goes to `notifications`, `email_outbox`, all plaintext.
- `loans.disbursed` title with amount (`loans/routes.ts:168`).
- Trip estimates (`travel/routes.ts:156,243`) `[delegated]`.
- Salary and payroll summaries are clean (`payroll/routes.ts:131-133,372`). Payslip notice has no figure (`:391`).

**Jobs reading L4:** `reports.scheduled` only (via `runReport`). Others do not.

**Search:** employee search covers code, name, email (`employees/routes.ts:40`), no L4.

**Dashboards:** payroll tile shows status only (`dashboard/routes.ts:158-171`). Expense sum for `expenses.pay` (`:186`), not salary.

**File downloads:** documents and receipts (audited), exports above. **No payslip file exists.**

**Aadhaar does not exist in code, schema or docs** (grep across `src`, `migrations`, `docs`: zero). It could only be in uploaded documents, gated by `documents.restricted`. Any Aadhaar requirement is new work.

**Storage**

| Data | Storage | Location |
|---|---|---|
| Bank account number | **AES-256-GCM** | `employee_bank_accounts.account_number_enc` |
| Account last4, holder, IFSC, bank name | Plaintext | same table |
| PAN | **AES-256-GCM** (never decrypted), last4 plaintext | `employee_statutory.pan_enc`, `pan_last4` |
| UAN, PF member id, ESI IP, tax regime | Plaintext | `employee_statutory` |
| TOTP secret | AES-256-GCM | `users.mfa_secret_enc` |
| POSH narrative | AES-256-GCM | `cases.*_enc`, `case_events.text_enc` |
| Salary | Plaintext JSONB, numeric | `employee_salaries.amounts`, `annual_ctc` |
| Payroll results | Plaintext | `payroll_items.gross, deductions, net, employer_cost, lines, warnings`; `payroll_runs.totals`; `payroll_adjustments.amount` |
| Loans | Plaintext | `employee_loans.amount, installment_amount`; `loan_recoveries.amount` |
| Candidate CTC | Plaintext | `job_requisitions.budget_ctc_max`, `candidates.expected_ctc`, `job_offers.annual_ctc` |
| Derived copies | Plaintext | `report_snapshots.rows/totals`, `accounting_exports.total`, `audit_logs.change_metadata`, `notifications.body`, `email_outbox.*`, `approval_requests.summary` |

**Queries that break under application-level encryption of amounts**

Direct SQL arithmetic or aggregates:
1. `reports/registry.ts:312-319` `payroll_cost`: `sum(pi.gross)`, `sum(pi.deductions)`, `sum(pi.net)`, `sum(pi.employer_cost)`, `sum(pi.lop_days)` with `GROUPING SETS`.
2. `reports/registry.ts:440-442` `department_overview`: `sum(pi.gross)`, `sum(pi.employer_cost)`.
3. `loans/service.ts:15-20` `balanceOf`: `sum(x.amount) FILTER ...`.
4. `loans/routes.ts:25-26` `COLS.outstanding`: `greatest(0, l.amount - sum(x.amount))`, used in list and detail.
5. `payroll/routes.ts:343` `/hold`: `WHERE ... (net >= 0 OR $4)`.

Column types and constraints that must change:
6. `migrations/016:136-139` `payroll_items` numeric columns, written at `payroll/service.ts:125-127`.
7. `migrations/016:115` `payroll_adjustments.amount` with `CHECK (amount <> 0)`, written at `payroll/routes.ts:315`.
8. `migrations/023:9,11` `employee_loans` `CHECK (amount > 0 AND amount = trunc(amount))`; `:39` `loan_recoveries` `CHECK (amount > 0)`. Written at `loans/routes.ts:100,199`, `loans/service.ts:62`.
9. `migrations/016:31` `annual_ctc numeric`, and `:30` `amounts jsonb`.
10. `migrations/014` CTC numeric columns; `recruitment/routes.ts:553` compares in JS, so the query survives.

Read in JS, survives if decrypted in app, but must be touched: `payroll/service.ts:81`, `overtime/service.ts:51`, `payroll/routes.ts:108,298,447-448,492,505,528`, `accounting/service.ts:51-52`, `payroll/routes.ts:459` (`Number(i.net)`), `db/demo.ts`.

Plaintext copies that defeat encryption unless also handled: `payroll_runs.totals` (`payroll/service.ts:132`, read at `payroll/routes.ts:251`, `accounting/routes.ts:62`), `payroll_items.warnings` (`loans/service.ts:59` has ₹ text), audit metadata, snapshots, `accounting_exports.total`, notifications, outboxes.

Not affected: dashboard, leave, attendance. Expense sums are not on your L4 list.

**Implication.** Encrypting `payroll_items` removes all database-side reporting on pay. Reports 1, 2 would need to decrypt and aggregate in Node within the existing 5000-row cap logic. Items 3-5 are per-employee and fine in Node. A run or report snapshot totals table could also work.

### c) Auth

- **Passwords:** scrypt N=32768 r=8 p=1, salted, parameters stored per hash (`core/crypto/index.ts:3,10-25`). Dummy hash for timing on unknown users. Min length from `security.password_min_length`, floor 12 (`settings/registry.ts:147`). No complexity or breach check. Change: `auth.ts:124`, revokes other sessions and notifies.
- **Sessions:** opaque 32-byte token, SHA-256 in DB, `httpOnly`, `Secure` by env, `SameSite=Lax` (`auth.ts:31`, `session.ts:33-41`). TTL `min(setting, SESSION_TTL_HOURS)` absolute, no idle timeout. Server-side revocation. Row is loaded per request (`session.ts:48`). Roles load live, but sessions are revoked on role change anyway (`tenant/routes.ts:337`). Cleanup job at `core/jobs/registry.ts:215`.
- **MFA enforcement:** `core/auth/mfa.ts`. Level = stricter of `MFA_ENFORCEMENT` (`env.ts:77`, default `privileged`) and `security.mfa_enforcement` (default off) (`:28-31`). Enforced in `app.ts:136-141` with allowlists `MFA_PENDING_ALLOWED`, `MFA_ENROLL_ALLOWED` (`mfa.ts:38,40`). `mfaPending` = enrolled and session not verified; `mfaEnrollmentRequired` computed at `session.ts:68`. The gap is F-11. Verify, setup, enable, disable, recovery: `modules/mfa.ts`. Disable is refused if the role requires MFA (`:126`). Admin reset: `tenant/routes.ts:331-335`, no notice to the user. Five wrong codes end the session (`mfa.ts:68`).
- **Lockout:** `auth.ts:55-63`. Setting `security.max_failed_logins` default 5 (range 3-10), 15-minute lock. No IP dimension, so any known email can be locked out. `AUTH_RATE_LIMIT_PER_MINUTE` default 20 per IP (spoofable, F-15).
- **CSRF:** token derived from the session (`session.ts:13`), hash stored, checked for unsafe methods when a valid session exists (`app.ts:128-133`). Delivered by login and `/auth/me`. Device endpoint uses a key header.
- **Password reset: none.** No forgot-password route. `PATCH /tenant/users/:id` has `status`, `roles`, `unlock`, `resetMfa` only (`tenant/routes.ts:310`). The comment at `app.ts:142` about "admin resets" has no implementation. The only recovery is operator-run `bootstrap --reset-admin` (`db/bootstrap.ts:87-94`) for admins. A regular user who forgets a password has no path.
- **Invite links: none for users.** `POST /tenant/users` takes an admin-chosen `initialPassword` (`tenant/routes.ts:285-294`) sent out of band, with forced change. The only link is the bootstrap setup token: `admin_setup_tokens`, hashed, single use, `/setup#token=` (`db/bootstrap.ts:102-105`), consumed at `auth.ts:162`. That mechanism is reusable for invites and reset.
- **New-device alerts: none.** `sessions.ip` and `user_agent` are stored (`session.ts:38`) and never compared. Security notices exist for password change, MFA on/off and recovery code use (`auth.ts:139`, `mfa.ts:61,105,132`), and users can opt out of the email for them through `email_notifications`.
- **Exit:** `endAccess` (`lifecycle/routes.ts:30`) via the daily job. Access ends after the last working day only for approved separations.

### d) A second notification channel

**Corrected 2026-11-05:** this section mapped a channel for removal. It is gone: migration 039 and `CHANGELOG.md`.

### e) Notifications and jobs

**Outbox.** `notifyUsers` (`core/notify/service.ts:32`) writes in the caller's transaction: `notifications` always, `email_outbox` if `msg.email !== false && getMailer() && isModuleEnabled(...)` and the user opted in. Rendered bodies are stored. Note the mailer condition is evaluated in **the process that enqueues**, not the one that sends.

**Templates.** One generic `renderEmail` layout (`core/notify/templates.ts:9`) with per-message title and body. No per-kind templates, no i18n.

**Retries.** `deliverOutbox` (`service.ts:81`): claim 50 per pass with `SKIP LOCKED`, 5 attempts, backoff 2^attempts minutes. Stuck `sending` older than 10 minutes requeues, so delivery is at-least-once and a stuck row can exceed 5 attempts (`:85`). No dead-letter handling beyond `failed`.

**Scheduler.** `core/jobs/scheduler.ts`. `Scheduler` runs in the API process (`server.ts:46-47`, gated by `JOBS_ENABLED`, every `JOBS_INTERVAL_SECONDS`): `tick` then `deliverOutbox`, serially. Claims are DB-backed: `job_runs` unique `(tenant, job, period)` with `ON CONFLICT DO NOTHING`, so multiple instances are safe. Retries: 3 attempts, 5 min × attempts; timed-out `running` rows after 60 min. 14 jobs (`core/jobs/registry.ts:44`). Each job runs in one transaction (`scheduler.ts:31`). `statement_timeout` 30 s per statement applies (`db/pool.ts:13`).

**A separate worker: `core/jobs/cli.ts` is not enough.** It only reads `DATABASE_URL` and calls `tick`, not outbox delivery, and none of these process globals are initialized:

| Global, set today in `buildApp` | Effect if missing in a worker |
|---|---|
| `setEnabledModules` (`app.ts:59`) | Default module set: wrong jobs run or skip |
| `setDeploymentDefaults` (`app.ts:62`) | Code default timezone instead of `ORGANIZATION_TIMEZONE` for job schedule and dates |
| `setDeploymentLimits` (`app.ts:60`) | Default ceiling |
| `setEmailBrand` (`app.ts:64`) | Jobs render emails as "HRMS" with links to `http://localhost` |
| `setMailer` (`app.ts:80`) | Jobs enqueue **no email at all**; `deliverOutbox` exits at once |
| `setStore` (`app.ts:84`) | Retention cannot delete resumes |
| `setEmailTransportConfigured`, `setStorageConfigured` | `usable` wrong for email, documents, which changes `core.documents` jobs |
| `registerApprovalHandler` (route plugins) | Escalation labels fall back to "Request" (`engine.ts:296`). `onApproved` is not called from jobs, so otherwise safe |

**What a worker needs**
1. Extract those calls into `initRuntime(env)` used by both `buildApp` and `worker.ts`.
2. Move handler registration out of plugins.
3. Add `worker` to `docker/entrypoint.sh`.
4. Keep `JOBS_ENABLED=false` on API tasks. The API must still create the mailer to enqueue, even if it never sends.
5. Add a deployment service in `terraform/modules/hrms-stack/compute.tf` and Compose, plus a health signal.
6. Await the running job on shutdown.
7. Move "Run now" (`tenant/routes.ts:126`) to enqueue instead of running inline.

### f) Routes, OpenAPI, errors

**Today.** 329 `app.<method>(` calls, plus plugins registered in `app.ts:171-198`. **Zero** route `schema:` options, no type provider, no swagger dep (grep). 351 inline `.parse(req.*)` calls in handler bodies. Most schemas are anonymous objects built inside handlers, invisible statically. Permissions are also inside handlers. Responses are raw SQL rows with no declared shape, and some use `SELECT *` or `r.*`, `s.*`, `c.*` (`attendance/routes.ts:114`, `payroll/routes.ts:294`, `expenses/routes.ts:150`, `lifecycle/routes.ts:356`).

**Dynamically declared routes that need attention:**
- `exportRun` loop (`payroll/routes.ts:425-426`)
- `for format` loops (`reports/routes.ts:195,213`)
- `accounting/routes.ts:96-108`
- `org/routes.ts:29,41` (`${entity}`)
- `lifecycle/routes.ts:198` (`${action}`)

Multipart routes: `documents`, `expenses` items (also accepts JSON, `expenses/routes.ts:178-185`), `policies`, `recruitment`. Binary and CSV replies: exports, downloads.

**What generating OpenAPI from code requires**
1. Add `@fastify/swagger`, plus `fastify-type-provider-zod` or a thin wrapper over zod 4 `z.toJSONSchema`. Check compatibility with zod 4.6 and Fastify 5 first.
2. Set validator and serializer compilers.
3. Hoist each inline schema to `schema: { params, querystring, body }` route-by-route. About 330 routes, mostly mechanical.
4. Add `response` schemas. These cannot be inferred from raw SQL and are the largest job. Serializing with a schema also drops undeclared fields, so a wrong schema silently removes data; the upside is that it removes accidental `SELECT *` exposure. Could be phased, starting with L4 routes.
5. Add route metadata for permissions (`config: { perms }`) if docs should show them.
6. Error handler: schema validation errors arrive as Fastify validation errors, not `ZodError` (`app.ts:153`). Handle both during migration. Keep the `details[].path` shape.
7. Reports use a dynamic params schema from the registry (`reports/registry.ts:491`), so `oneOf` or a generic object.
8. Tests that POST invalid data currently get 400 only after the auth check, since parsing happens after `tenantActor` in most handlers. Fastify validation runs **before** the handler, so unauthenticated invalid requests would change from 401 to 400, and forbidden from 403 to 400, unless auth moves to a hook. This is the main behaviour change: move auth to `preValidation` first.

**Error format today.** `{ error: { code, message, details? } }` from `app.ts:149-169`, plus `core/http/web.ts:92` and `errors.ts`. Mappings: `AppError`; `ZodError` 400 `validation_failed`; 429 `rate_limited`; PG 23505 → 409, 23503 → 400, 23514 → 400; other 4xx; 500 `internal` with request id. `Content-Type: application/json`.

**RFC 7807 work**
- Change one handler (`app.ts:149`), the notFound handler, and `core/http/errors.ts` (add `type`, `title`). Set `application/problem+json`; `instance` = request id. Keep `code` as an extension.
- Validation details become `errors[]`.
- `onSend` in `app.ts:91` is unaffected.
- **Consumers:** `hrms-frontend/src/api.ts:17-19,29` read `data.error.code/message/details`. `test` references `.error` about 108 times. So use a compatibility phase, returning both shapes or versioning, then flip.

### g) Migration runner

`src/db/migrate.ts`. Reads `*.sql` from `MIGRATIONS_DIR` or the located dir, sorted lexically (`:56`). Table `schema_migrations(name, checksum, applied_at)` (`:50`). Advisory lock 727274 (`:53`). Each file runs in one transaction by simple-query protocol (`:66-70`). Aborts if an applied file's checksum changed (`:62`). Calls `syncFeatureDefinitions` after (`:76`). CLI at `:83`: only `--status` or apply, using `DATABASE_MIGRATION_URL`. `migrationStatus` (`:34`) feeds `/ready`: pending returns 503, unknown (DB newer) only warns (`app.ts:109-110`), by the expand/contract rollback design.

**To add reversible migrations**
1. **Do not put `*.down.sql` in `migrations/`.** The filter `f.endsWith('.sql')` at `:25,:56` would run them as forward migrations, and count them as pending in `/ready`. Use `migrations/down/NNN_name.sql` (`readdir` is not recursive, and a directory name without `.sql` is ignored) or change both filters.
2. **Existing files cannot be edited**, even to add a comment marker, since the checksum aborts the run. In-file `-- down` sections are impossible for 001-031 without a checksum rewrite. Use sidecar files, and declare a baseline: 001-031 irreversible.
3. `migrate.ts`: add `rollback(to|steps)`, with the same lock and one transaction per file; delete the `schema_migrations` row. Refuse if no down file. Optionally store a down checksum; requires an `ALTER` on `schema_migrations`, which is created outside the numbered files at `:50`.
4. `docker/entrypoint.sh:8-11` add `migrate-down`. `package.json` scripts. `app.ts:107-108` documents the current rollback as image-only with expand/contract migrations; `hrms-deployment/.github/workflows/rollback-prod.yml` exists and was not read.
5. A down file must restore grants, since `hrms_app` revocations are per-migration (`migrations/016:158`, `023:61`, `025:48`). It must also deal with `ALTER DEFAULT PRIVILEGES` (`003`), RLS policies and triggers.
6. `CREATE INDEX CONCURRENTLY` is unusable in this runner, up or down, as each file is in a transaction. This matters for adding the indexes in section 5 on large tables.
7. Data loss policy: dropping tables, or encrypting columns in place, cannot be reversed by SQL alone. An encryption migration needs the app key and must run as a script, not a `.sql` file. **The runner has no code-migration support.**
8. `test/global-setup.ts` should run up, down, up in CI to prove them.

### h) Approval engine

**Model.** `core/workflow/engine.ts`. Tables `approval_requests`, `approval_steps`, `approval_delegations` (`migrations/002`, `019`, `028`). Partial unique index: one pending request per entity. Handler per `entity_type` with `onApproved`, `onRejected`, `label`, `requesterLink`.

**Steps.** `StepSpec` is `{kind:'user',userId}` or `{kind:'permission',permission}` (`:27`). Sequential only, no parallel or amount routing. `createApprovalRequest` (`:115`) removes user steps equal to the requester or an excluded party; empty result gives 400 `No eligible approver` (`:124-125`). It does **not** check permission steps for an eligible holder.

**Parties.** `requester_id`; `excluded_user_ids` (`:121-126`); `blockedUsers` adds prior deciders and those they acted for (`:77-83`). Rules at `:158-161`.

**Acting.** `actOnRequest` (`:151`) locks request and step, then `actingRole` (`:139`): permission holder, named user, escalation target, or delegate. Next step activates or the handler runs in the same transaction (`:178-188`). Reject or return skips the rest and calls `onRejected`. Cancel at `:212`; leave bypasses the engine and updates tables directly (`leave/routes.ts:292-294`).

**Delegation.** `core/workflow/delegations.ts`. Up to 90 days, no chaining at creation, applies to `user` steps and escalation targets, **never to permission steps** (`engine.ts:143-145`).

**Escalation.** `escalateOverdue` (`:276`) from job `approvals.escalation`. **User steps only**, once per step, to the approver's manager, else to `approvals.escalations` holders. Off by default.

**Reminders.** Job `approvals.reminder` (`core/jobs/registry.ts:80`).

**No central routing.** Each module builds its own steps.

| Entity | Steps today | Location |
|---|---|---|
| leave_request | manager, else `leave.approve` | `leave/routes.ts:234-235` |
| attendance_regularization | manager, else `attendance.approve` | `attendance/routes.ts:228` |
| expense_claim | manager + `expenses.approve` | `expenses/routes.ts:301-303` |
| overtime_claim | manager + `overtime.approve` | `overtime/routes.ts:143-145` |
| field_duty | manager; `field_duty.approve` if no manager or setting | `field-duty/routes.ts:108-111` |
| travel_request | manager + `travel.approve` conditional | `travel/routes.ts:149-153` |
| employee_loan | manager + `loans.approve` | `loans/routes.ts:102-105` |
| separation | manager (resignation) + `lifecycle.manage` | `lifecycle/routes.ts:296-298` |
| probation_review | `lifecycle.manage` | `lifecycle/routes.ts:271` |
| employee_profile_change | `profile.approve` | `employees/profile.ts:195` |
| salary_change, payroll_run | `payroll.approve` | `payroll/routes.ts:133,372` |
| job_requisition, job_offer | `recruitment.approve` | `recruitment/routes.ts:216,613` |
| lab_authorization | `competency.authorize` | `competency/routes.ts:296` |

**What 'single' / 'single_hr' one-step collapse touches**
- **The eight manager-first builders above** (leave, regularization, expenses, overtime, field duty, travel, loans, separation). The cleanest change is one helper, `buildSteps(db, tenant, {employee, requester, financePermission, ...})`, in the engine, replacing the inline blocks. `field_duty.hr_approval` (`settings/registry.ts:87`) is the only existing precedent for a setting-driven route.
- **New setting** in `core/settings/registry.ts` (or env). Decide whether it is per module or global. `/tenant/settings` renders from the registry automatically.
- **Collapsing to a permission step (`single_hr`) loses escalation and delegation entirely**, because both only apply to user steps (`engine.ts:143-145,281`). Reminders would be the only safety net. This is the biggest behaviour consequence.
- **The self-approval gap gets worse.** With one HR step, an HR requester who is the only holder sticks forever (F-14, `engine.ts:124`). This needs a fallback before collapse.
- **`single` to the manager removes the finance or HR check,** which is the only segregation of duties for expenses, loans, travel advances and overtime payout. Expenses, loans and travel money paths should probably keep their finance step, or be explicitly excluded. Payroll maker-checker is already single-step with `payroll.approve`, so it is unaffected.
- **Handlers:** none depend on step count, so `onApproved` needs no change. Loan and overtime `loadX` access checks include `approver_user_id` or `acted_by` (`loans/routes.ts:36-37`, `overtime/routes.ts:54-55`) and keep working, but a former manager step means managers lose read access through this path, relying on `team.read` instead.
- **In-flight requests:** steps are frozen at creation, so existing requests finish on their old route. Nothing to migrate.
- **Tests:** `test/expenses.test.ts:73` asserts the two-step flow directly. Flow tests for overtime, travel, loans and field duty act through the same approvals and need review; they were not individually checked.
- **Docs:** `docs/APPROVALS.md` and per-module docs.
- **Frontend:** not checked for step-count assumptions.
