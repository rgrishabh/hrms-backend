-- 001_foundation: tenancy, identity, feature registry, settings, audit, org structure.
-- Runs as the schema owner (hrms_owner). Runtime role is hrms_app (no BYPASSRLS).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- RLS helper: current tenant from transaction-local setting; explicit platform bypass flag.
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;
CREATE OR REPLACE FUNCTION app_platform_bypass() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.platform_bypass', true), '') = 'on'
$$;

-- ---------------------------------------------------------------- tenants
CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$'),
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  locale        text NOT NULL DEFAULT 'en-IN',
  timezone      text NOT NULL DEFAULT 'Asia/Kolkata',
  date_format   text NOT NULL DEFAULT 'DD/MM/YYYY',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_domains (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  hostname            text NOT NULL CHECK (hostname = lower(hostname)),
  verification_token  text NOT NULL,
  verification_status text NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending','verified','failed')),
  verified_at         timestamptz,
  activation_status   text NOT NULL DEFAULT 'inactive' CHECK (activation_status IN ('inactive','active')),
  tls_status          text NOT NULL DEFAULT 'not_requested' CHECK (tls_status IN ('not_requested','pending','issued','failed')),
  is_primary          boolean NOT NULL DEFAULT false,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (activation_status = 'inactive' OR verification_status = 'verified')
);
-- A hostname can be held by only one tenant, ever-active or pending.
CREATE UNIQUE INDEX tenant_domains_hostname_uq ON tenant_domains (hostname);

CREATE TABLE tenant_branding (
  tenant_id          uuid PRIMARY KEY REFERENCES tenants(id),
  display_name       text NOT NULL,
  logo_object_key    text,
  favicon_object_key text,
  primary_color      text NOT NULL DEFAULT '#1f5f8b' CHECK (primary_color ~ '^#[0-9a-fA-F]{6}$'),
  secondary_color    text NOT NULL DEFAULT '#2e8b57' CHECK (secondary_color ~ '^#[0-9a-fA-F]{6}$'),
  login_message      text,
  email_branding     jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- feature registry
-- Source of truth is the typed registry in code (src/core/features/registry.ts);
-- this table is synced from it so SQL reports and FKs can reference feature keys.
CREATE TABLE feature_definitions (
  key                   text PRIMARY KEY,
  name                  text NOT NULL,
  description           text NOT NULL,
  category              text NOT NULL,
  default_enabled       boolean NOT NULL,
  dependencies          text[] NOT NULL DEFAULT '{}',
  platform_supported    boolean NOT NULL,
  requires_entitlement  boolean NOT NULL,
  core                  boolean NOT NULL DEFAULT false,
  configuration_schema  jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_feature_entitlements (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  feature_key     text NOT NULL REFERENCES feature_definitions(key),
  entitled        boolean NOT NULL,
  effective_from  date NOT NULL DEFAULT current_date,
  effective_until date,
  source          text NOT NULL DEFAULT 'platform_admin',
  granted_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, feature_key),
  CHECK (effective_until IS NULL OR effective_until >= effective_from)
);

CREATE TABLE tenant_modules (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  feature_key          text NOT NULL REFERENCES feature_definitions(key),
  enabled              boolean NOT NULL,
  configuration_status text NOT NULL DEFAULT 'not_required' CHECK (configuration_status IN ('not_required','incomplete','complete')),
  updated_by           uuid,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, feature_key)
);

-- ---------------------------------------------------------------- settings
CREATE TABLE platform_settings (
  setting_key   text PRIMARY KEY,
  setting_value jsonb NOT NULL,
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_settings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  setting_key   text NOT NULL,
  scope_type    text NOT NULL DEFAULT 'tenant' CHECK (scope_type IN ('tenant','branch')),
  scope_id      uuid,
  setting_value jsonb NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope_type = 'tenant' AND scope_id IS NULL) OR (scope_type = 'branch' AND scope_id IS NOT NULL))
);
CREATE UNIQUE INDEX tenant_settings_uq ON tenant_settings (tenant_id, setting_key, scope_type, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'));

CREATE TABLE tenant_integrations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  provider_key     text NOT NULL,
  enabled          boolean NOT NULL DEFAULT false,
  configuration    jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_reference text,            -- e.g. ARN / secret id; never the secret itself
  health_status    text NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('unknown','healthy','degraded','failing')),
  last_verified_at timestamptz,
  last_error       text,
  updated_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider_key)
);

-- ---------------------------------------------------------------- identity
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid REFERENCES tenants(id),          -- NULL = platform user
  email            text NOT NULL CHECK (email = lower(email)),
  display_name     text NOT NULL,
  password_hash    text,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','locked')),
  failed_logins    integer NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  mfa_required     boolean NOT NULL DEFAULT false,
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'), email);

-- Custom tenant roles; system roles live in code (src/core/auth/permissions.ts).
CREATE TABLE tenant_roles (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  key         text NOT NULL CHECK (key ~ '^custom:[a-z0-9_]+$'),
  name        text NOT NULL,
  permissions text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE user_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  tenant_id   uuid REFERENCES tenants(id),               -- NULL for platform roles
  role_key    text NOT NULL,
  scope_type  text NOT NULL DEFAULT 'tenant' CHECK (scope_type IN ('platform','tenant','branch','department')),
  scope_id    uuid,
  granted_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_roles_uq ON user_roles (user_id, role_key, scope_type, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'));

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text NOT NULL UNIQUE,
  csrf_hash    text NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id),
  tenant_id    uuid REFERENCES tenants(id),
  ip           text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- audit (append-only)
CREATE TABLE audit_logs (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid REFERENCES tenants(id),
  actor_id        uuid,
  actor_type      text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','system','device','platform')),
  action          text NOT NULL,
  category        text NOT NULL DEFAULT 'data' CHECK (category IN ('auth','configuration','data','security','access')),
  target_type     text,
  target_id       text,
  setting_key     text,
  change_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id      text,
  ip              text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_tenant_time_idx ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX audit_logs_target_idx ON audit_logs (tenant_id, target_type, target_id);

-- ---------------------------------------------------------------- organization
CREATE TABLE legal_entities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  name        text NOT NULL,
  cin         text,
  gstin       text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  state_code  text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id)
);

CREATE TABLE branches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL,
  code            text NOT NULL,
  name            text NOT NULL,
  state           text NOT NULL,
  city            text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES legal_entities (tenant_id, id)
);

CREATE TABLE departments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  code        text NOT NULL,
  name        text NOT NULL,
  parent_id   uuid,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES departments (tenant_id, id)
);
