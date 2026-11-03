# POSH complaints and grievances

Modules: `posh` and `grievance` (not in `default`). Narrative fields (description, respondent details, notes, outcome, reasons) are **encrypted** with the installation's field key. Audit entries record who did what and when, never the narrative. Notifications and emails carry only the case reference.

## POSH (Sexual Harassment of Women at Workplace Act, 2013)

- **Internal Committee:**
  - `posh.admin` (administrator, HR administrator) maintains the IC: one presiding officer, members, and external member(s) from an NGO or association.
  - **Maintaining the IC gives no access to complaints.** Everyone can see the composition, which the Act requires to be displayed.
  - The Act's composition rules (presiding officer a woman at senior level; at least half the members women) can't be checked by software. The organization confirms them.
- **Filing:**
  - Any employee can file; complaints can't be anonymous, because the IC must be able to inquire.
  - More than ~3 months after the incident, a reason for the delay is required, so the IC can consider extending the limit.
  - Filing is refused when no IC exists, and the complainant is pointed to the Local Committee.
- **Access:** only IC members and the complainant can open a complaint. HR, administrators, auditors and the respondent can't. An IC member who is a party (complainant or respondent) is excluded from that case.
- **Workflow:**
  - Statuses: `received → conciliation | inquiry → report_submitted → closed` (closing requires the outcome/recommendations), or `withdrawn` by the complainant.
  - Notes can be internal or shared with the complainant. The complainant sees shared updates attributed to "Internal Committee".
- **Timelines:**
  - The inquiry is due 90 days after receipt; the report is due 10 days after the inquiry ends.
  - The daily job `cases.deadlines` (09:00) reminds the IC 7 days before, on the day, and weekly when overdue.
- **Annual report counts** (received, disposed, pending, pending beyond 90 days) are available to IC members and `posh.admin`, with no names.

## Grievances

- **Filing:** any employee can raise one, optionally **anonymously**. The name is never shown; the system keeps who filed it only so they can follow the case.
- **Handling:** `grievance.manage` (HR administrator) holders see all grievances and assign a handler, who then sees that grievance. The complainant and the named respondent can't be assigned.
- **Workflow:**
  - Statuses: `open → in_progress → resolved → closed`. The complainant can **reopen** a resolved grievance, comment, or withdraw.
  - Every change is version-checked, so concurrent edits are refused.
- **Response target:** `grievance.response_days` (default 15). Overdue grievances remind the handler weekly.

## Not included

Hearing scheduling and minutes templates, evidence attachments (keep them outside the system or in restricted Documents), interim relief workflows, appeals to tribunals, and Local Committee submissions.
