# Architecture

## Deployment model

**One customer = one installation**, deployed with Docker Compose (VM) or Terraform (dedicated AWS account). The isolation boundary is the infrastructure: separate database, secrets, storage, network and domain. Installations never talk to each other, and there is no central control plane or onboarding portal.

```
 Customer A (VM or AWS account)                 Customer B (separate VM or account)
 ┌──────────────────────────────────────┐       ┌──────────────────────────────────────┐
 │ HTTPS (Caddy | ALB+WAF)              │       │ HTTPS                                │
 │   └─ app container (same image)      │       │   └─ app container (same image)      │
 │        config: .env / tfvars         │       │        config: .env / tfvars         │
 │        secrets: .env 600 / Secrets M.│       │        secrets: own                  │
 │   └─ PostgreSQL (own volume / RDS)   │       │   └─ PostgreSQL (own)                │
 └──────────────────────────────────────┘       └──────────────────────────────────────┘
```

## Configuration layers

| Layer | Source | Examples | Who changes it | When it applies |
|---|---|---|---|---|
| Deployment identity & capabilities | Env vars (Compose `.env`, Terraform → ECS env) validated by `src/config/env.ts` | `APP_URL`, `BRAND_*`, `ORGANIZATION_*`, `ENABLED_MODULES` | Operator who deploys | Restart |
| Secrets | `.env` (mode 600) / AWS Secrets Manager → env | DB passwords, `DATA_ENCRYPTION_KEY` | Operator | Restart (provision rotates DB passwords) |
| Business settings | Database (`tenant_settings`), typed by `src/core/settings/registry.ts` | Weekly offs, regularization window, session lifetime, timezone override | Administrators in the app | Immediately, audited |

Settings precedence: code default → **deployment default** (`ORGANIZATION_TIMEZONE`, `ORGANIZATION_DATE_FORMAT`) → organization value → branch override. Immutable constraints (schemas) and deployment ceilings (e.g. session lifetime ≤ `SESSION_TTL_HOURS`) always apply. Deployment-controlled values (branding, domains, modules) have **no write API**. Admins see them read-only under Settings → Installation.

## Runtime white-labelling

- `src/config/installation.ts → buildPublicConfig(env)` is the single source of branding and organization identity. It is the only configuration exposed to browsers (`GET /api/v1/public/config`) and contains no secrets (tested).
- `index.html` is rendered once at startup with the installation's title, favicon and theme colour (`core/http/web.ts`). There's no unbranded flash and no rebuild.
- Logos: an `https://` URL (its origin is added to the SPA's CSP `img-src`), or a file from the mounted `BRANDING_DIR`. Those files are image types only, at most 2 MB, served from memory with a sandboxing CSP, and checked at startup.
- The SPA loads `/public/config` before rendering and applies colours via CSS variables. Dates use the configured format and timezone, money uses `ORGANIZATION_CURRENCY`. The UI has no hardcoded product or customer names.

## Request path (inside one installation)

```
HTTPS → app (Fastify)
  onRequest: Host must be one of this installation's domains (APP_URL / APP_EXTRA_DOMAINS, synced to DB)
             session cookie → user; CSRF token on unsafe methods; forced password change gate
  route:     tenantActor(req, ...permissions) → transaction with SET LOCAL app.tenant_id (RLS)
             requireFeature(db, org, 'module') for module operations
→ PostgreSQL as hrms_app (NOSUPERUSER, NOBYPASSRLS; append-only audit; immutable raw events)
```

The data model still carries `tenant_id` on every table, with row-level security and composite foreign keys. With one organization per database these are **defence in depth**, not the isolation boundary. The server refuses to start if a database holds more than one organization, and bootstrap refuses to create a second.

## Modules

`core/features/registry.ts` lists every module, with availability (`available` or `planned`) and dependencies. `ENABLED_MODULES` selects modules per installation. It is validated at startup: unknown or unbuilt modules, or missing dependencies, stop the process. Per request, `evaluateFeatures` reports **supported → enabled → configured → operational** (biometric: configured once a device exists; degraded if devices stop syncing). The UI reads only the `capabilities` map from `/auth/me`. APIs call `requireFeature`, so a disabled module returns `403 feature_unavailable`, and device ingestion is refused. Disabling never deletes data.

## Administrator bootstrap

`src/db/bootstrap.ts` runs as the schema owner, never over HTTP. It creates the single organization and the **first** administrator only, and is idempotent. Credentials:

- **Setup-link mode:** a one-time token, hashed in `admin_setup_tokens`, expiring and single-use, delivered in the URL fragment.
- **Password mode:** taken from Secrets Manager, with `must_change_password` set.

`--reset-admin` is the explicit recovery path. The server blocks every API except password change while `must_change_password` is set.

## Other services

- **Attendance:** immutable events → pure, versioned daily calculation (`modules/attendance/calc.ts`). Rules are in [docs/ATTENDANCE.md](docs/ATTENDANCE.md).
- **Approvals:** reusable engine (`core/workflow/engine.ts`) with sequential steps, user- or permission-based approvers, and maker-checker.
- **Audit:** `audit_logs` is written in the same transaction as each change. Security failures (e.g. a rejected setup link) are written in their own transaction so they survive rollbacks.
- **Background jobs:** `core/jobs`. A per-minute scheduler in every app instance claims (job, period) rows in `job_runs` (unique key → exactly once), runs them in organization-scoped transactions, retries failures, and recovers runs abandoned by crashed processes. Jobs are gated by modules and idempotent. Admins see history and can Run now (Settings → Scheduled jobs).
- **Health:** `/health/live` (process) and `/health/ready` (database reachable, no pending or unknown migrations, installation bootstrapped). Neither reveals internals.

## Code map

`src/config` deployment config and installation sync · `src/core` auth, features, settings, audit, workflow, crypto, http/web · `src/modules` employees, attendance (+ device ingestion), organization, admin settings · `src/db` pool, TLS, migrate, provision, bootstrap, seed · `apps/web` SPA · `deploy/compose` Compose installation · `infra` Terraform.
