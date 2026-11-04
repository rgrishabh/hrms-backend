# Policy management and acknowledgements

Module key: `core.policies`, flag `FEATURE_POLICIES` (off by default). Policy text works without file storage. Attaching a PDF needs storage (`STORAGE_DRIVER`).

## Flow

1. **Create the policy** (`policies.manage`): code, title, category (HR, code of conduct, POSH, health & safety, quality, IT security, data protection, other), owner.
2. **Draft a version** (`policies.manage`): what changed, effective date, the policy text and/or a PDF (checked by content; PDFs with scripts or embedded files are refused), whether acknowledgement is required and within how many days, and optionally an **audience** limited to branches and/or departments (none selected = everyone). One draft per policy at a time.
3. **Publish** (`policies.publish`) by **someone other than the author** (API check and database CHECK). Publishing supersedes the previous version and notifies everyone in the audience in-app (and by email when `notifications.email` is on).
4. **Employees** see their current policies under *Policies* and on the dashboard, open the text or PDF, tick "I have read and understood…" and **Acknowledge**.
5. **Reports** per version: acknowledged / not yet, with CSV or Excel export (audited). The daily job `policies.ack_reminder` (10:00) reminds each overdue employee once a week.
6. **Withdraw** a version or **retire** a policy (`policies.publish`, reason required). History and acknowledgements are kept.

## What an acknowledgement proves

Each acknowledgement stores the employee, user, time, IP, browser and a **SHA-256 of the exact content** (text + PDF hash) of the version shown. The browser sends back the hash it displayed. If a newer version was published meanwhile, or the content differs, the acknowledgement is refused and the employee is asked to reload. Acknowledgements cannot be changed or deleted by the application (database grants). A new version always needs a new acknowledgement.

Audience is evaluated **now**: an employee who moves into a department starts seeing that department's current policies; someone who leaves the audience drops out of the pending report, but their past acknowledgements remain.

## Permissions

| Permission | Default roles |
|---|---|
| `policies.self` | everyone |
| `policies.read` (all policies, drafts, reports) | HR administrator, HR executive, quality manager, administrator, auditor |
| `policies.manage` (create, draft) | HR administrator, HR executive, quality manager |
| `policies.publish` (publish, withdraw, retire) | HR administrator, quality manager, administrator |

## Not included / to verify

- No rich-text editor; the text is plain. Use the PDF for formatted, signed copies.
- Electronic acknowledgement is a record that the employee confirmed reading. Whether it is sufficient for a given legal purpose (e.g. a POSH policy, standing orders) is for the organization's legal adviser.
- No quizzes, e-signatures or blocking sign-in until acknowledged.
- Seeded demo policies are placeholder text and must not be used as real policies.
