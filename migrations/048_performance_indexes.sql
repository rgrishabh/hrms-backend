-- hrms:no-transaction
-- Indexes from the audit's query shapes. Built concurrently: employees, payroll_items and approval_* can be large, and these tables stay writable. IF NOT EXISTS so an interrupted run can start again.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY IF NOT EXISTS expense_claims_batch_idx ON expense_claims (tenant_id, batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS overtime_claims_run_idx ON overtime_claims (tenant_id, payroll_run_id) WHERE payroll_run_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS loan_recoveries_run_idx ON loan_recoveries (tenant_id, payroll_run_id) WHERE payroll_run_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS payroll_adjustments_run_emp_idx ON payroll_adjustments (tenant_id, run_id, employee_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS payroll_items_employee_idx ON payroll_items (tenant_id, employee_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS approval_requests_requester_idx ON approval_requests (tenant_id, requester_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS approval_requests_pending_idx ON approval_requests (tenant_id, status) WHERE status = 'pending';
CREATE INDEX CONCURRENTLY IF NOT EXISTS approval_steps_active_idx ON approval_steps (tenant_id, status) WHERE status = 'active';
CREATE INDEX CONCURRENTLY IF NOT EXISTS employees_name_trgm_idx ON employees USING gin (lower(first_name || ' ' || coalesce(last_name, '')) gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS employees_email_trgm_idx ON employees USING gin (work_email gin_trgm_ops) WHERE work_email IS NOT NULL;
