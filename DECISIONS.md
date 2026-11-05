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

## D52 — Documents: pdfkit, streamed, drawn in the API, standard fonts

**Context.** Payslips, letters and report exports had no file form. Pay data must not leave without the L4 rule and an audit row, and a report of up to `MAX_ROWS` rows must not hold the event loop. Nothing may be fetched from outside: a logo is a file in the mount or nothing.

**Library.** pdfkit 0.20.2: MIT, as are its dependencies (fontkit, png-js, linebreak, fflate, @noble/hashes, @noble/ciphers), with releases through 2026 and four maintainers. Rendering through a headless browser would put a browser in the image, a far larger surface. Other libraries were not surveyed. Tests read the files back with `pdfjs-dist` (Apache-2.0, a dev dependency, declares Node 22.13 or 24 and above; run here on Node 26 only). In the image: about 20 MB of `node_modules`, and about 40 ms to load.

**What is heavy, and where it runs.** Nothing goes to the worker. Options: a job that writes a file for later download; `worker_threads`; or drawing on the API's loop and yielding. Numbers, from `scripts/perf-report-pdf.ts`, one laptop, no concurrent load, Node 26, 5,000 rows by 15 columns = 75,000 cells, three runs each:

| | Whole file | Longest stall of the loop |
|---|---|---|
| Yielding every 8 ms of drawing | 830 to 940 ms | 13 to 18 ms |
| Not yielding | 830 ms | 830 ms |

So drawing the largest report allowed costs under a second of CPU, and yielding brings the stall down to the length of one page's compression and one slice, for no measurable cost in total time. `worker_threads` would have to copy every row to the thread, and it would add a pool to run and a failure mode to handle, to solve a problem that measurement says is gone. A job would add storage and a second place holding decrypted pay. Decision: **report PDFs yield to the loop (`setImmediate` every 8 ms); no worker thread, no job.** Not measured under concurrent load, or on production hardware: if requests queue behind reports in practice, the rate limit for exports is the first thing to look at.

**Streaming, honestly.** A report is really streamed: pdfkit writes a page out when the next begins, the first page is drawn before the answer starts so a mistake there is still an ordinary error answer, drawing stops if the client goes away, and it waits while more than 256 KB is unread. It does not reduce memory much, as all the rows are in memory already: the report service builds them whole. A failure after the first page breaks the download, since headers have gone, and is logged. A payslip or letter is one page, drawn whole in a few milliseconds and then read out of the stream: that is buffering for that moment, kept deliberately, because a problem then is still a clean error. The audit row commits before any byte leaves, and no database connection is held while drawing.

**Fonts and currency.** The standard PDF fonts: no font file in the image, and nothing to license. They hold Windows-1252, which has no rupee sign, so **amounts print with the ISO code** (`INR 68,200.00`), with grouping from `BRAND_LOCALE`. Embedding an open font such as Noto Sans (OFL) would give the sign, but would not solve the next point, so a font file was not worth carrying for one glyph.

**Names outside Latin.** A name in Devanagari, Arabic or Chinese cannot be drawn. Covering them means a font per script, chosen per name, with pdfkit's shaping for those scripts untested here. Instead: accents that have no glyph come off (`ā` to `a`), anything else becomes `?`, the employee code is always printed beside it, and the document ends with a note saying characters could not be printed. It does not crash, and it does not silently look right. **This is a real limit**: an organization whose employees' names are stored only in such a script gets poor letters, and would need a font added.

**Images.** Logo: `/brand/<file>` from the mount, PNG or JPEG. An SVG cannot be drawn, and an `https://` logo is never fetched (the server never fetches a brand asset), so both print as the brand's name. The brand's name is always in the footer. Signature and stamp come through the blob store. An image that cannot be read is left out: a document does not fail for its stamp. PNGs are checked before they reach pdfkit, because it inflates PNGs with alpha in a callback that throws where no caller can catch it, which would end the process.

**Payslip.** One rule in one function with the JSON route, so they cannot drift: a held payslip or a run not final is 404 for the employee, and staff who may read this person's pay can open it. Unlike the JSON view it says so on the page, `ON HOLD` or `NOT FINAL`, so that a printout cannot pass for a payslip. A file always shows the figures, so it is always audited, `l4.export` with one row, as well as `payroll.payslip_viewed` when it is your own. Employer contributions are left off, as they are not the employee's pay.

**Letters.** Under `/lifecycle/employees/:id/letters/`, since they belong to joining and leaving. HR with `employees.manage` strictly above the person, and never their own by this path. The person may fetch their own experience and relieving letters. An experience letter is available from the last working day of an approved separation. A relieving letter says clearance is done, so it needs a completed separation, and does not exist for a death or an absconding. Refused for state: 409. Out of reach: 404. **In practice** completing a separation disables the login, and the daily job does so after the last working day, so a person can fetch their own experience letter on their last day, and their relieving letter hardly ever: there is no portal for former employees, and HR hands it over. The reason for leaving (L3) is never printed. Salary prints on an appointment letter only for `?includePay=1`, with a pay permission, above the person, and payroll in use; it is then `l4.export`. Otherwise the letter comes without it, and `x-pay-included: 0` says so. The wording is deliberately plain and factual: the terms belong to the organization's contract, and there is no template editor.

**Reports.** One line per row on landscape A4, so rows and pages are known in advance. A number is never cut, which would make it a different number; it is drawn smaller. Text is cut, with a note at the end, and the CSV and Excel have it whole. The header repeats on every page. Column widths come from the first 200 rows.

**File names** are `payslip-<yyyy-mm>.pdf`, `appointment-letter.pdf` and `<report>-<date>.pdf`: no name, no figure, no identifier, and neither do the URLs or the document's title.

## D53 — Company details: a table of their own, not settings

**Context.** Layer 3 lists GSTIN, PAN, TAN, CIN, address, PF, ESI and PT numbers, payroll bank details, signatory, signature and stamp. Only `legal_entities` had any of it.

**Options.** Settings registry entries in a `company` group, through `PUT /tenant/settings/:key`; or a table and a route.

**Decision.** `company_profile`, one row per organization, with `GET` and `PUT /tenant/company` and `/tenant/company/images/:kind`, under a new permission `company.manage` (Super-admin, Owner, Finance). PAN and the bank account number are sealed. PAN comes back as its last four, always. The bank account comes back as its last four, or whole with `?reveal=1` for `company.manage`, audited, as an employee's does. Holder, bank name and IFSC are L4 and audited by name, like an employee's. Other fields are audited old to new. Legal entities stay the fallback for name, GSTIN and CIN.

**Reason.** `tenant_settings.setting_value` is L1 JSON read by anyone with `settings.read`, and `rotate-keys` rewrites columns, not keys inside JSON. A sealed setting would have needed masking and rotation added to the settings path, for two fields, beside a generic audit that writes old and new. The table gets classification, rotation and masking from what exists.

**Known limit.** The middle of a GSTIN is the PAN, and a GSTIN is public. Where one is set, sealing the PAN hides little, and old-to-new audit of the GSTIN holds it. The PAN is sealed anyway: an organization may have none, and the classification rule makes no exception.

**Off.** PF, ESI, PT and bank fields belong to payroll: with it off they are left out of answers, refused on write, and kept. `loadCompanyProfile` holds the whole PAN for the server's own documents only.

## D54 — Grades and designations: text on the employee, a master beside it

**Context.** `employees.designation` and `grade` are free text, used by imports, hiring, reports and allowance rates.

**Options.** A foreign key from employees to a master; or keep the text and validate.

**Decision.** Keep the text. `grades` and `designations` are masters under `org.manage`, seeded by migration 050 from distinct values in use. With no entries, anything goes. With entries, `POST` and `PATCH /employees` need an active entry, matched by code or name in any case, but only for a value being changed. What someone already holds stays valid. An import adds a new title to the master, warns in its report and audits it, and does not fail. Hiring keeps its offer's text.

**Reason.** A foreign key would touch every query that reads those columns and change the API, for the same result on screen. `allowance_rates.grade` matches the text too. The cost is that renaming a master entry does not rename what people already hold.

## D55 — Erasure: a two-person rule of its own, and rows that stay as nobody's

**Context.** DPDP erasure has to be authorised, and much of what a person leaves behind must by law stay.

**Options.** The approval engine; or a request table with its own rule. For retained rows: keep the name on them until the period ends; or anonymize at once and seal the identity aside.

**Decision.** `erasure_requests` with its own rule: whoever raised it cannot carry it out, except an Owner in the smaller modes, audited. Employee data is anonymized at once. Carve-out rows stay, without a name on them, with the identity sealed on the request until the payroll period ends. Then statutory and bank details and remaining files go, the code is replaced, and figures stay as nobody's.

**Reason.** The engine's handlers apply a decision on approval and route by requester and manager. Here the requester may be gone, a person may have no manager or account, and the executor needs an answer with a report. The rule took a few lines. Deleting payroll items was ruled out: a finalized run is immutable (the `payroll_guard_finalized` trigger), and its sealed totals must keep adding up.

**Periods** are settings in financial years: payroll 8, attendance 5, disputes 3. See `docs/DATA_RIGHTS.md`, which says they are not legal advice.

## D56 — Retention: DELETE returned to the runtime role for rows that have an end

**Context.** Migrations 007, 008, 009 and 034 revoked DELETE on `job_runs`, `notifications`, `email_outbox`, `documents` and `employee_bank_changes`, with no job to use anything else. Audit section 5 called these unbounded.

**Options.** A `SECURITY DEFINER` purge function per table; or grant DELETE, with RLS still limiting it to the tenant.

**Decision.** Grant DELETE on those five, and column-level UPDATE on `attendance_events` (latitude, longitude) and `case_events` (text_enc). `audit_logs` keeps its triggers and its refusals. Migration 009's comment said retention policy would decide: this is that.

**Reason.** Functions would be a second way of writing the rules that the service and tests already hold, for a role that already has DELETE on most personal tables. Rows can go by app bug where they could not before. Punches stay protected, except for the two columns.

## D57 — `/metrics` needs a token, on the main port

**Context.** Metrics should need no login, yet not be public. `hrms-deployment`'s ingress does not route `/metrics`, and the Compose Caddyfile does not either, but a routing rule is one edit away from exposing it.

**Options.** A second listener bound to an internal address; an unauthenticated route relying on routing; a bearer token.

**Decision.** `METRICS_TOKEN`. Unset, the route does not exist. Set, it answers Prometheus text to `Authorization: Bearer <token>` and 404 to anyone else. No client library: counters and histograms by route pattern are about 60 lines, and labels hold patterns and methods only. The worker has no HTTP listener and exposes no metrics.

**Reason.** One port keeps the deployment unchanged, and a mistake in routing then exposes a 404. A scraper needs one secret, which Kubernetes and Prometheus handle natively.

## D58 — OpenTelemetry without an SDK

**Context.** Tracing should be possible, with no heavy default dependencies. The Node SDK with auto-instrumentation adds tens of packages to every image.

**Decision.** With `OTEL_EXPORTER_OTLP_ENDPOINT`, `src/core/telemetry.ts` sends one span per request as OTLP/HTTP JSON using `fetch`, following an incoming `traceparent`. Attributes are method, route pattern and status. Spans are dropped when the collector is away. Unset, nothing is created.

**Reason.** It answers "which route, how long, which trace" at no cost to anyone not using it. It is not full instrumentation: database calls have no spans. Someone who needs those can load the SDK with `NODE_OPTIONS=--import` in their own image.

## D59 — Response schemas are generated once, then checked by every test

**Context.** Responses are raw SQL rows, so a hand-written schema is a guess, and a wrong one is worse than none.

**Decision.** Generated from what the whole test suite saw for L4 paths, sign-in, public config and core self-service, then committed to `src/core/http/responses.ts` as strict objects. Every test app has `verifyResponses` on: an answer its schema does not describe becomes a 500 and fails that test. They are never used to remove a field.

**Reason.** The check holds for the paths tests reach, and only those: a branch no test takes is not proved. A field only ever seen as null is `unknown`. Remaining routes have no response schema, and `npm run openapi` prints the count.

## D60 — Performance: memo per request, a replica for reports only, lists with generous defaults

**Context.** Audit section 5: 20 to 30 statements before business logic, N+1 reads in payroll, lists without limits or with silent caps.

**Decision.**
- **Memo.** Settings and feature state are remembered per request, and per job run, through `AsyncLocalStorage` (`core/memo.ts`). `writeSetting` and `clearSetting` clear it. No TTL cache: another instance's write is seen by its next request.
- **Payroll.** `computeRun` reads salaries, attendance, adjustments and who has loans or overtime once per run. Per person stay the item's `INSERT`, and the locked loan and overtime work for people who have any. Bank, PF and ESI files read their accounts in one query, and `closeRepaid` is one statement.
- **Lists.** The lists the audit named answer `page`, `pageSize`, `total`, with a default of 100 or 200 and a cap of 500. A default large enough for today's screens means they keep working unchanged, and `total` shows when more exist.
- **Replica.** `DB_READ_HOST` serves report runs and report exports only, in `READ ONLY` transactions with the tenant set. An unreachable replica falls back to the primary, checked per read with one connection attempt. Nothing that could be a read-after-write goes there.
- **Workbooks.** `xlsxAsync` compresses on the thread pool, one part at a time. Building the XML stays on the event loop.

**Left as is, with the reason.** `attendance.close_day` and `POST /attendance/recalculate` still run `recalculateRange` per employee, about 8 statements each after the memo: batching means rewriting the engine's data access, for a nightly job. Employee import stays 2 to 4 statements per row. Reports stay capped at `MAX_ROWS` with `truncated`, rather than paged: a page of a grouped report is not meaningful. Uploads stay buffered, with SHA-256 on the event loop, limited by `STORAGE_MAX_FILE_MB`.

**Not tested.** Real replication lag: the test's replica is a second connection to the same database. The indexes come from query shapes, and were not checked with `EXPLAIN` on production-sized data.

## D61 — ESLint and Prettier in `tools/lint`; no hook manager; a Prettier width of 180

**Context.** `typescript-eslint` needs the TypeScript compiler's JavaScript API, and only up to 6.0. The app builds with TypeScript 7, whose package has none, and Stryker hits the same wall.

**Options.** Downgrade the app's compiler; npm overrides for a nested peer; a small package of its own for the tools.

**Decision.** `tools/lint` has its own `package.json` and lockfile with TypeScript 5.9, ESLint and Prettier. `npm run lint` installs it on first use. Stryker is pointed at a tsconfig path that does not exist, which skips the rewrite it would otherwise fail on. `.githooks/pre-commit` with `core.hooksPath`, set by the `prepare` script, needs no extra dependency. Prettier's `printWidth` is 180 because the code was written long; a width of 80 would change every line for no reader's benefit.

**Reason.** The type information ESLint sees comes from another compiler version than the build, which matters only for rules that read types: `no-floating-promises` and `no-misused-promises`. `tsc` remains the check that the code compiles. Moving to `typescript-eslint` proper is possible once it supports TypeScript 7.


## D62 — Writes on a person follow the same hierarchy as reads

**Context.** D40 said nobody changes someone at or above them, and the rule was enforced on role and salary routes. The abuse suite found other write paths with no level check at all: employee status and manager, separations, loans, documents (QA_REPORT batch F).

**Options.** A rule per module; one helper; only the audit log and a human review.

**Decision.** `assertOutranks` in `core/policy/salary.ts` answers the same 404 as a read, for anything that ends access, moves approvals or changes money. `assertMayChangeSubject` now does what its comment always said: never your own, through a staff route. In `single` and `single_hr` the owner is the exception, since nobody sits above them. Other edits to someone above you, such as their department or designation, stay allowed: they neither end access nor move an approval, and HR needs them.

**Reason.** Status and reporting manager are the two employee fields with power over someone. The rule belongs in one place, because a module of its own is how the gaps appeared.

## D63 — A login on a record goes to the address on the record, or to someone who can vouch

**Context.** `POST /tenant/users` with `employeeId` lets a `users.manage` holder attach a login to a record that has none. The record's pay and bank details are then read as "self", which passes every level check.

**Options.** Refuse linking for anyone without `employees.manage`, which breaks IT onboarding; require a second person; compare the address.

**Decision.** The login's email must equal the record's `work_email`, or the actor holds `employees.manage` or is an administrator, and outranks the person.

**Reason.** The invitation goes to the login's address, so the person the record names receives it. IT keeps its onboarding. Changing a record's work email is itself HR's, so taking a record over now takes two people.

## D64 — `no-store` on the API by default

**Context.** Files were `no-store`. JSON, including revealed salaries, had no `Cache-Control`.

**Decision.** Every `/api/` answer gets `Cache-Control: no-store` unless its route set one. Public config keeps `no-cache`.

**Reason.** Almost everything here is personal, so the safe default costs little: the app has no HTTP caching to lose.

## D65 — CI: reusable workflows stay, pinned, with the scans beside them

**Context.** CI, image build, Trivy, SBOM, cosign and the dispatch to the deployment repository already exist as reusable workflows in `hrms-deployment`. The brief asks for all of it in this repository's `.github/workflows`, with SHAs pinned, GHCR multi-arch and a GitOps PR.

**Options.** Copy everything here and drop the reusable workflows; keep them and add what is missing.

**Decision.** Keep them, called at a pinned commit. Add `security.yml` here (Semgrep, CodeQL, Trivy on the repository, SBOM, ZAP baseline, nightly full ZAP). `publish-develop.yml` passes both platforms, so develop images match releases. The GitOps step is the existing `repository_dispatch`: `deploy-dev` commits the version, `release-prod` opens the version PR, both in the deployment repository.

**Conflicts found.** Three: the reusable default of Node 22 cannot pass the suite, which needs `crypto.argon2`, so callers now pass 24. `@main` was not a pin. And `openapi.json` was git-ignored while the frontend generates from it, so it is now committed and CI fails on a difference.

**Reason.** Copying would give two copies of the publish logic for backend and frontend to drift apart. No long-lived cloud key exists: signing uses the OIDC token, GHCR the job token. Cross-repository dispatch still needs a GitHub App key or a PAT, which is not a cloud key. Dependabot stays; a second bot would only add noise.

## D66 — Load tests use ready sessions, on their own database

**Context.** 1000 virtual users signing in at once measure 1000 Argon2 hashes, on purpose slow, and not the API.

**Decision.** `load/seed.ts` writes a session per person directly. `mixed.js` adds a small steady rate of real sign-ins as its own scenario. It refuses any database not named `hrms_load`.

**Reason.** Numbers about the API, with sign-in reported on its own. Think time of 1 to 3 seconds per user, so 1000 users is about 500 requests a second, which is what 1000 people at work would be at their busiest and well beyond what one customer of this product has.

## D67 — Response schemas for every JSON route, from what the suite saw and where each value came from

**Context.** D59 covered 76 of 385 routes, so the frontend wrote types by hand for the rest. Its generator had two weaknesses: a field only ever seen as null was `unknown`, and a nullable column that tests happened to fill looked as if it could never be null.

**Options.** Write them by hand from the SQL, which D59 already rejected as guessing; run D59's generator again; record more.

**Decision.** Record more. The whole suite ran with a recorder that kept, per route and status, the shape of each answer and, by the result metadata of `pg`, which table column each value came from, matched on name and value. A value from a nullable column is nullable although no test saw it null. A field seen only as null takes its column's type. A value from a JSON column is a loose object, since the column can hold more than was seen. What the old document said stays: its fields, its optional and its nullable. `test/contract/remaining-routes.test.ts` takes the 40 odd routes no suite reached to a 2xx, so nothing is described from the code alone. A test now fails on any route without a response. Files are declared with `R.file(...)` where the path does not end in an extension. The recorder was a throwaway, as the last generator was; `registerResponseCheck` is what keeps these true.

**Reason.** The check holds for the paths tests reach, and only those: D59's limit stands. A column of an outer join can be null with `NOT NULL` on the column, and a value built in code has no column, so a branch no test takes can still answer null where the schema says otherwise. Over-declaring nullable costs the frontend a check; under-declaring costs a crash, so widening is the right way to err.

## D68 — `AUTH_RATE_LIMIT_PER_MINUTE` defaults to 300

**Context.** It was 20 per address, and F-128 kept sign-in per address. An office behind one NAT with 100 people arriving at nine is refused from the 21st on, each person for up to a minute, and the refusal looks like the system being down.

**What each guard does.** The limit counts every attempt, right or wrong, in the memory of one process. The back-off of D44 counts only failures, in the database: 50 from an address, 30 on an account from anywhere, and `security.max_failed_logins` for the pair, then blocks with waits doubling from 30 seconds to 15 minutes, before any password work. The counter forgets after 30 quiet minutes, so the patient attacker's budget is 49 guesses, a wait, and 49 more: about 2,300 a day per address, across all accounts. That number does not depend on this limit as long as it is above 2 a minute: at 20 the 49 take 150 seconds, at 300 they take 10, and either way the wait is what sets the rate.

**Options.** Keep 20 and tell sites to raise it: the failure arrives on a real morning, at a site that did not read the page. Raise it to just above the scenario, 120: no margin for retries, an office of 1000 with a tenth arriving in one minute, or a `TRUST_PROXY` mistake, which makes everyone one address. Count failures only in this limit: the plugin cannot, and the database already does. Remove it: nothing would bound the hashing a burst can start before its first failures are recorded.

**Decision.** 300. Three times the scenario. About 5 hashes a second per address, against 31 a second measured for one process on the laptop, with libuv's four threads and the suite running beside it: one address can take a sixth of that. Tested at the defaults: 100 people in one minute from one address all sign in, and a sprayer from one address is refused after 50 wrong passwords.

**Second factor.** The same office met the same wall one step later: 10 verifications a minute per address, 5 email codes. Those now use this limit as well. The per-user limits and the lock after 10 wrong codes are what guard a code, and neither is shared with colleagues. Recovery codes and turning MFA off stay at 5, as nobody does those in a crowd. `POST /auth/password` stays at 5 per address too, which an office whose accounts were all created that morning can reach; it clears in a minute.

**Limits.** The limit is per process (D27), so N instances allow N times this. The back-off counter of 50 is shared by everyone behind an address and is a constant: a large office having a bad morning can reach it. Not changed, because it is the guard, and no measurement says what a real office's failure rate is. Someone with many addresses gets 50 guesses at each: the per-account counters are what meets that, not this limit. Not measured against a real NAT or on production hardware.

## D69 — `PUBLIC_URL`: links keep the address people use

**Context.** Links in mail were built from `BRAND_DOMAIN`, a hostname by contract. A stack on `localhost:8088` mailed `http://localhost/reset-password`, where nothing listens. The deployment repository worked around it for one link by editing the setup URL in `bin/stack-up`.

**Options.** Read the request's `Host`: an attacker chooses it, and a password reset link is the classic place to do so; jobs have no request either. Let `BRAND_DOMAIN` carry a port: it is also the tenant lookup and the CORS origin. Add a variable.

**Decision.** Optional `PUBLIC_URL`, scheme, host and port only. `appUrl` uses it when set, so all mail, the setup link and the demo output follow; left out, nothing changes. Startup refuses a path, a query, credentials, a host outside `BRAND_DOMAIN` and `BRAND_EXTRA_DOMAINS`, or `http` in production, since a mistaken value would send people's reset tokens elsewhere.

## D70 — The address is read as the request arrives

**Context.** `@fastify/rate-limit` threw in `normalizeIP` on aborted requests. `req.ip` reads the socket, whose address is gone once the client has hung up, unless Node has cached it because something read it earlier. The rate limit hook runs after the host and session lookups, which wait on the database.

**Decision.** The first hook, before anything waits, keeps `req.clientAddress`; limits, sessions and the audit trail read that. If it is already gone, which leaves nobody to answer, the request counts in one shared budget, `no-address`. Addresses go through the plugin's `normalizeIP`.

**Reason.** A dropped request is not an error, and hanging up must not be a way to spend no budget. Since `limitKey` replaced the plugin's own generator it had also stopped normalizing, so an IPv6 client had a new budget per address of its network: restored here.
