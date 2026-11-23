-- hrms:no-transaction
DROP INDEX CONCURRENTLY IF EXISTS employees_email_trgm_idx;
DROP INDEX CONCURRENTLY IF EXISTS employees_name_trgm_idx;
DROP INDEX CONCURRENTLY IF EXISTS approval_steps_active_idx;
DROP INDEX CONCURRENTLY IF EXISTS approval_requests_pending_idx;
DROP INDEX CONCURRENTLY IF EXISTS approval_requests_requester_idx;
DROP INDEX CONCURRENTLY IF EXISTS payroll_items_employee_idx;
DROP INDEX CONCURRENTLY IF EXISTS payroll_adjustments_run_emp_idx;
DROP INDEX CONCURRENTLY IF EXISTS loan_recoveries_run_idx;
DROP INDEX CONCURRENTLY IF EXISTS overtime_claims_run_idx;
DROP INDEX CONCURRENTLY IF EXISTS expense_claims_batch_idx;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension e WHERE e.extname = 'pg_trgm' AND pg_has_role(current_user, e.extowner, 'MEMBER')) THEN
    DROP EXTENSION pg_trgm;
  END IF;
END $$;
