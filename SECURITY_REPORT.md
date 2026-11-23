# Security report

Batch F, 2026-11-05, on a laptop against local PostgreSQL 17. Scores are CVSS v3.1 base scores, worked out from the vector. They rate each finding as it stood before its fix, and assume the attacker holds what the vector's `PR` says. This is the project's own testing: nobody outside has tested it, and that is still owed before go-live.

## Summary

Fixed: 30 (critical 0, high 2, medium 20, low 8). Accepted: 5, with reasons below.

No finding let an outsider in, or crossed organizations. Almost all need a valid session: most are staff going past what their level allows, which is the attacker this system expects most (`docs/THREAT_MODEL.md`).

## Findings

| ID | Finding | CVSS v3.1 | Score | Severity | Status | Evidence | Test |
|---|---|---|---|---|---|---|---|
| F-102 | HR decides approvals they hold no permission for, by delegating them to themselves or reassigning to someone who delegates to them | `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:H/A:N` | 7.1 | High | fixed | `POST /approvals/delegations {delegatorId:<approver>,delegateId:<self>}`, then `/approvals/:id/act` | `test/security/privilege-abuse.test.ts` |
| F-104 | HR changes status or reporting manager of someone at or above them, or their own manager | `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:L` | 7.1 | High | fixed | `PATCH /employees/:id {changes:{status:"exited"},exitDate,...}` ends the login of a finance manager | `test/security/privilege-abuse.test.ts` |
| F-127 | Punch limit counted per address: an office past the twelfth person in a minute gets 429 | `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:H` | 6.5 | Medium | fixed | k6 at 100 users: 8% failures, all 429 on `/attendance/punch` | `test/security/shared-address.test.ts` |
| F-128 | Global limit counted per address: a large office shares one budget | `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:H` | 6.5 | Medium | fixed | `RATE_LIMIT_PER_MINUTE` 3000 against ~500 requests a second from one address | `test/security/shared-address.test.ts` |
| F-109 | HR starts a termination of someone at or above their level | `CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:U/C:N/I:H/A:N` | 5.7 | Medium | fixed | `POST /lifecycle/separations {employeeId:<senior>,kind:"termination",...}`, then a second HR approves | `test/security/privilege-abuse.test.ts` |
| F-103 | A login attached to someone else's employee record gives their pay and bank details as "self" | `CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:L/A:N` | 5.5 | Medium | fixed | An IT administrator creates a login at their own address on a record with no login, then reads salary, payslips and bank with `?reveal=1` | `test/security/privilege-abuse.test.ts` |
| F-117 | A reset or invitation link survives a password change | `CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:L/I:L/A:N` | 5.4 | Medium | fixed | A link taken from a mailbox is used after the victim changed their password | `test/security/privilege-abuse.test.ts` |
| F-123 | CSV formula guard missed line feed, leading white space, full-width forms; semicolon not quoted | `CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:U/C:L/I:L/A:N` | 4.6 | Medium | fixed | A name of ` =HYPERLINK(...)` in an export | `test/security/files-exports.test.ts` |
| F-120 | PDF active-content check defeated by hex-escaped names | `CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:U/C:L/I:L/A:N` | 4.6 | Medium | fixed | Upload a PDF with `/J#61vaScript` | `test/security/files-exports.test.ts` |
| F-121 | Office files with macros accepted when named .docx or .xlsx | `CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:U/C:L/I:L/A:N` | 4.6 | Medium | fixed | Upload a macro-enabled workbook named .xlsx | `test/security/files-exports.test.ts` |
| F-101 | Payroll staff add adjustments to their own pay and change their own statutory record | `CVSS:3.1/AV:N/AC:L/PR:H/UI:R/S:U/C:N/I:H/A:N` | 4.5 | Medium | fixed | `POST /payroll/runs/:id/adjustments {employeeId:<own>,...}`; an approver at or below their level sees only a count | `test/security/privilege-abuse.test.ts` |
| F-122 | Reimbursement bank file and journal CSV had their own weaker writers: a line break forges a payment row | `CVSS:3.1/AV:N/AC:L/PR:H/UI:R/S:U/C:N/I:H/A:N` | 4.5 | Medium | fixed | Account holder holding CR LF and a row, approved, then `GET /expenses/batches/:id/export.csv` | `test/security/files-exports.test.ts` |
| F-107 | Separation reason, F&F note and exit interview readable by an auditor or a manager regardless of level or status | `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N` | 4.3 | Medium | fixed | `GET /lifecycle/separations/:id` as auditor | `test/security/privilege-abuse.test.ts` |
| F-108 | A read-only `lifecycle.read` holder overwrites an exit interview | `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:N` | 4.3 | Medium | fixed | `POST /lifecycle/separations/:id/exit-interview` as auditor | `test/security/privilege-abuse.test.ts` |
| F-110 | Someone leaving clears their own HR, IT or finance exit tasks | `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:N` | 4.3 | Medium | fixed | `POST /lifecycle/tasks/:id/done` on their own checklist | `test/security/privilege-abuse.test.ts` |
| F-112 | Loan columns classified L4 returned unmasked: instalments, first period, skipped periods, references, cancel reason | `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N` | 4.3 | Medium | fixed | `GET /loans/requests?scope=team` as a manager | `test/security/privilege-abuse.test.ts` |
| F-113 | `documents.manage` archives or plants a document on someone above them; a restricted one without the permission | `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:N` | 4.3 | Medium | fixed | `POST /documents/:id/archive` | `test/security/privilege-abuse.test.ts` |
| F-114 | A holder of `leave.read` and `leave.team.read` reads the pending leave reason of anyone by naming them | `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N` | 4.3 | Medium | fixed | `GET /leave/requests?scope=team&employeeId=<anyone>&status=pending` | `test/security/privilege-abuse.test.ts` |
| F-115 | Duplicate warnings confirm the date of birth or phone of someone above the viewer | `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N` | 4.3 | Medium | fixed | `POST /employees/import {dryRun:true,rows:[...]}` with guesses | `test/security/privilege-abuse.test.ts` |
| F-116 | Employee history shows other modules' audit metadata, with reasons, to any `employees.read` holder | `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N` | 4.3 | Medium | fixed | `GET /employees/:id/history` | `test/security/privilege-abuse.test.ts` |
| F-118 | With no reviewing manager, one HR person writes and finalizes a rating | `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:N` | 4.3 | Medium | fixed | `POST /performance/reviews/:id/manager`, then `/finalize` | `test/security/privilege-abuse.test.ts` |
| F-119 | A NUL byte in text, or a non-numeric money string, answered 500 | `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:L` | 4.3 | Medium | fixed | `GET /employees?search=a%00b` | `test/security/injection.test.ts` |
| F-111 | `loans.manage` creates, cancels, defers or records repayment on a loan of someone above them; repayment bounds the masked balance | `CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:L/I:L/A:N` | 3.8 | Low | fixed | `POST /loans/requests {employeeId:<senior>,...}`, `/requests/:id/defer`, `/cancel` | `test/security/privilege-abuse.test.ts` |
| F-105 | The salary-level route ignores the limit the rest of user management applies | `CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:L/I:L/A:N` | 3.8 | Low | fixed | IT administrator: `PUT /tenant/users/:id/salary-level` on a payroll manager | `test/security/privilege-abuse.test.ts` |
| F-125 | Personal API answers carried no `Cache-Control`, so a browser or proxy could keep them | `CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N` | 3.3 | Low | fixed | `curl -i /api/v1/payroll/employees/:id/salaries?reveal=1` | `test/security/flags-headers.test.ts` |
| CI-1 | Recovery codes reduced a random byte modulo 31, so 8 letters were 9/8 as likely as the other 23. About 59.43 bits in place of 59.45, and it takes a password first | `CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:U/C:L/I:N/A:N` | 3.1 | Low | fixed | CodeQL `js/biased-cryptographic-random`, `src/core/auth/totp.ts` | `test/totp-recovery-codes.test.ts` |
| F-106 | Unlock on an account above the actor clears its sign-in back-off | `CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:N/I:L/A:N` | 2.7 | Low | fixed | `PATCH /tenant/users/:ownerId {unlock:true}` | `test/security/privilege-abuse.test.ts` |
| F-126 | A custom role could hold permissions of a module that is off, and grant them the day it comes on | `CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:L/I:N/A:N` | 2.7 | Low | fixed | `POST /tenant/roles {permissions:["payroll.read"]}` | `test/security/flags-headers.test.ts` |
| F-124 | AES-GCM decryption accepted a shortened tag. Needs write access to the database to use | `CVSS:3.1/AV:N/AC:H/PR:H/UI:N/S:U/C:N/I:L/A:N` | 2.2 | Low | fixed | Semgrep `gcm-no-tag-length`; truncate the tag of a sealed value | `test/security/files-exports.test.ts` |
| CI-2 | Static and brand files were checked by name, then read by name, at startup. Needs write access to the mount, which could replace the file anyway, so the gap gave nothing more | `CVSS:3.1/AV:L/AC:H/PR:H/UI:N/S:U/C:L/I:N/A:N` | 1.9 | Low | fixed | CodeQL `js/file-system-race`, `src/core/http/web.ts` | `test/web-file-race.test.ts` |
| A-4 | Rate limits are per process, so N replicas allow N times the number | `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L` | 5.3 | Medium | accepted | D27. The database back-off holds across replicas | `test/rate-limit.test.ts` |
| A-1 | Travel advance amounts are L3 by classification and shown to whoever approves or pays them, whatever their level | `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N` | 4.3 | Medium | accepted | Deciding and paying need the figure, and it is not pay. `GET /travel/requests?scope=all` | `code: src/modules/travel/routes.ts` |
| A-2 | One HR holder can route a stuck approval to an accomplice | `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:N` | 4.3 | Medium | accepted | Needs two people; audited and announced to the assignee (F-14). `POST /approvals/:id/reassign` | `test/approval-fixes.test.ts` |
| A-5 | A PDF can hide active content inside a compressed object stream | `CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:U/C:L/I:N/A:N` | 3.5 | Low | accepted | The check does not decompress. Downloads are attachments, and clamd sees the file | `test/security/files-exports.test.ts` |
| A-3 | Candidate expected CTC reaches a `data_rights.execute` holder without `recruitment.compensation` | `CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:L/I:N/A:N` | 2.7 | Low | accepted | A rights export has to be complete. Written as `data_rights.exported`. `GET /tenant/data-rights/candidates/:id/export` | `code: src/modules/data-rights/routes.ts` |

Severity here is the CVSS rating. `QA_REPORT.md` rates by business effect, so F-101 and F-122, which can move money, are High there and Medium here: their vector needs a privileged actor and a second person's click.

## Scanners

Each was run here on this date. Counts are after the fixes. Reports are in `reports/`, which is not committed.

| Tool | Command | Result |
|---|---|---|
| npm audit | `npm audit --omit=dev --json` | critical 0, high 0, moderate 0, low 0 |
| Gitleaks 8.30.1 | `gitleaks git .`, whole history | 0 leaks in the history. `gitleaks dir` on the tree: 0, leaving out `load/.sessions.json`, the git-ignored output of the load seed |
| Semgrep 1.183.0 | `semgrep scan --config p/owasp-top-ten --config p/nodejs --config p/typescript --metrics off src scripts docker migrations` | error 1, warning 0, info 0. The one was F-124, fixed: a second run gives 0 on 255 files |
| Trivy fs | `trivy fs --scanners vuln,secret,misconfig .` | critical 0, high 0, medium 0, low 0 |
| Trivy image | `trivy image --scanners vuln,secret,misconfig hrms-backend:batch-f` | critical 0, high 0, medium 0, low 0. Alpine 3.24.3 |
| SBOM | `trivy image --format cyclonedx`, `trivy fs --format cyclonedx` | CycloneDX 1.7: 155 components in the image, 128 in the repository. CI attaches one per image |
| ZAP baseline | `zap-baseline.py -t http://load.test:4100/api/v1/config/public -c rules.tsv` | high 0, medium 0, low 0, informational 3. 67 rules passed, one ignored (`10049`: non-storable content is intended) |
| ZAP authenticated | ZAP automation framework: OpenAPI import, active scan as an HR session, 296 paths, excluding routes that would end its own session | high 1, medium 0, low 0, informational 0. The one high is a false positive, below. No 5xx logged by the server |
| CodeQL | CI only, `.github/workflows/security.yml` | First run gave CI-1 and CI-2, both fixed. It cannot run locally, so the fixes are not yet confirmed by a run |

**The image scan was of a copy.** The machine has no `docker buildx`, so the image was built with the legacy builder, from a copy of the Dockerfile without its two BuildKit-only flags (`RUN --mount` for the npm cache, `COPY --chmod`, replaced by `chmod`). The layers are otherwise the same. CI builds the real Dockerfile. No workflow has run on GitHub yet.

**The ZAP alert.** `High (Low confidence): Path Traversal`, on `GET /attendance/regularizations?status=regularizations`. A false positive, checked by hand: ZAP saw the same answer for a value that looks like a path element, because `status` is a plain equality filter in a parameterized query. `status=../../etc/passwd` answers the same empty list, and nothing touches a file. The first attempt at this scan ran its 21 minutes with `UserAgentScanRule` on, which raised 5,316 informational alerts, and then ZAP's script failed before writing a report; the run reported here leaves that one rule off. The server logged no error, 5xx included, in either scan.

**Bugs of this batch that scanners would not have found.** All of F-101 to F-118 need two accounts and knowledge of the rules. Semgrep found one (F-124), ZAP none. Scanners are a floor.


## Accepted, and why

| ID | Why |
|---|---|
| A-4 | D27. The database back-off holds across replicas |
| A-1 | Deciding and paying need the figure, and it is not pay. `GET /travel/requests?scope=all` |
| A-2 | Needs two people; audited and announced to the assignee (F-14). `POST /approvals/:id/reassign` |
| A-5 | The check does not decompress. Downloads are attachments, and clamd sees the file |
| A-3 | A rights export has to be complete. Written as `data_rights.exported`. `GET /tenant/data-rights/candidates/:id/export` |

## Not covered

- CodeQL on the fixes for CI-1 and CI-2, until the next push.
- An external penetration test.
- The frontend's handling of stored text. The API stores and returns it as typed.
- A running clamd against real malware samples: covered by `uploads.test.ts` against a fake server speaking the protocol.
