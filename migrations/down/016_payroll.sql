-- Undoes 016.
DROP TABLE payroll_items, payroll_adjustments, payroll_runs, statutory_rules, employee_statutory, employee_salaries, pay_components;
DROP FUNCTION payroll_guard_finalized();
