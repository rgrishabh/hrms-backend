# Decision log

## D1 — Technology stack (greenfield)
**Context:** the repository was empty, so there was no stack to preserve.
**Decision:** a TypeScript monorepo (npm workspaces). API on Fastify 5 + `pg` + zod. Web on React + Vite. PostgreSQL. Vitest.
**Why:** one language end to end. Fastify has first-class hooks for request-scoped tenancy. Raw SQL via `pg` keeps RLS, `SET LOCAL` and composite keys explicit, which ORMs tend to hide. PostgreSQL provides RLS, `timestamptz`, `numeric` and transactional DDL.
**Trade-off:** no ORM-generated types. Query result shapes are typed by hand at the call site.

## D2 — `tenant_id` column + RLS (now defence in depth; see D16, D19)
**Alternatives:** schema-per-tenant, or database-per-tenant.
**Decision:** a shared schema. Isolation comes from (1) mandatory app-level filters, (2) RLS bound to a transaction-local setting, and (3) composite tenant foreign keys.
**Why:** this suits dozens to low hundreds of lab tenants of ~1,000 employees each. One migration path, cheap provisioning.
**Revisit if:** a customer contractually requires physical separation. The code is tenant-scoped everywhere, so a dedicated deployment per tenant is possible without code changes.

## D3 — Two database roles
`hrms_owner` owns the schema and runs migrations. `hrms_app` is the runtime role with NOSUPERUSER, NOBYPASSRLS and reduced grants (audit insert-only, raw events not deletable). The server refuses to boot if its role could bypass RLS.

## D4 — Tenant resolution from verified domains only
The Host header is honoured only when it matches a domain row that is `verified` and `active`. Sessions store their tenant, and a session presented on another tenant's host is treated as unauthenticated. Platform administration runs on separate hostnames (`PLATFORM_HOSTS`) with users whose `tenant_id IS NULL`.

## D5 — Opaque server-side sessions, not JWT
Sessions are a random token in an httpOnly SameSite=Lax cookie, stored only as a SHA-256 hash. This allows immediate revocation (logout, disable, role change, tenant suspension, password change). The CSRF token is derived from the session token and sent in the `x-csrf-token` header.

## D6 — Password hashing with Node's built-in scrypt
N=2^15, r=8, p=1, 16-byte salt. No native dependency. The format is self-describing, so parameters can be raised later.

## D7 — Field-level encryption for bank account numbers
AES-256-GCM with `DATA_ENCRYPTION_KEY`. Only the last 4 digits are queryable. The API never returns the full number. In production the key should come from Secrets Manager, and moving to KMS envelope encryption is recommended (see SECURITY.md).

## D8 — Feature registry in code, mirrored to DB
The typed registry is the source of truth and is reviewed in pull requests. `feature_definitions` is synced at migrate time for SQL use. `availability: 'planned'` modules are listed but cannot be enabled or entitled, so unbuilt features never appear operational.

## D9 — Settings read-through, no cache
Effective settings are resolved from indexed tables on each use. With no cross-instance cache, there is no invalidation problem and changes apply immediately everywhere. Revisit with per-request memoization if profiling shows a cost.

## D10 — Attendance: immutable events + derived daily results
Raw events are never updated (except to map an unmapped device user) or deleted. Daily results are recomputed from events + policy by a pure, versioned function (`CALC_VERSION`) and store a policy snapshot. Corrections are new `regularization` events. Locked periods are never recalculated.

## D11 — Server time for web/mobile punches
Client clocks are ignored for web and mobile punches. Devices report their own clock, and the server corrects their events by the measured drift (rounded to whole seconds).

## D12 — Biometric: vendor-neutral push contract first
No vendor SDK or API is assumed. Vendor adapters will translate to the `generic_push_v1` contract once the actual hardware is confirmed. Only attendance events are ingested. No biometric templates are collected.

## D13 — Forward-only, checksummed SQL migrations
Each migration runs in a transaction. An advisory lock serializes concurrent deploys. Editing an applied migration aborts the run. Rollback is by forward fix (see DEPLOYMENT.md).

## D14 — Tests against a real PostgreSQL
Isolation depends on RLS, constraints and grants, which mocks cannot exercise. The test run drops and re-migrates the `hrms_test` schema each time, which also tests the migrations.

## D15 — RLS is not forced on the schema owner (migration 004)
**Context:** a local backup/restore rehearsal showed `pg_dump` failing as `hrms_owner`, because `FORCE ROW LEVEL SECURITY` subjected the owner to policies.
**Decision:** remove FORCE. RLS remains enabled and fully applies to the runtime role `hrms_app`, which is neither owner nor BYPASSRLS. The server checks this at boot.
**Why:** the owner can disable RLS on its own tables at any time, so FORCE protected nothing against it, and it broke backups. The owner role is used only for migrations and backups and must be guarded as a privileged credential.

## D16 — One AWS account per customer (supersedes D2 for production)
**Context:** customers need strong, auditable isolation.
**Decision:** each customer runs a dedicated deployment in its own AWS account, created via AWS Organizations / Control Tower. The application runs with `DEPLOYMENT_MODE=single_tenant`, which disables the platform console, makes the server refuse to start if the database holds more than one organization, and creates the organization with a declarative, idempotent **bootstrap** task fed from the customer's Terraform config. The multi-tenant code paths (tenant filters, RLS, composite keys) stay as defence in depth and keep local development and tests unchanged.
**Consequences:** fixed infrastructure cost per customer. One image released to every account by one pipeline (staging → canary → rest). Shared Services holds the image registry and Terraform state. Guardrail SCPs bind every customer account.

## D17 — The API serves the web app (single origin per customer)
The built SPA is shipped in the API image and served from memory with its own strict CSP. One origin means no CORS and no cross-site cookies, and the domain → organization mapping applies to both UI and API. Static files are an in-memory map of the build output, so path traversal is impossible. This avoided a dependency (`@fastify/static`) with open advisories.

## D18 — Database provisioning and TLS
A `provision` task (the only holder of the RDS master secret) creates `hrms_owner` and `hrms_app` and resets their passwords to the values in Secrets Manager on every release. Connections use `DATABASE_SSL=verify-full` with the RDS CA bundle baked into the image. This is mandatory in production; the server refuses to start otherwise.

## D19 — Deployment-level installations only; platform console removed (supersedes D4, D8 entitlements, and the provisioning parts of D16)
**Context:** customers are provisioned by deploying an installation (Docker Compose or Terraform), not through the application.
**Decision:** removed the platform console, tenant domain registration and verification endpoints, platform roles, and module entitlements. An installation always holds exactly one organization. The server refuses to start otherwise, and bootstrap refuses to create a second. Domains, branding and modules come only from deployment configuration and have no write API.
**Kept:** `tenant_id`, RLS and composite foreign keys, as defence in depth and for compatibility with existing data. The tables `tenant_branding`, `tenant_modules` and `tenant_feature_entitlements` are no longer read and are kept, not dropped.

## D20 — Runtime white-label configuration
Branding and organization identity are env vars validated at startup and exposed only through a non-secret public config endpoint. `index.html` is rendered per installation at startup. One image serves all customers, and changing branding needs a restart, not a rebuild. Organization timezone and date format are *defaults* that administrators may override as business settings. Everything else in branding is deployment-controlled.

## D21 — Modules are deployment-controlled (`ENABLED_MODULES`)
**Replaces** the admin toggle and entitlement layers. The set is validated at startup (unknown, unbuilt, or missing dependencies → refuse to start), held per process, enforced in API and UI, and never deletes data. Changing it requires a restart.

## D22 — Administrator bootstrap: setup link or temporary password
**Setup-link** (Compose): no password ever exists outside the admin's browser; the token is single-use, expiring, stored hashed, and placed in the URL fragment. **Password** (AWS): generated into Secrets Manager, then a forced change at first sign-in. Bootstrap only ever creates the first administrator; `--reset-admin` is the explicit, audited recovery path.

## D23 — Docker Compose hardening
Each customer gets its own Compose project. Postgres has no published port and sits on an `internal: true` network. One-off `provision` and `migrate` services run before the app (`service_completed_successfully`). Secrets are scoped per service (the superuser password never reaches the app). Containers run with a read-only root filesystem, all capabilities dropped and `no-new-privileges`. The app binds to localhost behind Caddy or the operator's proxy.

## D24 — Technical authorization reuses the approval engine, with competence-specific guards
A request is an approval request (`lab_authorization`) routed to holders of `competency.authorize`, so it appears in the normal inbox and notifications. On top of the engine's requester-cannot-approve rule, the handler refuses an approver who *is* the person being authorized, re-checks training prerequisites at approval time, and a database CHECK rejects `authorized_by = requested_by`. "In force" is computed live (status + review date + training validity today) rather than by auto-suspending, so a lapse is visible immediately and the quality manager keeps the decision to suspend; overdue reviews are expired by a scheduled job with an event attributed to the system.

## D25 — ESI contribution periods and TDS on one-off earnings
**Context:** F-4 annualized one-offs for TDS, F-5 judged ESI cover on prorated pay. Both are legal treatments, so they sit in code as rules without any rate; rates stay in the verified register.
**Options, ESI:** judge each month on current wage; judge on the wage at the start of the contribution period; a per-employee cover flag kept by HR.
**Decision, ESI:** contribution periods are 1 April to 30 September and 1 October to 31 March. Cover for a whole period follows the full-month ESI wage (no proration, overtime excluded) at the period start, or the employee's first salary in the period if they joined later. A raise mid-period keeps cover until the period ends. A cut mid-period starts cover only at the next period. The threshold is the verified rule in force at the end of the payroll month.
**Options, TDS:** annualize everything; spread the one-off over the remaining months; tax it fully in the month paid.
**Decision, TDS:** each taxable adjustment, overtime and encashment is a one-off. Regular salary is projected to 12 months and its tax spread over 12. The one-off adds the difference between the year's tax with and without it, all in the month paid, including any rebate it forfeits.
**Reason:** this is the mainstream Indian payroll treatment. YTD true-up, declarations and marginal relief at the rebate limit remain unimplemented. **Both need confirmation by a qualified reviewer; see `INDIAN_PAYROLL_COMPLIANCE.md`.**

## D26 — Bank changes approved by a separate permission
**Context:** F-9. `employees.bank.manage` wrote directly. HR Admin was the only holder, so a second holder of the same permission would not exist in most organizations.
**Options:** require two holders of `employees.bank.manage`; add an approve permission; use `payroll.approve`.
**Decision:** new `employees.bank.approve`, held by HR Admin and Finance Manager. Every change including the first entry goes through approval, and the proposer and the employee are excluded. The employee is told when it is proposed and when it applies.
**Reason:** it works out of the box where one HR admin exists, and it keeps Payroll Manager, who runs the bank file, out of both sides.

## D27 — `TRUST_PROXY` is a hop count; per-account login limit in process
**Context:** F-15. `TRUST_PROXY=true` made Fastify take the leftmost `X-Forwarded-For`, which the client controls, so per-IP limits and audit addresses could be forged.
**Options:** remove `true`; treat `true` as one hop; hop count or CIDR list.
**Decision:** `false`, a hop count, or a list of proxy addresses/CIDRs. `true` is kept and means one hop, so existing deployments with one proxy (ALB, Caddy) become correct without a config change. A deployment with more proxies in front must set the real count. Fastify treats a bare number as trust-nothing, because a hop count cannot check the immediate peer, so the app must not be reachable directly when a count is used; a CIDR list is stricter where proxy addresses are known. New `AUTH_ACCOUNT_RATE_LIMIT_PER_MINUTE` (default 10) limits sign-in attempts per account across addresses; it refuses before any password hash runs.
**Limits:** the counter is per process until a shared store exists, so N instances allow N times the limit. A forged address no longer locks anyone out faster, but a known email can still be locked by the existing failure lockout. Not tested behind a live ALB.

## D28 — Half-day overlap and existing overlaps
**Context:** leave overlap was date-only, and only checked in the application. A constraint added now must not fail a deployment on rows that already overlap, and cancelling approved leave in a migration is not ours to decide.
**Decision:** an exclusion constraint on half-day slots, with `overlap_legacy` flagging rows that overlapped when the migration ran; flagged rows are outside the constraint and stay as they are for HR. A paid and an unpaid half on one date are refused, because attendance keeps one leave type per date and LOP could not tell them apart.

## D29 — One runtime, two processes; "Run now" is queued
**Context:** the scheduler ran inside the API, and `core/jobs/cli.ts` set up none of the process state a job needs. The contract says only the worker runs jobs and sends email.
**Options:** keep `JOBS_ENABLED` and a CLI; extract `initRuntime(env)` and add a worker; a separate image.
**Decision:** `initRuntime` is shared by `buildApp` and `src/worker.ts`, in one image, selected by `PROCESS_ROLE` and `hrms worker`. Each command refuses the other's role. Approval handlers are registered there, independent of routes. The API still builds the mailer, because whether to enqueue depends on it, but never calls delivery. "Run now" inserts a `queued` row and answers 202; the worker runs it on its next pass, within `JOBS_INTERVAL_SECONDS`.
**Health:** the worker has no port, so it writes a heartbeat file every 15 s (`WORKER_HEARTBEAT_FILE`, default in the temp directory) and `hrms worker-health` reads it. Unhealthy means no heartbeat for 60 s, a pass running over 75 min, or no pass for three intervals. The image's `HEALTHCHECK` runs `hrms healthcheck`, which picks the right check by role. On SIGTERM it starts no new pass and awaits the running one.
**Reason:** a job needs the same process state wherever it runs, and a queued run keeps long jobs out of the request path.

## D30 — Node 24 in the image
**Context:** batch D hashes passwords with the built-in `crypto.argon2`, added in Node 24.7.
**Options:** the `argon2` npm package with its native build; Node >= 24.7.
**Decision:** `node:24-alpine` for both stages, `engines.node >= 24.7`, and a build step that fails if `crypto.argon2` is missing, so a stale base image can't ship.
**Reason:** no native dependency in an image that deliberately carries little.

## D31 — Selfies, geofence and comp off: what each new flag decides
**Selfie.** The contract says "camera selfie at check-in". Upload first, then send its id with the clock-in, so a failed punch does not lose the photo and a retried one does not store two. It goes through the storage layer under `<org>/selfies/<employee>/`; the row records `data_class='L3'`. A setting decides whether it is required (default yes) and for how long it is kept (default 90 days), and `attendance.selfie_retention` erases blob and key on that date, and unused uploads after a day. Without storage the upload answers `feature_not_configured`, and clock-in does not demand a selfie: a store nobody set up should not stop people recording attendance.
**Geofence.** No geofence existed; only a location mode. The new `branch_geofences` table sits apart from `branches` so the org listing cannot leak it. Outside the fence is flagged on the event, or refused if `attendance.geofence_enforce` is on. As before, location is captured on the mobile channel only, so this flag does nothing useful without `FEATURE_ATTENDANCE_MOBILE`.
**Split flags and approvals.** A pending approval leaves the inbox with its feature, and the handler holds one feature, so salary advances and comp-off claims got their own entity types (`salary_advance`, `overtime_comp_off`). Migration 040 relabels existing requests. Tables and screens stay shared; a row of the off kind answers 404.
**Reason:** the smallest change that lets each flag act alone.

## D32 — Web push on `node:crypto`, with a fixed payload
**Context:** `FEATURE_PUSH_NOTIFICATIONS` needs RFC 8291 encryption and RFC 8292 VAPID. Payloads must carry no L3 or L4 data.
**Options:** the `web-push` package; implement on `node:crypto`.
**Decision:** about 60 lines on `node:crypto`, checked against the RFC 8291 appendix A vector, a decrypt round trip and a signature check. The payload is built from the notification's kind alone (`pushPayload`), and the outbox stores only the kind, so a title with a name or an amount cannot reach it by mistake. Subscribe endpoints are client-supplied URLs the worker will call, so only the browsers' push service hosts are accepted, and redirects are refused.
**Reason:** `web-push` brings several transitive crypto packages to do what the platform already does. The fixed payload makes the rule structural instead of a review item.
**Not in the contract:** `VAPID_*` are new variable names. Without them the feature answers `feature_not_configured`.

## D33 — Off means not registered; one feature set per app
**Context:** the contract says a module that is off answers 404. Several apps are built in one test process, and the audit warned that a mutable global would leak between them.
**Options, set:** keep the global and re-set it in each test; pass the set through every call; carry it in `AsyncLocalStorage`.
**Decision:** the set belongs to `env.enabledFeatures`. `buildApp` registers from it and enters it for each request (`onRequest`, and again at `preValidation`, since reading the body leaves the async context). The worker enters it for its whole loop, the CLI for its run. There is no mutable global: code outside any scope sees the registry defaults, and tests call a job or service as an app would with `inApp(app, fn)`.
**Options, routes:** a preHandler answering 404; not registering. A preHandler would still run CORS, rate limits and `/:id` matching, and would differ from an unknown address.
**Decision:** modules are mounted conditionally in `app.ts`, and narrower features inside a plugin use `only(app, 'shifts').get(...)`. Both feed `app.featureRoutes`, what each route needs, which the generated test walks for every flag in both states. A hand-written prefix table in that test catches a route left out of its gate. An anonymous caller now gets 404, not 401: module state is deliberately not secret, since `/api/v1/config/public` publishes it.
**Shadowing:** a route that is off can resolve to a parametric sibling that is on (`/cases/committee` to `/cases/:id`, `/reports/saved` to `/reports/:key`). `/cases/:id` now only matches ids, and `/reports/:key` answers 404 before authentication for a report that is unavailable.
**Limits:** `/payslips/:id` is gated by `FEATURE_PAYSLIPS` too, so with payslips off a payroll manager reads pay through the run's items. Mail already queued when a module goes off is still delivered.
**Runtime setup:** a module that is on but unusable keeps its routes and answers 409 `feature_not_configured`; `gateFeatures` and `requireFeature` do that now.

## D34 — What `BRAND_DOMAIN` leaves open
**Context:** the contract makes `BRAND_DOMAIN` a bare hostname and removes `APP_URL`, but links in emails need a scheme, and dev runs on other ports.
**Decision:** https in production; elsewhere https unless `COOKIE_SECURE=false` or the host is this machine (`localhost`). So on a laptop behind `HTTP_PORT` an email link has no port. CORS allows exactly `https://BRAND_DOMAIN` in production; outside it, any port on that host, for the Vite dev server. `BRAND_EXTRA_DOMAINS` get no CORS: those hosts serve the app themselves, same-origin.
**Organization name:** `BRAND_LEGAL_NAME`, else `BRAND_NAME`, at bootstrap and on each start, as `ORGANIZATION_NAME` was.
**Layer 2 is required everywhere,** development and tests included: the contract marks those variables required, and a default would let a client go live as someone else.
**Brand assets and SSRF:** an https logo is a URL for the browser and mail client. Nothing on the server fetches it, and a test watches `fetch` to keep it so. `/brand/*` serves only images found on the fixed mount at startup.
**Old variables other than the three the contract names** (`APP_URL`, `ORGANIZATION_*`, and so on) are ignored, not refused, since the contract's merge order has the deployment repo move first and extra variables must stay harmless.

## D35 — Redis cache: invalidate by generation, after commit
**Context:** `REDIS_URL` is optional and must never change an answer. Settings are written inside transactions and read on every request, on several instances.
**Options:** delete keys on write; delete after commit; a generation counter per organization and namespace, part of every key, bumped after commit.
**Decision:** generations, with `afterCommit` added to the transaction helper. Deleting keys loses to a reader that loaded the old row just before the commit and stores it just after. With generations that reader writes under the old counter, where nobody looks. A transaction that wrote bypasses the cache for its own reads. Entries live 60 s, which bounds the one remaining gap: a process that dies between commit and bump, or a Redis unreachable for the bump.
**Failure:** commands time out at 250 ms and are not queued while disconnected, and any error means the database answers. A slow Redis costs at most that wait per lookup, and warnings are limited to one a minute without the URL.
**Scope:** settings rows and the `/org` lists; `evaluateFeatures` benefits through settings. Host resolution stays uncached, since a suspended organization must take effect at once. No personal data is cached.
**Dependency:** `ioredis`, for its timeouts and reconnection, which a hand-written client would have to reproduce.

## D36 — Management modes: one approval route, resolved at creation
**Context:** the contract has three modes and needs one `buildSteps` in place of eight inline blocks. Collapsing to a group step would lose delegation and escalation, and a requester who is the only holder would stick.
**Options:** a setting per module; collapse in each builder; `buildSteps` for the manager-first route plus a single collapse in `createApprovalRequest`.
**Decision:** the third, so requests with no manager step (payroll, profile, probation, recruitment) collapse too. `single`: a user step to the owner. `single_hr`: a group step on `approvals.hr_step`, unless HR raised it, it concerns an HR holder, or it moves money, and then a user step to the owner. User steps keep delegation and escalation. `approvals.hr_step` alone among group steps may be delegated by a holder and escalates to the owner. Reminders and `reassignStranded` already cover group steps.
**Self-approval:** `approval_requests.self_approver_id` names the one person who may decide their own, and each such decision writes `approval.self_approved`. Steps stay frozen at creation, so `hr_admin` and `hr_executive` keep the permission in `multi` for requests in flight.
**Roles:** stored assignments never change with the mode, and `resolveRolePermissions` decides what they mean. Custom roles stay stored and unused outside `multi`.
**Super-admin's permissions:** `tenant_admin` gains `employees.read`, `employees.bank.read`, `payroll.read`, `payroll.approve` and `loans.read`. This removes an earlier separation of duties, where the administrator could not read bank details. The product owner's rule says these salaries are visible to Super-admin, and it cannot be met otherwise.

## D37 — Audit chain: serialized by a row lock, taken at commit
**Context:** the requirement asks for per-tenant hashes set by a trigger under a serialized lock. The first version took a head row's lock in a `BEFORE INSERT` trigger and kept it until commit, and predicted two risks without measuring them.
**Measured** (`test/audit-chain-concurrency.test.ts`): two transactions taking the head and another row in opposite orders deadlocked, and Postgres aborted one with `40P01`, a 500 to the user. An approval (audit, then its effect) against an employee edit has that shape. Worse, one open transaction that had audited stopped every other audited write of the tenant, failed logins included, for as long as it stayed open.
**Options:** retry on `40P01`, which leaves the second problem and re-runs handlers; audit last everywhere, which review cannot hold; assign sequence numbers in a background job, which leaves a window with unchained rows; take the lock at commit.
**Decision:** a deferred constraint trigger (`046`). It runs inside `COMMIT`, in insert order, so the head is the last lock of any transaction and is held only while committing. Sequence order is still commit order, and a rollback leaves no gap. A row cannot be committed without its chain columns. The columns are nullable because the row exists before they are filled in, and the append-only guard allows exactly that one update, from the trigger, with nothing else changing.
**Cost, measured on one laptop with local Postgres 17:** 20 writers of one row each: 7,018 transactions per second, none failed, chain whole. A single reveal in one transaction: 100 rows 6 ms, 1,000 rows 71 ms, 5,000 rows 670 ms. Each row is written twice, an insert and an update. Not measured over a network or on production hardware.
**Bulk reveal** writes one row per subject in one statement. So do aggregates, since the requirement is whose record: a report, run total or journal writes a row for each person whose figure went into it (never one who was left out or whose group was withheld), each person once per request. A 1,000-person report writes 1,000 rows, measured above at about 70 ms of commit.

## D38 — Payment and filing files are whole or refused
**Context:** a preparer may be below someone in the run. A bank file without them pays short, and with them leaks.
**Options:** leave them out with a warning; include them masked; refuse; a two-part file; a higher-level approver's token.
**Decision:** refuse with 403 `requires_higher_level` and a count, and record `payroll.export_refused`. Someone above everyone in the file produces it. Bank, bank-released, PF, ESI, the reimbursement bank file and the journal follow this rule, because a filing or a journal that leaves people out is wrong in the same way. The salary register may be partial, because it pays nobody: it leaves people out and says how many in `x-excluded-subjects`.
**Consequence:** someone must sit above everyone. Bootstrap makes the first administrator the Owner in every mode, and `044` does so for existing installations. Without that, two `tenant_admin`s at level 90 who are both on the payroll could never get a bank file.
**Not gated:** approving a run. An approver below someone sees the register without them and `excluded` beside it.

## D39 — Masked by default, with named need-to-know limits
**Decision:** every L4 field is masked until `?reveal=1`, aggregates included, since a group of one is a salary. Exports count as a reveal and are audited per subject. A masked answer writes no audit row, because it carries no L4.
**A manager on a loan's approval chain** sees that the request exists and not the amount, unless `security.manager_team_salaries` is on and they are above the subject. So by default a manager approves a loan without its figure, and finance sees it at the next step. This follows the rule as written. The product owner may want to revisit it.
**Leave, overtime and field-duty reasons:** L3 says self and HR, but a manager cannot decide a request without the reason. A manager reads it in their team list while the request is pending, and not after. On overtime and field duty, whoever holds a step of the pending request reads it too, a delegate included, and whoever recorded field duty for someone else keeps what they wrote. `overtime.read` alone (payroll, auditor) gets the request with the reason masked.
**PAN and Aadhaar:** reveal shows the last four characters. PAN is never decrypted by the API.

## D40 — Role grants count as setting a level
**Context:** the first version let an administrator appoint another `tenant_admin` at the same level. That breaks a hard requirement: no one can set someone else's level equal to or above their own.
**Decision:** a role change that raises someone's effective level to the actor's own or above is refused, for everyone. It is computed on the effective level, not the role's floor, because a change can also lift a ceiling off a high stored level, and a removal can too. Only someone strictly above appoints an administrator, and nobody in the app appoints an owner. Nobody changes the roles or status of someone at or above them, or clears their MFA.
**Lockout:** the owner sits above `tenant_admin`, and `044` and bootstrap make sure one exists. The last active owner cannot lose the role or be disabled, by a person or by `endAccess`, which refuses and writes `user.end_access_refused_last_owner`. The bootstrap command is the only path outside the rule: `bootstrap --reset-admin --admin-email X` recovers an account and makes it an owner when no other active owner exists, and `--make-owner` hands ownership over.
**Consequence:** a second `tenant_admin` needs the Owner. A separated last owner keeps a working login until the operator hands over, which the audit row surfaces.

## D41 — Encryption shape and aggregates
**Decision:** one sealed blob per payroll item (`data_enc`), not one column per amount: a single decrypt per item, and the fields always change together. Numbers stay numbers inside; the API still gives strings with two decimals.
**Aggregates:** the audit listed five to move to Node. Items 1, 2 and 5 had to move. Items 3 and 4 (loan balances) did not, since loans stay plaintext, and they were moved anyway as asked. A sixth, `net >= 0` in the release route and the guard trigger, was missing from the audit's list and moved too.
**Row caps:** "with the existing row caps" cannot apply to input. 12,000 items would be cut at 5,000 and totals understated without any warning. Input is paged in full, and the cap applies to what is shown.
**Small groups:** the sums only ever contain people the viewer can see, so one viewer's answers cannot be subtracted to find someone hidden. The risk left is a group total known from elsewhere, so a group with someone hidden and fewer than 3 visible has its amounts withheld. Comparing answers between two viewers with different levels is not addressed.

## D42 — Finance checks when approvals collapse
**Context:** the audit warned that collapsing removes the finance step, the only separation of duties on expenses, loans and advances.
**Decision:** `single`: there is no second person, so the owner decides and it is on the audit log. `single_hr`: expenses, loans, advances, travel with a finance step, overtime pay, bank changes, salary changes, payroll and recruitment go to the owner, not to HR. Comp-off, leave, regularization, field duty, separation and profile changes go to HR or the owner.

## D43 — Payroll and auditors read payroll categories, not all documents
**Context:** `payroll_manager` and `auditor` held `documents.read`, so they could read every non-restricted employee document, beyond "self and HR" for L3.
**Options:** remove access entirely; a fixed list of category codes; a flag on the category.
**Decision:** a new `documents.payroll` replaces `documents.read` for those two roles, and reads employee documents in categories marked `payroll_related`, with the same level check, never restricted ones. Categories are organization data, so HR marks them (`payrollRelated` on the category). Company documents stay as they were: `employee_visible` decides.
**Consequence:** no existing category is marked, so payroll staff and auditors lose document access until HR marks the right ones, such as tax proofs. An audit that needs other files asks HR. Custom roles holding `documents.read` keep it, because the organization chose that.

## D44 — Back-off by who is failing, not a lock on the account
**Context:** the audit noted that any known email could be locked out: five failures, fifteen minutes, from anywhere, for free. The per-account rate limit had the same shape: ten requests a minute from one address kept the owner out, before any password was checked.
**Options:** keep the lock and add a CAPTCHA, which needs a third party; lock per address only, which leaves distributed guessing; count by pair, address and account, with a known-browser exemption.
**Decision:** three counters in the database (`auth_throttle`), so instances share them. Account from one address: the setting `security.max_failed_logins`, default 5. One address across accounts: 50. Account from everywhere: 30, and this one does not stop a browser that has already signed in to this account (`hrms_did`, a random cookie, hashed in `user_devices`). Back-off doubles from 30 seconds to 15 minutes, and counters are forgotten after 30 quiet minutes. A blocked attempt is refused before any password work and with 429, and keys are hashes of what was typed, so a refusal says nothing about whether the account exists. An address already backing off no longer spends the per-account rate limit. A right password clears only its own pair.
**Limits:** someone with many addresses can still make a new browser wait, up to 15 minutes at a time, by spending 30 guesses per window against the account; a known browser is unaffected. A shared office address backs off if 50 sign-ins fail within its window. The per-account rate limit in `AUTH_ACCOUNT_RATE_LIMIT_PER_MINUTE` is still per process (D27), though these counters are not. Not tested behind a live proxy. `users.failed_logins` and `locked_until` are unused and stay for a rollback; batch E can drop them.

## D46 — Sessions: idle limit on the row, tokens rotate
**Decision:** `security.session_idle_minutes` (default 30, 5 to 480) is copied to the session at sign-in, so `loadSession` needs no extra read per request and a change applies to new sign-ins. Activity is written at most once a minute. The absolute limit stays `min(security.session_ttl_hours, SESSION_TTL_HOURS)` and activity never moves it. Signing in always makes a new session and revokes the one the browser presented. A password change and the MFA events below rotate the token of the current session and end the others, and answer with the new CSRF token. A role or salary level change ends all the person's sessions, as role changes already did: that is simpler than rotating someone else's token, which they could not receive.
**Limit:** a screen that polls keeps a session from going idle, since the server cannot tell a poll from a person. The cookie stays `SameSite=Lax`: `Strict` would make a link from an email open signed out. CSRF is still the token.

## D45 — MFA is optional unless the deployment requires it; this relaxes the audit's F-11
**Context:** F-11 found that the "privileged" level left out roles that read salaries, and the plan was to require MFA on an explicit L4 list. The owner has since specified something else: MFA off, optional per user, or required for everyone, set at deployment and by nothing else.
**Decision:** `MFA_AVAILABLE=false`: routes not mounted (404), no challenge, no prompt, overriding anything stored, and enrolment is kept for if it returns. `MFA_AVAILABLE=true` with `MFA_ENFORCED=false`: each user chooses. `MFA_ENFORCED=true`: everyone enrols at next sign-in and cannot turn it off. The `privileged` level, `security.mfa_enforcement` and the `mfaRequired` and `privileged` fields in role listings are gone, and `044`'s row in settings is deleted by `047`. `/auth/me` carries `mfa.suggested` for people holding an L4 permission who have not enrolled; it blocks nothing.
**Residual risk, accepted by the owner's specification and worth saying plainly:** with `MFA_ENFORCED=false`, which is the contract's production default, **people who can read salaries, bank details, PAN and Aadhaar are not required to enrol.** That includes Owner, Super-admin, HR, payroll and finance. One phished password then opens L4 data for everyone below that person, and this is what F-11 was raised to prevent. Controls that remain: strong passwords with the breached list, back-off, new-device email, masking with an audit row for each reveal. An installation that holds this data and wants the protection sets `MFA_ENFORCED=true`, with no code change.
**Email codes:** six digits, ten minutes, single use, five guesses per code, one send a minute and five an hour per user, hashed with a key from the data key (`mac`), since plain SHA-256 of six digits falls in moments to anyone with a database copy. Rotating the data key ends codes in flight, which is harmless. The worker delivers mail every 5 seconds as well as on each pass, because a pass can run long jobs and a code has minutes to live.
**Across sessions:** ten wrong codes stop the second factor answering for 15 minutes, right code included, because the audit noted that signing in again reset the count. Reaching it needs the password, so it cannot be turned on a stranger.
**No SMTP:** enrolment says so (`GET /auth/mfa/methods`, `usable: false`) and refuses. Someone already enrolled in email codes gets `mfaDelivery: 'unavailable'` and uses a recovery code, or an administrator resets them. It does not fall back to no second factor. Enforcing with email as the only method and no SMTP is refused at startup, since nobody could enrol. As the contract says, `FEATURE_EMAIL_NOTIFICATIONS=false` means no transport at all, so it turns off these codes, reset links and security email too.
**Removed method:** enrolment in a method no longer in `MFA_METHODS` does not count until it returns. Under `MFA_ENFORCED=true` that person enrols again.

## D47 — Links: one table, secrets out of the outbox, no initial passwords
**Context:** the audit found no password reset and no invitation, and suggested reusing `admin_setup_tokens`. Mail goes through an outbox table that a database reader can see, and reset links and codes are credentials.
**Decision:** `admin_setup_tokens` gains `purpose` (`setup`, `invite`, `reset`), and the app role may now insert. Reset lasts 30 minutes and an invitation 72 hours, since a new starter may not read mail for a weekend. A link and a code are never stored readable: the body holds a placeholder, `email_outbox.secret_enc` holds the sealed value, opened only to send and cleared after, and a mail past its `expires_at` is not sent. Taking a link is one `UPDATE`, so of two people presenting it exactly one wins, and hashing the new password holds no transaction open. A refused new password does not use up the link.
**Admin-chosen passwords are gone:** `POST /tenant/users` sends an invitation, and refuses `initialPassword` with 400 rather than ignoring it, so nobody believes they set a password that does nothing. `must_change_password` stays for bootstrap's password mode.
**No enumeration:** `POST /auth/password/forgot` holds its answer to 250 ms whatever happened. That covers queueing the mail, and a request that takes longer shows only that the database was slow.
**Without SMTP:** a new user is still created, answering `inviteSent: false`, and `hrms bootstrap --issue-link` prints a link for the operator. Refusing to create the user would block linking employees on an installation that chose not to have mail. A reset by email cannot work there, and the public config says so.

## D48 — Uploads: fail closed in production, including modules beyond documents
**Context:** the contract requires ClamAV in production when `FEATURE_DOCUMENTS` is on. Expense receipts, selfies, policy files and resumes are uploads too, and they can be on with documents off.
**Decision:** every upload goes through `prepareUpload`, and a test fails if a module stores a file without it. Startup refuses per the contract. At upload, production with no scanner, or a scanner that fails, refuses with 503 whichever module it is. So a production installation with documents off and receipts on must run clamd or receipts stop, with a clear error. Not storing an unscanned file was preferred over a silent gap.
**Order:** magic bytes first, so a file of a type we would refuse never reaches clamd, then clamd on the bytes as they arrived, then stripping. EICAR as a plain text file therefore answers 415; inside an allowed type it answers 422.
**Stripping** walks each format's structure with no image library, and refuses what does not parse, since we could not say what is left in it. Orientation is the one Exif value kept, because without it a phone photo comes out sideways.
**Not verified against a real clamd:** the tests use a fake server that speaks INSTREAM frame by frame. No real signature database was run.

## D49 — Reversible migrations: sidecar files, one pair that cannot be split, a cycle at global setup
**Context:** migrations were forward-only and checksummed, so down sections cannot go in the numbered files. Some steps drop data, and `043` needs the key. A rollback that stops half way through pay data is worse than none.
**Files:** `migrations/down/<same name>.sql`, a directory `readdir` and both `.sql` filters do not see. Not `*.down.sql`, which those filters would run as forward migrations. Down files are not checksummed: they run only when asked, and changing one to fix a rollback should be possible.
**The 044 and 043 pair.** The test requires the schema after down `044` to equal the schema before up `044`, and that has `amounts` and others `NOT NULL`, on tables with rows, before the key can supply values. Options: add them nullable and let `043` tighten them, which makes the state between the steps differ from what was there; or add them `NOT NULL` with placeholders, which keeps the schema exact and makes that state unsafe to serve. **Decision:** placeholders, with `rollsBackWith` on the code step: rollback refuses to stop between the two, and checks the key against each sealed column before its first change. Going up from that state is safe, since the sealed values are still there. A run interrupted between them is finished by asking again.
**Rows the old checks refuse:** rewritten, not deleted, so balances still add up and history stays: `carry_out` to `adjustment`, `queued` to `failed`, `on_duty` to `present`, `on_leave` to `absent`. **Rows the old release would misread:** sealed mail is marked failed, reset links are spent, and email-MFA enrolment is cleared. That last one lowers protection for those people until they enrol again; the alternative was locking them out of an older build that knows only TOTP.
**Extensions:** dropped only if the running role owns them, because `IF NOT EXISTS` may have found one a superuser created.
**No transaction:** `-- hrms:no-transaction` as an exact first line, not a name pattern, so the file itself says so. Statements are split by the runner, since several in one simple query are one implicit transaction. A failed `CREATE INDEX CONCURRENTLY` leaves an invalid index that `IF NOT EXISTS` would accept, so the runner checks for invalid indexes after such a file, and refuses to record it.
**Where the test runs:** `hrms_owner` has no CREATEDB in the official environment, all three databases are shared, and the CI workflow is in the deployment repository. So the destructive cycle runs on `hrms_test_single_b` in `test/global-setup.ts`, before any test file and before that database's normal reset, writes its record to a temporary file, and `test/migrations-reversible.test.ts` asserts on it. A failed cycle fails that file and not the other files. It costs a few seconds on every run, including a run of one file.
**Column order** is not compared: a re-added column is at the end of its table, and only rebuilding the table would change that. Nothing depends on it. Everything else in the catalogue is.
**Limit:** `down` restores what the previous schema could hold. Scrubbed text, dropped SMS data and deleted snapshots cannot return, and `README.md` lists them. Not run against a production-sized database, or through a built image.

## D50 — RFC 7807: type as a URN, instance as the request id, details as extension members

**Context.** The frontend reads `application/problem+json` and extension members such as `duplicates` at the top level. RFC 7807 wants URIs for `type` and `instance`.

**Options.** `type`: `about:blank`, a URL on a domain, or a URN. `instance`: the request path, or the request id.

**Decision.** `type` is `urn:hrms:problem:<code>`. `instance` is `urn:uuid:<request id>`. An object in `AppError.details` becomes extension members, which cannot overwrite a standard member. `errors` is always present.

**Reason.** There is no domain common to every installation to publish a type page at. The request id is what the logs carry, so a user's reference finds the line, and it holds nothing from the address. Framework 4xx messages are replaced by fixed text because `JSON.parse` messages quote the body. Constraint names left the answers: they named the schema and nothing used them. No compatibility shape, because the frontend had already switched.

## D51 — OpenAPI: route schemas are documentation; the handler still parses

**Context.** Fastify validates before the handler, and permissions are checked inside handlers. Real validation in `schema` would answer 400 where today an unauthenticated caller gets 401 and an unauthorized one 403. Moving auth to a hook on 330 routes is a larger, riskier change.

**Options.** Move auth to `preValidation`; `fastify-type-provider-zod`; or a pass-through validator and the same zod object in `schema` and in the handler's `.parse`.

**Decision.** The last. `setValidatorCompiler` passes data through. Each inline schema was hoisted by a codemod, keeping validation where it was. `setSerializerCompiler` is plain `JSON.stringify`, so a response schema can never remove a field. `z.toJSONSchema` (zod 4, `io: 'input'`, unrepresentable as any) makes the document, in a small transform, with `@fastify/swagger` as a dev dependency, loaded only by `npm run openapi`. The API does not serve the document: CI publishes it as an artifact.

**Reason.** Refusal order and strictness stay exactly as they were, and a test checks 401, 403, 400 in that order. Refinements, such as "email or phone", have no JSON Schema form and appear only as the plain field rules. Off-flag routes are in the document with `x-feature`, built with every switch on, so one file describes the product. `x-feature` holds groups: every group needs one variable on. `x-permissions-conditional` is read from the handler's `a.has(...)` calls, and means holding it changes what the route does.

