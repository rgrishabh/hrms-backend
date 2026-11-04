# Reports

Read-only reports over the HR data, each run on demand from **Reports** in the web app and downloadable as CSV.
Defined in `src/modules/reports/registry.ts`: every report declares who may run it, the module it needs, its
parameters (the web form is generated from them) and one SQL query. Grouping expressions are fixed in code and
chosen from a list; no user text reaches SQL.

| Report | Who (org-wide · team only) | Module | Parameters |
|---|---|---|---|
| Headcount | `employees.read` | core | on date; group by department, branch, legal entity, employment type, grade, designation |
| Attrition | `employees.read` | core | from, to (≤ 10 years); same groupings |
| Joiners and leavers | `employees.read` (separation type only with `lifecycle.read`) | core | from, to; joiners / leavers / both |
| Attendance summary | `attendance.read` · `attendance.team.read` | attendance | from, to (≤ 366 days); per employee or department |
| Leave taken | `leave.read` · `leave.team.read` | leave | from, to (≤ 731 days); per employee, department or leave type |
| Leave balances | `leave.read` · `leave.team.read` | leave | leave year |
| Payroll cost | `payroll.read` | payroll | from month, to month (≤ 36); by month, department, branch, legal entity |
| Expenses | `expenses.read` | expenses | from, to; by category, department, employee, month; approved / paid / pending |
| Training due for renewal | `competency.read` or `training.manage` | training | due within N days; expired / due / both |
| Authorizations due for review | `competency.read` | lab.competency | due within N days; overdue / due / both |

## Definitions

- **Headcount on a date** counts people who had joined on or before it and whose last working day is on or after it.
  Pre-joining records are never counted. Groupings use each person's *current* department, branch, type and grade.
- **Attrition %** = leavers ÷ average of opening and closing headcount. Opening = employed at the start of the first
  day; closing = still employed after the last day, so closing = opening + joiners − leavers. *Annualized* scales
  the rate by 365 ÷ days in the period. *Resigned* counts leavers whose approved separation is a resignation.
- **Attendance %** = (present + ½ half days) ÷ (working days − leave days), from calculated attendance.
- **Leave taken** counts approved requests; a request crossing the start or end of the period is counted in
  proportion to its calendar days inside the period.
- **Payroll cost** includes approved, finalized and paid runs (regular and full-and-final), never drafts.

## Privacy and audit

- Team-scoped reports (managers) cover the caller's reporting chain only (direct and indirect reports).
- Results are capped at 5000 rows (the response says when it was truncated).
- CSV downloads are `Cache-Control: no-store`, neutralize spreadsheet formulas (`=`, `+`, `-`, `@` …), and are
  audited as `reports.exported` with the report key, parameters, scope and row count. On-screen views are not audited.
