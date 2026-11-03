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
| GET `/tenant/roles` | users.manage or settings.read | System + custom roles, permission catalogue |
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
| GET/PUT `/employees/:id/bank-account` | `employees.bank.read` (or self) / `employees.bank.manage` | Masked view (audited) / encrypted update |
| **Attendance** | | |
| POST `/attendance/punch` | `attendance.self` + module | `{channel, idempotencyKey, direction?, latitude?, longitude?}` |
| GET `/attendance/me?from&to`, `/attendance/me/today` | attendance.self | Own days + raw events |
| GET `/attendance/employees/:id?from&to` | self, team (manager chain), or attendance.read | |
| GET `/attendance/daily?date&branchId&status&exceptionsOnly` | attendance.read or team.read | Daily register + summary |
| POST `/attendance/recalculate` | `attendance.recalculate` | ≤ 62 days; skips locked |
| GET/POST `/attendance/locks` | read / `attendance.lock` | Payroll period locks |
| GET/POST `/attendance/regularizations` | attendance.self (mine) / attendance.read (all) | Request creates an approval |
| GET/POST `/attendance/shifts`, PUT `/attendance/shifts/:id` | `attendance.configure` (write) | |
| POST `/attendance/shift-assignments` | attendance.configure | Closes previous open assignment |
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
| **Approvals** | | |
| GET `/approvals/inbox`, `/approvals/mine`, `/approvals/:id` | session | |
| POST `/approvals/:id/act` | current-step approver (never the requester) | `{action: approve|reject|return, comment}` (comment required unless approving) |
| POST `/approvals/:id/cancel` | requester | |
