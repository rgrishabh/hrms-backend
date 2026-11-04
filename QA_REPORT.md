# QA report: revamp batch A (business logic and security)

Each row was reproduced with a failing test before the fix, unless the fix column says "not a bug" or "no change". Audit IDs refer to `AUDIT.md`. Severity: S1 wrong money or direct data exposure, S2 control gap, S3 minor.

| ID | Module | Sev | Steps to reproduce | Root cause | Fix | Test |
|---|---|---|---|---|---|---|
| F-1 | Payroll | S1 | Half-day approved leave, other half not worked; compute a run. Paid leave gives LOP 0, unpaid gives 0.5 | `lossOfPay` read `half_day` + leave as "other half covered", but attendance only reports it when the other half was not completed | `half_day` always costs 0.5 for the unworked half, plus the leave fraction when the leave is unpaid. `CALC_VERSION` 2 | `test/payroll-fixes.test.ts` "F-1" |
