# Recruitment

Module key: `recruitment`, flag `FEATURE_RECRUITMENT` (off by default). Resumes use the installation's file storage.

## Flow

1. **Requisition.** A manager (`recruitment.requisition`) requests headcount: title, legal entity, branch, department, designation, employment type, positions, justification, hiring manager and target date. HR (`recruitment.compensation`) can set a per-position annual CTC budget. On **submit**, the request goes to holders of `recruitment.approve` through the approval inbox; the requester can never approve their own. A requisition is `approved` (open), `on_hold`, `closed` (automatically when every position is filled) or `cancelled`.
2. **Candidate.** HR records contact details, experience, qualification and source (referral, job portal, agency, campus, …), plus an optional resume, which HR can add or replace later (`PUT /candidates/:id/resume`; the replaced file is deleted from storage). Resumes are checked by content: PDF, DOCX or images; executables and scripted PDFs are refused.
   - **Consent is mandatory**, and so is a note saying how it was obtained.
   - **Retention:** a date is set when the candidate is added (setting `recruitment.retention_months`, default 12).
   - **Duplicates:** the same email is always refused (409, with the existing candidate). A shared phone number can be confirmed as a different person.
3. **Pipeline.** An application links a candidate to an approved requisition and moves `applied → screening → interview → offer`, or to `rejected` (a reason is required) or `withdrawn`. Every move is kept in the stage history, and moves use optimistic locking. Reaching **hired** is only possible through an accepted offer.
4. **Interviews.** An interview has a round, a kind (phone, technical, practical/lab, HR, panel), a time, a place or link, and a panel of users, who are notified.
   - Panel members see only the interviews they are on, the candidate summary and the resume. They don't see stage history or offers.
   - **Feedback is blind:** colleagues' ratings stay hidden until you submit your own.
   - Feedback is a 1–5 rating, a recommendation and notes. It opens when the interview starts and is submitted once.
   - The interview completes when the whole panel has submitted.
5. **Offer.** The offer covers designation, entity, branch, department, employment type, **annual CTC**, joining date, probation and contract end. Drafting needs `recruitment.manage` plus `recruitment.compensation`.
   - An offer above the requisition budget is **flagged**, not blocked.
   - On submit, it is approved by `recruitment.approve`, never by the requester. The approval summary, which also goes into notifications and email, contains **no compensation figures**.
   - Status flow: `draft → pending → approved → sent → accepted | declined`, or `withdrawn`. One live offer per application.
6. **Hire.** An accepted offer creates the employee record (`recruitment.manage` + `employees.manage`) with the normal employee validation and duplicate checks.
   - The record is created with status **`pre_joining`**. Reporting manager = the hiring manager; probation end = joining date + probation months.
   - The application becomes `hired`, the requisition's filled count goes up, and the requisition closes when full. Hiring happens once per offer.

## Personal data (DPDP Act)

| Control | Where |
|---|---|
| Consent recorded with time and method before any processing | candidate create |
| Compensation (budget, expected and offered CTC) visible only with `recruitment.compensation` | all reads |
| Resume downloads audited; integrity-checked (SHA-256) | resume download |
| Daily job `recruitment.retention` (04:00): candidates past their retention date, not hired, not in an open process → personal fields cleared, resume **deleted from storage**, interview notes cleared, row kept (anonymized) for pipeline statistics; audited as `system` | job |
| Erasure on request: *anonymize* (refused while an offer is live) | `POST /candidates/:id/anonymize` |
| Hired candidates keep their data in the employee record | — |

The legal assessment (lawful basis, notice text, retention period, cross-border transfers of resumes) is the organization's. The module records the evidence; it does not decide.

## Permissions

| Permission | Default roles |
|---|---|
| `recruitment.requisition` | reporting manager, department head, laboratory manager, HR |
| `recruitment.read` | HR administrator, HR executive, hiring approver, auditor |
| `recruitment.manage` | HR administrator, HR executive |
| `recruitment.approve` | HR administrator, hiring approver |
| `recruitment.compensation` | HR administrator, hiring approver, finance manager |

The **Hiring Approver** role is management sign-off, for example the laboratory director. It can approve requisitions and offers and see compensation, but cannot change candidates or the pipeline. Give it to someone besides HR. Otherwise an organization with a single HR administrator cannot approve offers, because nobody approves their own request.

Hiring managers see their own requisitions and the pipeline of those requisitions. Interviewers see their interviews. No special permission is needed for either.

## Not included

Careers page and candidate self-service, email to candidates, job-board posting, offer-letter generation and e-signature, background verification, onboarding checklists (next), and agency portals.
