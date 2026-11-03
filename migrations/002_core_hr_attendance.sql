-- 002: employee master, approval workflow engine, attendance.

CREATE TABLE employees (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  employee_code        text NOT NULL,
  user_id              uuid REFERENCES users(id),
  first_name           text NOT NULL,
  last_name            text,
  work_email           text CHECK (work_email IS NULL OR work_email = lower(work_email)),
  phone                text,
  date_of_birth        date,
  legal_entity_id      uuid NOT NULL,
  branch_id            uuid NOT NULL,
  department_id        uuid,
  designation          text,
  grade                text,
  employment_type      text NOT NULL DEFAULT 'permanent' CHECK (employment_type IN ('permanent','probation','contract','trainee','intern','consultant')),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('pre_joining','active','on_notice','exited','inactive')),
  reporting_manager_id uuid,
  date_of_joining      date NOT NULL,
  probation_end_date   date,
  confirmation_date    date,
  contract_end_date    date,
  exit_date            date,
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, employee_code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES legal_entities (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id),
  FOREIGN KEY (tenant_id, reporting_manager_id) REFERENCES employees (tenant_id, id),
  CHECK (reporting_manager_id IS NULL OR reporting_manager_id <> id),
  CHECK (exit_date IS NULL OR exit_date >= date_of_joining)
);
CREATE UNIQUE INDEX employees_work_email_uq ON employees (tenant_id, work_email) WHERE work_email IS NOT NULL;
CREATE UNIQUE INDEX employees_user_uq ON employees (tenant_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX employees_branch_idx ON employees (tenant_id, branch_id, status);
CREATE INDEX employees_manager_idx ON employees (tenant_id, reporting_manager_id);
CREATE INDEX employees_name_idx ON employees (tenant_id, lower(first_name || ' ' || coalesce(last_name, '')));

-- Restricted: bank details live apart from the employee row; account number is
-- encrypted by the application (AES-256-GCM) and only last4 is queryable.
CREATE TABLE employee_bank_accounts (
  employee_id        uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  account_holder     text NOT NULL,
  account_number_enc text NOT NULL,
  account_last4      text NOT NULL CHECK (account_last4 ~ '^[0-9]{4}$'),
  ifsc               text NOT NULL CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  bank_name          text,
  updated_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);

-- ---------------------------------------------------------------- workflow engine
CREATE TABLE approval_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  entity_type   text NOT NULL,
  entity_id     uuid NOT NULL,
  requester_id  uuid NOT NULL REFERENCES users(id),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','returned','cancelled')),
  current_step  integer NOT NULL DEFAULT 0,
  summary       text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX approval_requests_open_entity_uq ON approval_requests (tenant_id, entity_type, entity_id) WHERE status = 'pending';

CREATE TABLE approval_steps (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  request_id         uuid NOT NULL,
  step_index         integer NOT NULL,
  approver_kind      text NOT NULL CHECK (approver_kind IN ('user','permission')),
  approver_user_id   uuid REFERENCES users(id),
  approver_permission text,
  status             text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','active','approved','rejected','returned','skipped')),
  acted_by           uuid REFERENCES users(id),
  acted_at           timestamptz,
  comment            text,
  UNIQUE (request_id, step_index),
  FOREIGN KEY (tenant_id, request_id) REFERENCES approval_requests (tenant_id, id),
  CHECK ((approver_kind = 'user' AND approver_user_id IS NOT NULL) OR (approver_kind = 'permission' AND approver_permission IS NOT NULL))
);
CREATE INDEX approval_steps_user_idx ON approval_steps (tenant_id, approver_user_id, status);

-- ---------------------------------------------------------------- attendance
CREATE TABLE shifts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  code                 text NOT NULL,
  name                 text NOT NULL,
  start_time           time NOT NULL,
  end_time             time NOT NULL,           -- end < start means the shift crosses midnight
  break_minutes        integer NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  grace_minutes        integer NOT NULL DEFAULT 0 CHECK (grace_minutes BETWEEN 0 AND 240),
  early_exit_grace_minutes integer NOT NULL DEFAULT 0 CHECK (early_exit_grace_minutes BETWEEN 0 AND 240),
  half_day_min_minutes integer NOT NULL CHECK (half_day_min_minutes > 0),
  full_day_min_minutes integer NOT NULL CHECK (full_day_min_minutes > 0),
  overtime_after_minutes integer,               -- NULL = no overtime for this shift
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  CHECK (full_day_min_minutes >= half_day_min_minutes),
  CHECK (start_time <> end_time)
);

CREATE TABLE shift_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  employee_id    uuid NOT NULL,
  shift_id       uuid NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES shifts (tenant_id, id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX shift_assignments_emp_idx ON shift_assignments (tenant_id, employee_id, effective_from DESC);

CREATE TABLE holidays (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  branch_id   uuid,                    -- NULL = applies to all branches
  holiday_date date NOT NULL,
  name        text NOT NULL,
  optional    boolean NOT NULL DEFAULT false,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);
CREATE UNIQUE INDEX holidays_uq ON holidays (tenant_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'), holiday_date);

CREATE TABLE attendance_devices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  branch_id           uuid NOT NULL,
  serial_number       text NOT NULL,
  name                text NOT NULL,
  adapter_key         text NOT NULL,             -- e.g. 'generic_push_v1'
  api_key_hash        text NOT NULL,
  api_key_prefix      text NOT NULL UNIQUE,      -- public lookup part of the key
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','replaced')),
  last_sync_at        timestamptz,
  last_clock_drift_seconds integer,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, serial_number),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id)
);

-- Device-side enrolment id -> employee. Scoped per tenant so replacement devices reuse mappings.
CREATE TABLE device_user_mappings (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  device_user_id text NOT NULL,
  employee_id    uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, device_user_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);

-- Raw, immutable event history. Never updated except status annotation; never deleted.
CREATE TABLE attendance_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  employee_id     uuid,                          -- NULL when unmapped (goes to error queue)
  source          text NOT NULL CHECK (source IN ('web','mobile','biometric','regularization')),
  source_ref      text NOT NULL,                 -- stable id for dedupe (device event id / client idempotency key)
  device_id       uuid,
  device_user_id  text,
  event_time      timestamptz NOT NULL,          -- normalized (drift-corrected for devices)
  device_time     timestamptz,                   -- as reported by the device, unmodified
  received_at     timestamptz NOT NULL DEFAULT now(),
  direction       text NOT NULL DEFAULT 'unknown' CHECK (direction IN ('in','out','unknown')),
  latitude        numeric(9,6),
  longitude       numeric(9,6),
  status          text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','unmapped','rejected')),
  reject_reason   text,
  created_by      uuid,
  UNIQUE (tenant_id, source, source_ref),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES attendance_devices (tenant_id, id)
);
CREATE INDEX attendance_events_emp_time_idx ON attendance_events (tenant_id, employee_id, event_time);
CREATE INDEX attendance_events_unmapped_idx ON attendance_events (tenant_id, status) WHERE status <> 'accepted';

-- Calculated result; recomputable from events + policy, except when locked.
CREATE TABLE attendance_daily (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  employee_id          uuid NOT NULL,
  work_date            date NOT NULL,
  shift_id             uuid,
  day_type             text NOT NULL CHECK (day_type IN ('working','weekly_off','holiday')),
  status               text NOT NULL CHECK (status IN ('present','half_day','absent','missing_punch','weekly_off','holiday','not_joined')),
  first_in             timestamptz,
  last_out             timestamptz,
  punch_count          integer NOT NULL DEFAULT 0,
  worked_minutes       integer NOT NULL DEFAULT 0,
  late_minutes         integer NOT NULL DEFAULT 0,
  early_exit_minutes   integer NOT NULL DEFAULT 0,
  overtime_minutes     integer NOT NULL DEFAULT 0,
  exceptions           text[] NOT NULL DEFAULT '{}',
  policy_snapshot      jsonb NOT NULL DEFAULT '{}'::jsonb,
  calc_version         integer NOT NULL,
  calculated_at        timestamptz NOT NULL DEFAULT now(),
  locked               boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, employee_id, work_date),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id)
);
CREATE INDEX attendance_daily_date_idx ON attendance_daily (tenant_id, work_date, status);

CREATE TABLE attendance_regularizations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  employee_id    uuid NOT NULL,
  work_date      date NOT NULL,
  requested_in   timestamptz,
  requested_out  timestamptz,
  reason         text NOT NULL CHECK (length(reason) BETWEEN 5 AND 1000),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','returned','cancelled')),
  requested_by   uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  CHECK (requested_in IS NOT NULL OR requested_out IS NOT NULL),
  CHECK (requested_out IS NULL OR requested_in IS NULL OR requested_out > requested_in)
);

CREATE TABLE attendance_period_locks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  period_start date NOT NULL,
  period_end   date NOT NULL,
  locked_by    uuid NOT NULL REFERENCES users(id),
  locked_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);
CREATE INDEX attendance_period_locks_idx ON attendance_period_locks (tenant_id, period_start, period_end);
