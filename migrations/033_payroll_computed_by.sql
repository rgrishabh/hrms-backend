-- 033: who last computed a run, so they can be kept from approving it.
ALTER TABLE payroll_runs ADD COLUMN computed_by uuid REFERENCES users(id);
