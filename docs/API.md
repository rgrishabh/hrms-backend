# API reference (v1)

Base path `/api/v1`. JSON in and out. Each installation serves one organization; requests must use one of its configured hostnames (`APP_URL`/`APP_EXTRA_DOMAINS`), otherwise `404 unknown_tenant`.

**Auth:** `POST /auth/login` sets an httpOnly session cookie and returns `csrfToken`. Every `POST/PUT/PATCH/DELETE` made with the cookie must send `x-csrf-token`. Device ingestion uses `X-Device-Key` instead.

**Errors:** `{ "error": { "code": "...", "message": "...", "details": ... } }`. Codes include `validation_failed` (400, details = `[{path, message}]`), `setup_link_invalid` (400), `unauthorized` (401), `forbidden` (403), `feature_unavailable` (403), `password_change_required` (403), `csrf_failed` (403), `not_found` / `unknown_tenant` (404), `conflict` / `duplicate` (409), `rate_limited` (429).

**Pagination:** `?page=1&pageSize=25` (max 100) → `{ items, page, pageSize, total }`.

| Method & path | Permission | Purpose |
|---|---|---|
| **Health** | | |
| GET `/health/live`, `/health/ready` | none | Liveness / readiness (DB reachable, migrations current, installation bootstrapped) |
| **Auth & self** | | |
| GET `/public/config` | none | Runtime branding, organization identity and enabled modules (no secrets) |
| POST `/auth/setup` | one-time token | Complete an administrator setup link `{token, newPassword}` |
| POST `/auth/login` · `/auth/logout` | none / session | Sign in / out |
| GET `/auth/me` | session | User, roles, permissions, `capabilities` (module → usable), preferences, `passwordChangeRequired`, csrf |
| POST `/auth/password` | session | Change password (revokes other sessions; clears a forced change) |
| POST `/auth/sessions/revoke-all` | session | Sign out everywhere |
| **Tenant administration** | | |
| GET `/tenant/settings?branchId=` | `settings.read` | Effective values with source, default, inherited values, version |
| PUT/DELETE `/tenant/settings/:key` | per-setting edit permission | Set (`{value, scope, branchId, expectedVersion}`) / reset to inherited |
| GET `/tenant/installation` | settings.read | Read-only: branding, organization, domains, module states (supported/enabled/configured/usable + blockers) |
| GET `/tenant/roles` | users.manage or settings.read | System + organization roles (each with `grantable` for the caller, `users` count; organization roles with `mfaRequired`), permission catalogue (`privileged` = needs 2FA), `canManage`, `maxPermissions` (null for an administrator) |
| POST `/tenant/roles`, PATCH / DELETE `/tenant/roles/:key` | `users.manage` | `{name, description?, permissions[]}`; key `custom:<slug>`. Only permissions the caller holds (administrator: any). Changing permissions signs holders out (`holdersSignedOut`). Delete refused while anyone holds it. Built-in roles cannot be changed |
| GET/POST `/tenant/users`, PATCH `/tenant/users/:id` | `users.manage` | Create, roles, disable, unlock |
| GET `/tenant/audit` | `audit.read` | Filter by category/target/action |
| **Organization** | | |
| GET `/org` | org.read or employees.directory | Legal entities, branches, departments |
| POST/PUT `/org/{legal-entities|branches|departments}[/:id]` | `org.manage` | |
| **Employees** | | |
| GET `/employees` | employees.read (full) or employees.directory (active, basic fields) | Search/filter/paginate |
| GET `/employees/me`, `/employees/:id` | self / read / directory | Full view for self and readers |
| POST `/employees` | `employees.manage` | `{employee, confirmDuplicate}`; 409 with `duplicates` when likely duplicate |
| PATCH `/employees/:id` | employees.manage | `{changes, expectedVersion}` |
| POST `/employees/import` | employees.manage | `{dryRun, rows[]}` (≤ 2000), all-or-nothing |
| GET `/employees/:id/history` | employees.read | Field-level change history |
| GET/PUT `/employees/:id/bank-account` | `employees.bank.read` (or self) / `employees.bank.manage` | Masked view (audited) / proposes an encrypted change: 202, applied when someone with `employees.bank.approve` approves it. Not your own account |
| GET `/employees/:id/bank-account/pending` | `employees.bank.read` or `employees.bank.approve` | The waiting change, masked (audited) |
| POST `/payroll/runs/:id/reopen` | `payroll.manage` | Approved run back to draft |
| POST `/payroll/runs/:id/items/:employeeId/release` | `payroll.approve` | Release held pay after finalize |
| GET `/payroll/runs/:id/bank-released.csv` | `payroll.read` | Held pay released after finalize |
| GET `/employees/:id/profile` | profile.self (own) / employees.read | Personal details `{sections: {contacts, addresses, nominees, education, experience}, pending, missing, edit}`; see EMPLOYEE_RECORD.md |
| PUT `/employees/:id/profile/:section` | employees.manage / profile.self (own) | Replace a section `{items, note?}`: applied (200), or for the employee's own nominees, education and employment history a change for HR approval (202 `{changeId, approvalId}`) |
| GET `/employees/profile-changes/:id` · POST `/employees/profile-changes/:id/withdraw` | employee / profile.approve / employees.read · employee | Proposed change with the section as it is now · withdraw while pending |
| **Attendance** | | |
| POST `/attendance/punch` | `attendance.self` + module | `{channel, idempotencyKey, direction?, latitude?, longitude?}` |
| GET `/attendance/me?from&to`, `/attendance/me/today` | attendance.self | Own days + raw events |
| GET `/attendance/employees/:id?from&to` | self, team (manager chain), or attendance.read | |
| GET `/attendance/daily?date&branchId&status&exceptionsOnly` | attendance.read or team.read | Daily register + summary |
| POST `/attendance/recalculate` | `attendance.recalculate` | ≤ 62 days; skips locked |
| GET/POST `/attendance/locks` | read / `attendance.lock` | Payroll period locks |
| GET/POST `/attendance/regularizations` | attendance.self (mine) / attendance.read (all) | Request creates an approval |
| GET/POST `/attendance/shifts`, PUT `/attendance/shifts/:id` | `attendance.configure` (write) | |
| POST `/attendance/shift-assignments` | attendance.configure | Closes previous open assignment; ends any rotating roster from that day |
| GET / POST `/attendance/roster-patterns`, PATCH `/attendance/roster-patterns/:id` | read: attendance.configure/read/team.read; write: attendance.configure | `{code, name, days: (shiftId|null)[]}`; days fixed once used |
| POST `/attendance/roster-assignments`, POST `/attendance/roster-assignments/end` | attendance.configure | `{employeeIds, patternId, effectiveFrom, effectiveTo?, startDay}` / `{employeeIds, lastDay}`; recalculates up to today |
| PUT `/attendance/roster-overrides`, DELETE `/attendance/roster-overrides/:employeeId/:date` | attendance.configure | `{employeeId, date, shiftId|null, reason}` |
| GET `/attendance/roster?from&to&departmentId&search` | everyone (scoped: all / team / self) | At most 42 days; `{dates, shifts, items:[{id, code, name, department, days:[{date, shiftId, off, holiday, source, pattern, reason}]}], canEdit}` |
| GET/POST `/attendance/holidays`, DELETE `/attendance/holidays/:id` | session / configure | |
| GET/POST `/attendance/devices`, PATCH `/attendance/devices/:id`, POST `/attendance/devices/:id/rotate-key` | `attendance.devices.manage` | Key shown once |
| GET `/attendance/device-mappings`, PUT `/attendance/device-mappings/:deviceUserId` | devices.manage | Mapping reprocesses unmapped events |
| GET `/attendance/device-events/unmapped` | devices.manage | Error queue |
| POST `/devices/events` | `X-Device-Key` | See BIOMETRIC_INTEGRATION.md |
| **Leave** (module `leave`; see LEAVE.md) | | |
| GET/POST `/leave/types`, PUT `/leave/types/:id` | leave.self (read active) / `leave.manage` | Leave policies |
| GET `/leave/balances?employeeId&year` | self, team, `leave.read` | Balance, pending, used, available per type |
| GET `/leave/ledger?employeeId&leaveTypeId&year` | self, team, `leave.read` | Ledger entries |
| POST `/leave/requests/preview` | leave.self / leave.manage | Days per date, available, sufficient |
| POST `/leave/requests` · GET `/leave/requests?scope=mine\|team\|all` | leave.self (own) / leave.manage (on behalf) | Creates an approval request |
| POST `/leave/requests/:id/cancel` | requester or `leave.manage` | Reverses consumed days if approved |
| GET `/leave/calendar?from&to` | team / `leave.read` | Pending + approved leave intervals (≤ 92 days) |
| POST `/leave/accruals`, `/leave/year-end`, `/leave/adjustments` | `leave.manage` | Idempotent jobs; audited |
| **Field duty** (module `field_duty`; see FIELD_DUTY.md) | | |
| POST `/field-duty/requests` | field_duty.self / manage | Request `{startDate, endDate, dayPart, purpose, place, clientName?, reference?, reason}`, or record it for an employee (`employeeId`, manage). Manager approves, then HR if `field_duty.hr_approval` is on |
| GET `/field-duty/requests?scope=mine\|team\|all&status&on&from&to` · GET `/field-duty/requests/:id` | field_duty.self / team.read / read | List / detail |
| POST `/field-duty/requests/:id/withdraw` · `/cancel` · `/report` | employee / field_duty.manage | Withdraw pending; cancel approved (employee before it starts, HR until the dates are locked); report the outcome once started |
| **Travel** (module `travel`; see TRAVEL.md) | | |
| POST `/travel/requests` | travel.self | Request `{purpose, tripType, origin, destination, startDate, endDate, travelMode, accommodation, project?, estimate{travel,stay,local,meals,other}, advance, markOnDuty}`. Manager approves, plus finance for advances, trips abroad and large estimates |
| GET `/expenses/allowance-rates`, POST (expenses.manage) `{kind: per_diem, tier, grade?, rate, effectiveFrom, note?}` or `{kind: mileage, vehicle, rate, effectiveFrom}`, DELETE `/:id` (not yet in force) | expenses.self / travel.self to read | Per-diem and mileage policy rates; `state` current / scheduled / superseded |
| GET `/expenses/allowance-quote?kind&date&to?&tier?&vehicle?&km?` | expenses.self / travel.self | What an allowance comes to for the employee's grade; `{rate: null}` when no rate |
| GET `/travel/requests?scope=mine\|team\|all&status&advance=to_pay\|outstanding&on` · GET `/travel/requests/:id` | travel.self / team.read / read, expenses.pay | List / detail with `settlement` |
| POST `/travel/requests/:id/withdraw` · `/cancel` · `/complete` · `/claim` | traveller (cancel: also travel.approve) | Withdraw pending; cancel approved; mark completed; start the trip's expense claim |
| POST `/travel/requests/:id/advance-paid` · `/advance-returned` · `/close` | expenses.pay | Record the advance paid `{reference}`; record unspent advance returned `{amount, note}`; close a settled trip |
| **Advances and loans** (module `advances_loans`; see ADVANCES_LOANS.md) | | |
| POST `/loans/requests` | loans.self / loans.manage | Apply `{kind: salary_advance\|loan, amount, installments, firstPeriod, purpose, employeeId?}` → manager, then finance |
| GET `/loans/requests?scope=mine\|team\|all&status&kind` · GET `/loans/requests/:id` | loans.self / team.read / read | List (with `outstanding`) / detail with `balance`, `schedule`, `recoveries` |
| POST `/loans/requests/:id/withdraw` · `/disburse` · `/cancel` · `/repayment` · `/defer` | applicant / loans.manage (cancel: also loans.approve) | Withdraw pending; disburse `{reference}`; cancel approved; repayment `{amount, reference}`; defer `{period, reason}` |
| **Accounting exports** (module `accounting_exports`; see ACCOUNTING_EXPORTS.md) | | |
| GET / PUT `/accounting/ledger-map` | accounting.export / accounting.configure | Ledger names per head (`{entries:[{key, ledger}]}`; empty ledger removes); `heads` lists what to map |
| GET `/accounting/sources` | accounting.export | Finalized/paid runs and approved/paid batches with their last export |
| GET `/accounting/payroll-runs/:id/journal` · `/reimbursement-batches/:id/journal` | accounting.export | Voucher preview with `missing` heads and `balanced` |
| GET `/accounting/payroll-runs/:id/export?format=csv\|tally_xml` · `/reimbursement-batches/:id/export` | accounting.export | Download (refused while heads are unmapped); logged and audited |
| **SMS** (module `notifications.sms`; see SMS.md) | | |
| GET `/sms/templates` · PUT / DELETE `/sms/templates/:kind` | settings.manage | DLT templates per notification kind `{dltTemplateId, text, enabled}` |
| GET `/sms/outbox?status` · POST `/sms/test {phone, kind}` | settings.manage | Recent SMS (numbers masked); send a template now to check the provider |
| **Advanced reporting** (module `reports.advanced`; see REPORTS.md) | | |
| GET / POST `/reports/saved` · DELETE `/reports/saved/:id` | can run the report | My saved reports `{reportKey, name, params}` |
| GET `/reports/saved/:id/recipients` | owner | Who may receive it (organization-wide access) |
| PUT / DELETE `/reports/saved/:id/schedule` | owner | `{frequency, weekday?, dayOfMonth?, period, recipientIds, enabled}`; recipients need organization-wide access |
| GET `/reports/snapshots` · `/reports/snapshots/:id` · `/reports/snapshots/:id/export.csv` / `.xlsx` | recipient with access | Scheduled reports sent to me |
| **Overtime** (module `overtime`; see OVERTIME.md) | | |
| GET `/overtime/eligible` | overtime.self | My days with recorded overtime still to claim, and the payout options |
| POST `/overtime/claims` | overtime.self | Claim `{workDate, minutes, payout, reason}` → manager, then HR approval |
| GET `/overtime/claims?scope=mine\|team\|all` · GET `/overtime/claims/:id` | overtime.self / team.read / read | List (with `minutesByStatus`) / detail |
| POST `/overtime/claims/:id/withdraw` · `/cancel` | claimant / overtime.manage | Withdraw pending / cancel approved (reverses comp off; resets a computed run) |
| **Approvals** | | |
| GET `/approvals/inbox`, `/approvals/mine`, `/approvals/:id` | session | |
| POST `/approvals/:id/act` | current-step approver (never the requester) | `{action: approve|reject|return, comment}` (comment required unless approving) |
| POST `/approvals/:id/cancel` | requester | |
| GET / POST `/approvals/delegations`, POST `/approvals/delegations/:id/revoke`, GET `/approvals/delegates` | session (HR for others: `approvals.delegations`) | Hand over approvals while away; see docs/APPROVALS.md |
| **Dashboard** | | |
| GET `/dashboard` | session | `{today, sections, lists}`: tiles grouped as `me` (own leave balances, own training due), `team` (managers without organization-wide access: reporting chain size and today's attendance), `org` (headcount, joiners/leavers this month, latest payroll run), `today` (organization attendance today), `attention` (missing punches, open probation reviews, claims to reimburse, open positions, training / authorizations / documents expiring, open grievances); lists `on_leave_today` and `holidays`. Each block follows the permission and module of the screen it links to (`href`) |
| **Reports** (see REPORTS.md) | | |
| GET `/reports` | session | Reports the caller may run (permission + module), with `scope` (`all` or `team`) and parameter definitions with defaults |
| GET `/reports/:key?…params` | the report's permissions | `{columns, rows, totals, notes, scope, params, truncated}`; ≤ 5000 rows |
| GET `/reports/:key/export.csv?…params` · `/reports/:key/export.xlsx?…params` | the report's permissions | Same data as CSV (UTF-8 BOM, formulas neutralized) or Excel (typed columns, totals; text never a formula); `no-store`; audited `reports.exported` with the format |
