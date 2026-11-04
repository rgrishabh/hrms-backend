-- Which module a notification belongs to, so that it goes out of sight while that module is off and comes back with it.
ALTER TABLE notifications ADD COLUMN feature text;

SELECT set_config('app.platform_bypass', 'on', true);
UPDATE notifications SET feature = CASE
    WHEN kind LIKE 'assets.%' THEN 'assets'
    WHEN kind LIKE 'competency.%' THEN 'lab.competency'
    WHEN kind LIKE 'documents.%' THEN 'core.documents'
    WHEN kind LIKE 'expenses.%' THEN 'expenses'
    WHEN kind LIKE 'loans.%' THEN 'loans'
    WHEN kind LIKE 'payroll.payslip%' THEN 'payroll.payslips'
    WHEN kind LIKE 'payroll.%' THEN 'payroll'
    WHEN kind LIKE 'performance.%' THEN 'performance'
    WHEN kind LIKE 'policies.%' THEN 'core.policies'
    WHEN kind LIKE 'recruitment.%' THEN 'recruitment'
    WHEN kind LIKE 'reports.%' THEN 'reports.advanced'
    WHEN kind LIKE 'training.%' THEN 'training'
    WHEN kind LIKE 'travel.%' THEN 'travel'
    WHEN kind IN ('cases.committee','cases.posh','cases.deadline') THEN 'posh'
    WHEN kind IN ('cases.grievance','cases.assigned','cases.overdue') THEN 'grievance'
    WHEN kind IN ('lifecycle.onboarding','lifecycle.probation') THEN 'core.onboarding'
    WHEN kind = 'lifecycle.offboarding' THEN 'core.offboarding'
    ELSE NULL END
 WHERE feature IS NULL;
