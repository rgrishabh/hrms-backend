# QA report: revamp batch A (business logic and security)

Each row was reproduced with a failing test before the fix, unless the fix column says "not a bug" or "no change". Audit IDs refer to `AUDIT.md`. Severity: S1 wrong money or direct data exposure, S2 control gap, S3 minor.

| ID | Module | Sev | Steps to reproduce | Root cause | Fix | Test |
|---|---|---|---|---|---|---|
| F-1 | Payroll | S1 | Half-day approved leave, other half not worked; compute a run. Paid leave gives LOP 0, unpaid gives 0.5 | `lossOfPay` read `half_day` + leave as "other half covered", but attendance only reports it when the other half was not completed | `half_day` always costs 0.5 for the unworked half, plus the leave fraction when the leave is unpaid. `CALC_VERSION` 2 | `test/payroll-fixes.test.ts` "F-1" |
| F-2 | Leave | S1 | Close a year with carry 10: Y and Y+1 both show 10. Backdated leave in Y spends them again; F&F suggestions sum all years | Year-end credited Y+1 without removing the days from Y; no closed-year guard; suggestions had no year filter; no date guard; carry ignored `max_balance` | New `carry_out` entry, `leave_year_closures`, closed-year guard on leave, adjustments and accruals, year-end only after the year ends, carry capped by `max_balance`, F&F and separation balances use the leave year of the last working day. **`test/leave.test.ts:201` expected the bug (Y balance 10) and was corrected to 0** | `test/leave-fixes.test.ts` "F-2" |
| F-4 | Payroll | S1 | ₹50,000 salary with a one-off ₹100,000 taxable bonus: TDS 10,833 with fixture slabs, against 8,542 | `taxableMonthly` included one-offs and was multiplied by 12 | One-offs are taxed once at the extra annual tax they cause, in the month paid. Reviewer must confirm (D25) | `test/payroll-calc.test.ts` "F-4" |
| F-5 | Payroll | S1 | ₹30,000 salary, threshold ₹21,000, 15 paid days: ESI charged. Raise mid-period: dropped from cover | Cover tested on prorated wages of the month, no contribution periods | Cover follows the full-month wage at the contribution-period start. Reviewer must confirm (D25) | `test/payroll-calc.test.ts` "F-5", `test/payroll-fixes.test.ts` "F-5" |
| F-6 | Payroll | S1 | Increment effective on the 20th: whole month paid at the new rate | `computeRun` took the single latest salary on or before the period end | Salary split into stretches by calendar days, LOP allocated by date, `CALC_VERSION` 4 | `test/payroll-calc.test.ts`, `test/payroll-fixes.test.ts` "F-6" |
| F-3 | Payroll | S1 | Leaver with both a regular and an F&F run for a month: salary paid twice; several F&F runs allowed | Overlap only guarded for regular runs; both runs computed the same days | One non-cancelled F&F per employee; the run that commits first owns the month's salary (see docs/PAYROLL.md); `CALC_VERSION` 5 | `test/payroll-fixes.test.ts` "F-3" |
| F-7 | Payroll | S1 | Compute, approve, lock attendance, finalize: items keep LOP from before the lock and become immutable | `/finalize` checked a lock existed, not that the run was computed after it; an approved run had no way back | Finalize refuses stale results (lock later than `computed_at`, older `calc_version`, F&F attendance changed). New `POST /runs/:id/reopen`. `test/payroll.test.ts` encoded the stale order and now reopens first | `test/payroll-fixes.test.ts` "F-7" |
| 4.2-P1 | Payroll | S2 | Propose a salary, finalize a run covering its date, approve: salary activates inside a closed month | Finalized-run check ran only at proposal | Same check in the approval handler | `test/payroll-fixes.test.ts` "other payroll findings" |
| 4.2-P2 | Payroll | S2 | LWF month with zero gross: LWF charged, net negative, auto-hold | LWF had no pay condition | Charged only when gross is above zero (`CALC_VERSION` 6) | `test/payroll-calc.test.ts` "LWF" |
| 4.2-P3 | Payroll | S2 | Someone with both payroll roles computes or adjusts, another submits; the first approves | Maker-checker excluded only the submitter | Computer (`computed_by`, migration 033) and adjustment authors are excluded | `test/payroll-fixes.test.ts` |
| 4.2-P4 | Payroll | S2 | `PUT /employees/:id/statutory` without `uan`: UAN and ESI number wiped | Omitted fields defaulted to null | Omitted keeps, null clears | `test/payroll-fixes.test.ts` |
| 4.2-P5 | Reports | S3 | Register CSV with negative net: cell is text `'-100` | Formula guard caught every leading minus | A plain negative number stays numeric; formulas still neutralized | `test/payroll-fixes.test.ts` |
| 4.2-P6 | Jobs | S3 | Scheduler down on close day: that close is skipped | `duePeriod` only offers today | No change: the lock recalculates everyone and F-7 refuses anything computed before it. Catch-up belongs with the worker batch | Covered by F-7 tests |
| F-8 | Attendance | S1 | Original in 09:30, out 18:00, corrected in 09:00 approved: `missing_punch`, a full day of LOP | Corrections were added beside originals and paired with them | A correction takes the place of the first in or last out at calculation; source events stay. Attendance `CALC_VERSION` 4 | `test/attendance-calc.test.ts`, `test/attendance-fixes.test.ts` "F-8" |
| F-9 | Employees | S1 | HR changes any employee's bank account: applied at once, nobody told; HR can change their own | `PUT bank-account` wrote directly | Proposes a change (migration 034), approved by `employees.bank.approve`; employee notified both times, no digits; own account refused. **`PUT` returns 202** | `test/bank-change.test.ts` |
| F-10 | Reports | S1 | Payroll-permitted owner schedules `department_overview` to an HR Executive: recipient reads payroll gross. Snapshots stay readable after the module is off | Columns came from the owner's permissions; recipient check covered the report only; `loadSnapshot` skipped `def.feature` | Columns with guards are removed per reader at read time (view and exports), plus the feature check | `test/reports-advanced.test.ts` "F-10" |
| F-12 | Payroll, Loans | S1 | Hold an item carrying a loan instalment, finalize: loan shows recovered and can close though the pay never went out; no way to release it | `balanceOf` counted every finalized recovery; the finalize trigger blocked all item changes | Held recoveries stay in progress. Release route (migration 035 narrows the trigger to exactly that change), payslip notice, separate `bank-released.csv` | `test/payroll-fixes.test.ts` "F-12" |
| F-14 | Approvals | S2 | Disable an approver with a pending step; or a group step whose only holder is the requester: pending forever, nobody told | Steps frozen at creation; escalation user-only and off by default; no eligibility check on group steps | Disable (and exit) moves steps to the manager or fallback owner (`approvals.escalations`); creation and the daily job catch group steps nobody can act on; if the fallback cannot act either, admins and requester are warned and can use new `POST /approvals/:id/reassign`. `approvals.escalate_after_days` default is now 5 (`test/approval-delegation.test.ts` "off by default" now sets 0) | `test/approval-fixes.test.ts` |
| F-15 | Auth | S2 | `TRUST_PROXY=true`, login with a new leftmost `X-Forwarded-For` each time: never rate limited, audit IP forged | Trust-all takes the leftmost entry | `TRUST_PROXY` takes hops or CIDRs, `true` means one hop; per-account login limit `AUTH_ACCOUNT_RATE_LIMIT_PER_MINUTE`. Reproduced with `inject`, not behind a live ALB | `test/rate-limit.test.ts` "F-15" |
| F-13 (loans) | Loans | S2 | Compute reads a loan balance while a repayment is recorded: both see the full balance | `computeRun` read loans without a lock | `plannedRecoveries` takes `FOR UPDATE`, as repayment does. Deterministic test holds the lock and shows the repayment waits, then refuses | `test/concurrency-fixes.test.ts` |
| F-13 (leave), 4.2-L1, L2 | Leave | S2 | Five parallel requests on balance 2: five accepted. Morning and afternoon on one date: refused. Two pending that no longer both fit block each other at approval | No lock around balance check and insert; overlap date-only and application-only; approval counted other pending requests as reserved | Employee row lock around submit and approve; exclusion constraint on half-day slots (migration 036, existing overlaps flagged, not touched); approval checks the ledger | `test/concurrency-fixes.test.ts` |
| 4.2-L3 | Attendance | S2 | Lock a period with pending leave: leave can never be approved, person absent with LOP | Lock checked pending regularizations only | Lock refuses while leave in the period is pending | `test/concurrency-fixes.test.ts` |
| 4.2-L4 | Leave | S2 | Monthly accrual with `max_balance`: capped months back-fill once room appears | Zero credit left no record and the loop revisited earlier months | `leave_accrual_progress` (migration 037, backfilled from the ledger) records months processed | `test/leave-fixes.test.ts` "accruals" |
| 4.2-L5 | Leave | S3 | 20 days a year accrues 20.04 | Per-month amount rounded to 2 dp then summed | Credit is the difference of rounded running totals | `test/leave-fixes.test.ts`, `test/property-leave.test.ts` |
| 4.2-L6 | Leave | S3 | Annual credit for someone with a known exit date in the year: full year | Proration only for joiners | Prorated by months employed. Does not claw back a credit already made | `test/leave-fixes.test.ts` |
| 4.2-L7 | Leave, Payroll | S2 | Unpaid leave counting non-working days over a weekly off: ledger debits 3 days, LOP 2 | Attendance dropped leave on off days | Attendance records it on the off day for unpaid types that count it, and LOP charges it. Attendance `CALC_VERSION` 5 | `test/payroll-fixes.test.ts` "sandwiched" |
| 4.2-L8 | Overtime | S3 | Comp-off for last December approved in January: credited to the new year | Year taken from approval date | Year of the work date, or the current year if that one is closed. Expiry is not implemented | `test/overtime.test.ts` "comp-off leave year" |
| 4.2-L9 | Leave | S3 | Cancelled comp-off: `used` shows 1 | Negative reversal counted as used | Only positive reversals net against consumption | `test/leave-fixes.test.ts` |
| 4.2-L10 | Leave | S2 | Leave manager adjusts their own balance | No self check | Refused | `test/leave-fixes.test.ts` |
| 4.2-E1 | Employees | S1 | `PATCH status=exited` with no exit date: payroll keeps paying, login stays active | `exit_date` not patchable; nothing ended access | Needs `exitDate`, sets it and ends access; leaving `exited` clears it | `test/employees.test.ts` "PATCH status guard" |
| D-1 | Cases | S2 | Assign the complainant of an anonymous grievance: error says "complainant" | Distinct error text per party | One message for complainant and respondent. Residual: a refusal still narrows a guesser to those two; attempts are not audited | `test/delegated-fixes.test.ts` |
| D-2 | Cases | S2 | Respondent holding `grievance.manage` or on the committee is notified of the case and its deadlines | No filter on respondent | Respondent's user removed from creation and deadline notices | `test/delegated-fixes.test.ts` |
| D-3 | Competency | S2 | `/competency/check` for an exited employee can say authorized | Employment not checked | Reason "no longer employed", so not authorized | `test/competency.test.ts` "exited staff" |
| D-4 | Recruitment | S2 | Hiring manager who did not author a requisition submits it; offer or hire on a held or cancelled requisition | Submit lacked the edit check; offer and hire ignored requisition status | Same ownership check; offer create, offer submit and hire need an approved requisition | `test/delegated-fixes.test.ts` |
| C-1 | HTTP | S3 | `?includeInactive=false`, `?unread=false`, `?exceptionsOnly=false`, `?inline=false`, `?includeRevoked=false` behave as true | `z.coerce.boolean` treats any non-empty string as true | `QueryBool` at all five sites: accepts true, false, 1, 0; anything else is 400 | `test/query-bool.test.ts` (three routes and the schema; `policies` and `competency` share the schema, not separately tested) |
| 4.2-A1 | Attendance | S3 | Punch at 23:50 for a shift starting 00:30: that work date is not recalculated until the next punch | `candidateDates` covered only the local date and the day before | The next day is included when its shift window already holds the punch | `test/attendance-fixes.test.ts` |

## Reviewed, not changed

| ID | Audit claim | Finding |
|---|---|---|
| 4.2-A2 | `channel:'web'` skips `mobile_location_mode='required'` | Confirmed by reading the route, not by a test: `channel` is client-chosen. No change, as it is a policy decision and not a defect in isolation: `attendance.web` is on, and web punches never carry location. A site that requires location should disable `attendance.web`. Binding `required` to every channel would break desktop clock-in, so the choice is the product owner's |
| 4.2-Lo1 | Recovery can take 100% of net pay | SUSPECTED in the audit. No cap added: it would mean inventing a statutory limit. Listed for a qualified reviewer in `INDIAN_PAYROLL_COMPLIANCE.md` |
| 4.2-Lo2 | F&F shortfall leaves a loan open, no write-off | A missing feature, not a wrong result. Not added |
| 4.2-Lo3, Lo4 | Salary below EMI; early closure | The audit marks both as working as designed. Agreed; F-13 removes the caveat on the second |
| 4.2-P6 | `duePeriod` skips a missed close day | See above: no change here, F-7 removes the money effect |
| Leave comp-off | No expiry, and year-end lapses comp-off under `carry_forward_max` | Policy, not a bug. Only the leave year was fixed (4.2-L8) |
| F-14 | Steps frozen at creation when a manager changes | Not re-routed automatically; reassign covers it |

## Audit findings outside this batch's brief, not done

Delegated: no decline path after an accepted offer (`recruitment/routes.ts:627`), anonymization leaving text behind (`:680`), `avg_rating` and blind feedback (`:260`), performance review blockers and goal revival, field duty overlap at approval and its exclusion constraint, travel `new Decimal` 500. Year-end as a scheduled job. TDS YTD true-up, declarations and marginal relief.

## Property-based tests

`test/property-payroll.test.ts`, `test/property-leave.test.ts`, `test/property-loans.test.ts` (fast-check, generated rules and salaries): totals reconcile with lines; every line a whole rupee; determinism; more paid days never lower gross; a split at the same rate stays within a rupee; ESI cover independent of paid days; one-off TDS bounded, twelve months approach the annual tax; twelve accrual credits equal the entitlement exactly; counted leave days stay in the span and move in halves; EMI covers the amount with under n rupees to spare; the schedule repays exactly the amount.

## Batch C: data policy

| ID | Module | Severity | Steps | Root cause | Fix | Test |
|---|---|---|---|---|---|---|
| C-01 | Salary hierarchy | High | HR with stored level 99 and the employee role reads a senior payroll person's salary | The ceiling took the maximum over all roles, and the employee role's default of 89 lifted HR past its 59. Found by the matrix on its first real run | Employee and manager roles set no ceiling | `permission-matrix.test.ts`, `management-modes.test.ts` |
| C-02 | Payroll | High | Release held pay after encryption | The guard trigger read `NEW.net`, a column the audit did not list as affected | Trigger replaced in `044`, check moved to the route | `payroll-fixes.test.ts` |

## Batch D: policy corrections and auth

| ID | Module | Severity | Steps | Root cause | Fix | Test |
|---|---|---|---|---|---|---|
| D-01 | Role grants | High | An administrator appoints a peer administrator; or removes a custom role from someone with a high stored level, lifting their ceiling above the actor | Only the role's floor was checked, with an exception for `tenant_admin` | Compare effective levels before and after, no exception. Nobody changes someone at or above them. Last owner protected, including in `endAccess` | `role-grants.test.ts` |
| D-02 | Overtime, field duty | Medium | Payroll or an auditor opens a claim and reads the reason; HR reads the reason of HR above them | The reason column was selected for anyone who could read the request, though classified L3 | `reasonVisibleSql`, same rule as leave | `l3-reasons.test.ts` |
| D-03 | Documents | Medium | A payroll manager or an auditor downloads an employee's non-restricted document | Both roles held `documents.read` from before L3 was defined | `documents.payroll` limited to payroll categories | `permission-matrix.test.ts`, `documents.test.ts` |
| D-04 | Audit | Medium | Reveal `payroll_cost`, export it, or open a scheduled copy; the log says a report was read and not whose pay | Aggregates wrote one row against the report; the export wrote only `reports.exported` | One row per subject, sealed with the snapshot for later reads | `permission-matrix.test.ts` |
| D-05 | Audit chain | High | Two transactions take the head and a row in opposite orders; or one transaction audits and stays open | The head lock was taken at insert and held to commit: `40P01` in the first case, every audited write of the tenant stopped in the second | Deferred trigger, lock taken inside `COMMIT` (`046`) | `audit-chain-concurrency.test.ts` |
| D-06 | Login | High | Send wrong passwords for a known email, from one address, and the owner is locked out for 15 minutes | Lockout and the rate limit counted per account only | Counted by who is failing (D44) | `sessions.test.ts` |
| D-07 | Login | Medium | Sign in repeatedly on one account: each attempt holds a row lock and a pool connection for the length of the hash | Password verified inside the transaction, with `FOR UPDATE` | Hash outside any transaction | `sessions.test.ts` |
| D-08 | MFA | Low | Five wrong codes end a session; sign in again for five more | The count was per session (SUSPECTED in the audit, confirmed) | Ten across sessions, then 15 minutes | `mfa.test.ts` |
| D-09 | Notifications | Medium | Turn off email notifications, and security notices stop too | The opt-out applied to every kind | `security.*` ignores it, and the footer says so | `notifications.test.ts`, `links-and-notices.test.ts` |
| D-10 | MFA | Low | An administrator resets someone's MFA and the person is not told | Noted in the audit | They get `security.mfa_disabled` | `mfa.test.ts` |
| E7-1 | Reports, retention | S3 | Turn `FEATURE_REPORTS_ADVANCED` off with scheduled copies stored; pass their expiry: sealed copies with L4 stay indefinitely | The purge lived in `reports.scheduled`, which is not a retention job and stops with its module | `retention.operational` removes expired copies whatever the flag | `data-rights.test.ts`: report copies past their date |
| E7-2 | Jobs | no change | AUDIT said the retention job skips when modules are off | Out of date: `jobActive` and `runQueued` both let `retention` jobs through, since batch B. Scheduled, retry and queued paths agree | Not a bug now. Proved by the data being gone in all three | `data-rights.test.ts`: with every module off |
| E7-3 | Recruitment | S3 | With no storage configured, a candidate's retention or erasure passes: the record says no resume, and the file stays | `getStore()?.delete` skipped the delete and the key was cleared anyway | Stops with 503; the job fails on the record and retries, as the selfie job does | `data-rights.test.ts`: a resume with no store |

## Batch E

| ID | Module | Sev | Steps to reproduce | Root cause | Fix | Test |
|---|---|---|---|---|---|---|
| E-1 | Settings | Medium | Two administrators save the first value of a setting at the same moment: one gets 409 | `SELECT ... FOR UPDATE` finds no row to wait on, so both insert and `tenant_settings_uq` refuses the second | Insert with `ON CONFLICT ... DO UPDATE`, counted as a version on top of the first | `backend-gaps.test.ts` |
| E-2 | Sessions | Medium | Leave a tab open: the 60-second unread-count poll keeps the session from ever idling out | Every request moved `last_seen_at` | `GET /notifications/unread-count` is passive: checked against the idle limit, without moving it | `backend-gaps.test.ts` |
| E-3 | Loans | High | A `loans.manage` holder defers their own recovery through the API | Only the UI hid the button; disburse and repayment had the check, defer did not | Same refusal in the route; the owner in a collapsed mode stays allowed | `backend-gaps.test.ts` |
| E-4 | Tests | Low | `permission-matrix` failed once in a full run with `leaks` true | A problem's random `instance` could spell a subject's short figure | `leaks` ignores `urn:uuid:` references | `permission-matrix.test.ts` |
| E-5 | Tests | Low | `notifications` failed when run after files that leave mail in the outbox | The outbox is shared by every test organization | Assertion reads this organization's mail | `notifications.test.ts` |

## Batch F: abuse, contract, load

Every row was reproduced by a failing test over real HTTP first. Severity is the one in `SECURITY_REPORT.md`, which adds CVSS vectors. F-101 to F-118 began as hypotheses from reading the routes and were then attacked; one that did not reproduce is not here, and F-119 onward came from the suites, the scanners and k6.

| ID | Module | Sev | Steps to reproduce | Root cause | Fix | Test |
|---|---|---|---|---|---|---|
| F-101 | Payroll | High | Payroll staff add a ₹50,000 earning to their own pay, then compute and submit. An approver at or below their level sees only a count. Also: change their own statutory record, remove a deduction someone put on them | `assertMayChangeSubject` let your own id through, though its comment said never; `DELETE` had no subject check | Refused for your own record except the owner in a collapsed mode (D62); `DELETE` uses it | `test/security/privilege-abuse.test.ts` |
| F-102 | Approvals | High | HR: `POST /approvals/delegations {delegatorId:<approver>,delegateId:<self>}`, then decide. Or reassign to someone who already delegates to you | `actingRole` accepts a delegate; the "taking it yourself" guard looked only at the direct target | Naming yourself for someone else is 403; reassigning to someone who delegates to you is 400 | `test/security/privilege-abuse.test.ts` |
| F-103 | Users | High | IT: `POST /tenant/users {email:<own>,employeeId:<record with no login>}`, accept, read pay and bank as self | Linking a login needs only `users.manage`, and self passes every level check | The address must be the record's, or the actor outranks the person (D63) | `test/security/privilege-abuse.test.ts` |
| F-104 | Employees | High | HR executive: `PATCH /employees/:id {status:exited}` on a finance manager ends their login. Or makes themselves that person's manager, or picks their own | Level check only on L3 fields | Status and manager need rank; never your own (D62) | `test/security/privilege-abuse.test.ts` |
| F-105 | Users | Medium | IT changes a payroll manager's salary level | `assertMayManage` not called on this route | Called | `test/security/privilege-abuse.test.ts` |
| F-106 | Users | Low | IT unlocks the owner's sign-in back-off | `unlock` skipped `assertBelowActor` | Included | `test/security/privilege-abuse.test.ts` |
| F-107 | Lifecycle | Medium | An auditor reads anyone's separation reason, F&F note and exit interview; a manager reads the reason after it is decided | `s.*` with no L3 rule | Masked: self, HR above them, who decides while pending | `test/security/privilege-abuse.test.ts` |
| F-108 | Lifecycle | Medium | An auditor overwrites an exit interview | `lifecycle.read` counted as HR for a write | Needs `lifecycle.manage` or being the person | `test/security/privilege-abuse.test.ts` |
| F-109 | Lifecycle | High | HR starts a termination of someone above them; a second HR approves; login ends | No level check | `assertOutranks`, 404 | `test/security/privilege-abuse.test.ts` |
| F-110 | Lifecycle | Medium | A leaver with `lifecycle.manage` marks their own HR tasks done, which clears them for exit | `canActOnTask` did not look at whose checklist | Your own checklist: employee tasks only | `test/security/privilege-abuse.test.ts` |
| F-111 | Loans | Medium | `loans.manage` creates, cancels or defers a loan of someone above them; `repayment` bounds a masked balance | `loadLoan` admitted creator and team; no level check on writes | `assertMayChangeSubject` on all five writes | `test/security/privilege-abuse.test.ts` |
| F-112 | Loans | Medium | A manager reads `installments`, `first_period`, references and cancel reason of a team loan | `LOAN_FIELDS` left out L4 columns | Masked | `test/security/privilege-abuse.test.ts` |
| F-113 | Documents | Medium | `documents.manage` archives a restricted or senior document, or plants a file on a senior's record | Writes had no level or restricted check | 404 | `test/security/privilege-abuse.test.ts` |
| F-114 | Leave | Medium | Holder of `leave.read` and `leave.team.read`: `?scope=team&employeeId=<anyone>&status=pending` shows the reason | `employeeId` replaced the team list while the reason rule still read scope | The rule reads the team itself | `test/security/privilege-abuse.test.ts` |
| F-115 | Employees | Medium | `POST /employees/import {dryRun:true}` with guesses: "Same name and date of birth as…" confirms the L3 value of someone above | `findDuplicates` compared all rows | Phone and birth date compared only within L3 reach | `test/security/privilege-abuse.test.ts` |
| F-116 | Employees | Medium | `GET /employees/:id/history` shows `leave.balance_adjusted` metadata with its reason | All audit metadata returned to `employees.read` | Other modules' metadata needs L3 reach; unknown id 404 | `test/security/privilege-abuse.test.ts` |
| F-117 | Auth | Medium | Change your password; a reset link already in the mailbox still resets it | Only the link used was burned | All open links end at any password change or finished link | `test/security/privilege-abuse.test.ts` |
| F-118 | Performance | Low | With no reviewing manager, one HR person writes the review and finalizes it | "Different person" looked at the role, not who wrote it | `manager_submitted_by` (migration 052) | `test/security/privilege-abuse.test.ts` |
| F-119 | HTTP | Low | `GET /employees?search=a%00b`, or a travel `estimate` of `abc`: 500 | PostgreSQL class 22 not mapped; `new Decimal` throws in validation | 400 `invalid_value`; money parsed safely | `test/security/injection.test.ts` |
| F-120 | Uploads | Medium | Upload a PDF with `/J#61vaScript` | The check read the bytes, and a PDF name may spell characters as `#xx` | Names decoded before checking | `test/security/files-exports.test.ts` |
| F-121 | Uploads | Medium | Upload a macro workbook named .xlsx | Only the extension and part names were read | `vbaProject.bin` refused | `test/security/files-exports.test.ts` |
| F-122 | Exports | High | Account holder holding CR LF and a row: the reimbursement bank file gains a payment row | Two local CSV writers, weaker than `csvCell` | One writer everywhere | `test/security/files-exports.test.ts` |
| F-123 | Exports | Medium | A cell of ` =1+1`, `\n=1+1`, `＝1+1`, or `a;=1+1` in a semicolon locale | Guard looked at the first character, of six | White space and full-width forms neutralized, `;` quoted | `test/security/files-exports.test.ts` |
| F-124 | Crypto | Low | Shorten a sealed value's GCM tag to 4 bytes: it still opens. Needs write access to the database. Found by Semgrep | `createDecipheriv` without `authTagLength` | 16 bytes required | `test/security/files-exports.test.ts` |
| F-125 | HTTP | Medium | Revealed salary JSON has no `Cache-Control` | Only files set it | `no-store` by default (D64) | `test/security/flags-headers.test.ts` |
| F-126 | Roles | Low | A custom role holding `payroll.read` while payroll is off grants it the day the flag comes on | Known-permission check only | Refused while the module is off | `test/security/flags-headers.test.ts` |
| F-127 | Attendance | High | Found by k6. Fifteen people clock in within a minute from one office address: three get 429 | Punch limit of 12 a minute counted per address | Counted per person | `test/security/shared-address.test.ts` |
| F-128 | HTTP | High | Found by k6. An office where people together pass `RATE_LIMIT_PER_MINUTE`, default 3000: everyone gets 429 | Global limit per address | Per person when signed in; sign-in and exports stay per address | `test/security/shared-address.test.ts` |
| F-129 | OpenAPI | Medium | A generated client types `amount` on `GET /loans/requests` as always a string; masked it is null. Eight more routes likewise | Schemas were generated from what tests saw, and tests rarely saw the masked or empty shape | Corrected, and a test walks every GET per persona | `test/contract/live-responses.test.ts` |
| F-130 | CI | Medium | `openapi.json` was git-ignored although the frontend generates from it. CI ran on Node 22, where `crypto.argon2` does not exist | Reusable workflow's default | Committed, compared in CI and in a test; `node-version: 24` | `test/contract/openapi-drift.test.ts` |

### Load

k6 v2.3.0, `load/mixed.js`, `load/seed.ts`: 1000 employees of the demo generator, each with a login and a ready session, on its own database. **This is a MacBook Air (8 cores, 8 GB) with PostgreSQL's default `shared_buffers` of 128 MB, one Node process, k6 on the same machine, and a frontend agent and a deployment agent working at the same time. It is not production sizing and it does not predict one.** It finds what breaks first and what is out of proportion.

Mix: 85% reads (unread count, session, dashboard, attendance, balances, leave, directory search, inbox), 15% writes (punch, leave request then cancel, read-all), one person in twenty doing HR lists and reports, 1 to 3 seconds between actions, and a steady few real sign-ins. Ramp 30 s, hold 2 min, ramp down 15 s. Times in ms.

| Users | Req/s | Requests | Read: median / p95 / max | Write: median / p95 / max | HR p95 | Sign-in p95 | Failed | Thresholds |
|---|---|---|---|---|---|---|---|---|
| 100 | 46 | 7622 | 4 / 15 / 107 | 8 / 24 / 148 | 68 | 205 | 0% | p95 read under 300, write under 600: **pass** |
| 1000 | 445 | 74620 | 3 / 9 / 644 | 5 / 14 / 670 | 66 | 215 | 0% | p95 read under 1500, write under 2500: **pass** |

Without pauses (`THINK=0`), 100 users saturate this one process at about 698 requests a second, read p95 169 ms. That is the ceiling of a single Node process here. Rate-limit refusals are expected in that run, since nobody punches that fast.

**Three runs at 1000 users that tell the rest of the story.** The table is the best of the batch's clean runs, after the fixes. Before the inbox fix, with the machine similarly quiet: read p95 202 ms, write 217 ms, max about 2 s. With the inbox fix, while another agent's test suite and a Colima VM drove the machine's load average to 28: read p95 9,393 ms, write 10,080 ms, sign-in 16,650 ms, 129 requests a second, and the thresholds **failed**. So the same code on the same machine ranges over three orders of magnitude depending on what else runs. Nothing here can say how close production is to that edge. A deployment needs its own run.


`attendance.close_day` at 999 employees, `load/close-day.ts`, on the same seeded data: 11 statements each, not the 8 D60 estimated, 11,005 in all, 1.3 s total in one transaction, p95 1.5 ms per person. **Left as is:** a nightly job of about a second at this size is not worth rewriting the engine's data access for. `POST /attendance/recalculate` is the same loop per person per date. At 10,000 employees the same cost would be about 13 seconds holding a transaction; look again there.

Bottlenecks found and fixed: F-127 and F-128, the per-address limits, which refused an office; and every inbox joining all pending requests (33 ms at 7,000 pending, now picked by step first).

Not measured: more than one process, a real network, PDF generation, payroll compute, read replicas, sustained hours.

### Reviewed, not exploitable

| Area | Why |
|---|---|
| JWT | There are none (D5). A token is random, hashed at rest, and looked up. Forged and `alg:none` tokens are tested anyway |
| SQL injection | Parameters only, and `test/security/injection.test.ts` puts hostile values in every field of the document. Semgrep agrees |
| NoSQL operators | No such store, and an object where a string belongs fails zod |
| Prototype pollution | Fastify refuses `__proto__` and `constructor` in JSON. Tested |
| SSRF | No setting or module fetches what a client sends. The only fetches are push, an allow-list with redirects refused, and telemetry, set by the deployment. A test lists them |
| XLSX formulas | Text is always an inline string, with no `<f>`. Tested |
| Stored XSS | Stored as typed, by design: the API answers JSON under `default-src 'none'`, `nosniff`, and mail escapes. Whether the frontend escapes is the frontend's to test |
| Path traversal | Keys are generated and validated, brand files come from a map built at start. Tested |

### Accepted

See A-1 to A-5 in `SECURITY_REPORT.md`.
