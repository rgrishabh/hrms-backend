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
