-- 006: leave management — configurable types, append-only balance ledger, requests,
-- and attendance integration (on_leave days).

CREATE TABLE leave_types (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id),
  code                     text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{0,9}$'),
  name                     text NOT NULL,
  description              text,
  paid                     boolean NOT NULL DEFAULT true,
  allow_half_day           boolean NOT NULL DEFAULT true,
  requires_balance         boolean NOT NULL DEFAULT true,     -- false e.g. for leave without pay
  accrual_method           text NOT NULL DEFAULT 'annual' CHECK (accrual_method IN ('none','annual','monthly')),
  annual_entitlement       numeric(6,2) NOT NULL DEFAULT 0 CHECK (annual_entitlement >= 0),
  carry_forward_max        numeric(6,2) NOT NULL DEFAULT 0 CHECK (carry_forward_max >= 0),
  max_balance              numeric(6,2) CHECK (max_balance IS NULL OR max_balance >= 0),
  count_non_working_days   boolean NOT NULL DEFAULT false,   -- "sandwich": weekly offs/holidays inside the range count
  min_notice_days          integer NOT NULL DEFAULT 0 CHECK (min_notice_days BETWEEN 0 AND 365),
  max_consecutive_days     numeric(6,2) CHECK (max_consecutive_days IS NULL OR max_consecutive_days > 0),
  eligible_after_days      integer NOT NULL DEFAULT 0 CHECK (eligible_after_days BETWEEN 0 AND 3650),
  applicable_employment_types text[] NOT NULL DEFAULT '{}',  -- empty = all
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version                  integer NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

CREATE TABLE leave_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  employee_id    uuid NOT NULL,
  leave_type_id  uuid NOT NULL,
  leave_year     integer NOT NULL,
  start_date     date NOT NULL,
  end_date       date NOT NULL,
  start_half     text NOT NULL DEFAULT 'full' CHECK (start_half IN ('full','second_half')),  -- second_half: leave starts after lunch
  end_half       text NOT NULL DEFAULT 'full' CHECK (end_half IN ('full','first_half')),     -- first_half: back after lunch
  days           numeric(6,2) NOT NULL CHECK (days > 0),
  reason         text NOT NULL CHECK (length(reason) BETWEEN 3 AND 1000),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','returned','cancelled')),
  requested_by   uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz,
  cancelled_at   timestamptz,
  cancelled_by   uuid REFERENCES users(id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types (tenant_id, id),
  CHECK (end_date >= start_date),
  CHECK (NOT (start_date = end_date AND start_half <> 'full' AND end_half <> 'full'))
);
CREATE INDEX leave_requests_emp_dates_idx ON leave_requests (tenant_id, employee_id, start_date, end_date) WHERE status IN ('pending','approved');
CREATE INDEX leave_requests_status_idx ON leave_requests (tenant_id, status, start_date);

-- Append-only ledger: balance(employee, type, year) = sum(days). Never updated or deleted.
CREATE TABLE leave_ledger (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  employee_id    uuid NOT NULL,
  leave_type_id  uuid NOT NULL,
  leave_year     integer NOT NULL,
  entry_type     text NOT NULL CHECK (entry_type IN ('opening','accrual','consumption','reversal','adjustment','carry_forward','lapse')),
  days           numeric(6,2) NOT NULL CHECK (days <> 0),
  request_id     uuid,
  reference      text NOT NULL,              -- idempotency key (accrual period, request action, …)
  note           text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, reference),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees (tenant_id, id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types (tenant_id, id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES leave_requests (tenant_id, id)
);
CREATE INDEX leave_ledger_balance_idx ON leave_ledger (tenant_id, employee_id, leave_type_id, leave_year);

-- Attendance: leave days.
ALTER TABLE attendance_daily DROP CONSTRAINT attendance_daily_status_check;
ALTER TABLE attendance_daily ADD CONSTRAINT attendance_daily_status_check
  CHECK (status IN ('present','half_day','absent','missing_punch','weekly_off','holiday','not_joined','on_leave'));
ALTER TABLE attendance_daily ADD COLUMN leave_fraction numeric(3,2) NOT NULL DEFAULT 0 CHECK (leave_fraction IN (0, 0.5, 1));
ALTER TABLE attendance_daily ADD COLUMN leave_type_code text;

-- RLS + grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['leave_types','leave_requests','leave_ledger'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_platform_bypass() OR tenant_id = app_current_tenant())
      WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    REVOKE UPDATE, DELETE ON leave_ledger FROM hrms_app;
    REVOKE DELETE ON leave_requests, leave_types FROM hrms_app;
  END IF;
END $$;
