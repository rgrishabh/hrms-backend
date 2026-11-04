# Reports

Read-only reports over the HR data, each run on demand from **Reports** in the web app and downloadable as CSV or Excel (.xlsx).
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
- Downloads are `Cache-Control: no-store` and audited as `reports.exported` with the report key, parameters, scope, row count and format. On-screen views are not audited.
- **CSV** neutralizes spreadsheet formulas (`=`, `+`, `-`, `@` …) with a leading apostrophe.
- **Excel** (`/export.xlsx`) is written by HRMS itself (`src/core/http/xlsx.ts`, no third-party library): one sheet named after the report, a bold frozen header with a filter, money as `#,##0.00`, percentages, dates as real dates, and a bold totals row. Text cells are always plain text, never formulas, so nothing in the data can run when the file is opened, and codes keep their leading zeros.

## Advanced reporting (module `reports.advanced`)

Code: `src/modules/reports/service.ts`, `routes.ts`. Tests: `test/reports-advanced.test.ts`.

### Department overview

The **department overview** report covers one period, with one row per department. It always shows:
- headcount at the end of the period;
- joiners and leavers.

These columns appear only when the module is in use and the person running the report may see that data:
- attendance %, with field duty counted as attended (`attendance.read`);
- approved leave days (`leave.read`);
- approved overtime hours (`overtime.read`);
- approved expenses (`expenses.read`);
- payroll gross and employer cost from finalized runs (`payroll.read`).

The notes say which columns were left out. Departments are each employee's *current* department.

### Saved and scheduled reports

- **Saved reports.** Anyone who can run a report can save it with its parameters under a name. Saved reports are personal.
- **Schedules.** A saved report can run daily, weekly (on a chosen weekday) or monthly (on day 1–28).
  - The period can be kept as saved, or move with each run: yesterday, last 7 days, last month, month to date, or year to date.
  - The `reports.scheduled` job (06:30) runs due schedules **as their owner, with the owner's access at that moment**. If the owner can no longer run the report, the schedule stops.
- **Recipients.** Recipients other than the owner must be able to see that report for the **whole organization** themselves. A manager's team-only report can only be scheduled for that manager.
  - This is checked when the schedule is saved, and again at every run. A recipient who has lost access is left out.
- **Delivery.** Recipients are notified in HRMS (and by email if that's on) that the report is ready. **The report data is never put in an email.** It stays in HRMS as a snapshot and is opened after signing in.
  - Opening a snapshot checks access again.
  - CSV downloads are audited.
  - Snapshots are kept for 90 days.
