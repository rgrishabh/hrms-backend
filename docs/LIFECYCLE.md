# Employee lifecycle: onboarding, probation, separation

Modules: `core.onboarding` (onboarding checklists, joining confirmation, probation reviews) and `core.offboarding` (separations, exit clearance, exit interview). Neither is in `default`.

## Checklists (shared engine)

HR (`lifecycle.manage`) maintains **templates** per kind (onboarding / offboarding). A task has a title, description, an **owner group** and a due offset in days from the anchor date (joining date or last working day; negative = before). One template per kind is the default.

| Owner | Who completes it | Who is notified |
|---|---|---|
| `hr`, `admin` | `lifecycle.manage` | holders of `lifecycle.manage` |
| `it` | `users.manage` (IT administrator) | IT administrators |
| `finance` | `expenses.pay` | finance / payroll |
| `manager` | the employee's reporting manager | the manager (HR if none) |
| `employee` | the employee | the employee |

- **Completing tasks:** HR can complete any task. Only HR can **skip** one, and skipping needs a note.
- **Closing:** a checklist closes when no task is pending. Reopening a task reopens the checklist. There is one open checklist per employee and kind.
- **Starting:** onboarding checklists start automatically when recruitment **hires** someone, using the default template. HR can also start one manually.
- **My tasks:** shows each person the tasks of their own group.
- **Reminders:** the daily job `lifecycle.daily` (06:30) reminds owners on the due date and then weekly while a task is overdue.
- **Joining:** HR confirms joining (`pre_joining → active`) on or after the joining date.

## Probation

- **Review opens:** the daily job opens a review `probation.review_lead_days` before the probation end (setting, default 14). It covers active employees with a probation end date and no confirmation, and notifies the reporting manager (HR if there is none).
- **Recommendation:** the manager (or HR) recommends **confirm**, **extend** (1–6 months) or **terminate**, with comments. Nobody reviews their own probation.
- **Approval:** approved by `lifecycle.manage`, never by the submitter.
- **Effect on the employee record:**
  - Confirm sets the confirmation date and changes `probation` to `permanent`.
  - Extend moves the probation end date; a new review opens before the new date.
  - Terminate is recorded only; HR then starts a termination separation.

## Separations

- **Kinds:** resignation (self-service), termination, retirement, contract end, death, absconding, mutual (HR-initiated). One live separation per employee.
- **Notice:** the notice date, the requested last working day (LWD) and the setting `offboarding.notice_days` (calendar days, default 30) give the **notice shortfall**. HR can change the LWD and waive the shortfall before approval. The shortfall is an input to F&F; recovery is decided there.
- **Approval:**
  - A resignation goes to the reporting manager, then HR.
  - HR-initiated separations need a **second** HR approver.
  - The requester can withdraw while the separation is pending. After approval, HR can cancel it before the LWD (e.g. a resignation retracted by agreement).
- **On approval:** the employee becomes `on_notice` with an exit date, and the **exit clearance** checklist starts from the default offboarding template, anchored on the LWD.
- **Exit interview:** answers are recorded by the employee or HR, and only HR can read them.
- **Access:** the daily job **disables the login and revokes every session** after the LWD, even if clearance is still open.
- **Completion:** HR completes the separation after the LWD, and only when no clearance task is pending, recording rehire eligibility. The employee becomes `exited`.
- **F&F:** the status (`not_started / in_progress / settled`) and a note are tracked here. Amounts come from payroll. The separation view shows leave balances at exit.

## Permissions

| Permission | Default roles |
|---|---|
| `lifecycle.self` (own tasks, resign) | everyone |
| `lifecycle.read` | HR administrator, HR executive, auditor |
| `lifecycle.manage` | HR administrator, HR executive |

## Not included / to verify

- Pre-joining document collection uses the Documents module (assign a task "Upload …").
- Notice periods by grade or contract, gratuity and leave encashment come with payroll.
- Statutory exit formalities (e.g. PF transfer/withdrawal, Form 16) depend on payroll and the organization's advisers.
