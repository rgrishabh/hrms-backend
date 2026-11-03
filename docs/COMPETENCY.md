# Training, laboratory competency and technical authorization

Modules: `training` (courses and training records) and `lab.competency` (methods, assessments, authorizations, matrix; needs `training`). Neither is in `default`; add them to `ENABLED_MODULES` / `enabled_modules`.

The module keeps **personnel competence records** of the kind ISO/IEC 17025 (clause 6.2) asks a laboratory to keep: competence requirements, training, assessment of competence, authorization for specific activities, and monitoring. It does **not** make an installation compliant or accredited. The laboratory's quality system defines the actual requirements, and its assessors and quality manager decide.

## Concepts

| Thing | What it holds |
|---|---|
| Training course | Code, name, type (induction, safety, method, instrument, quality, external), validity in months (blank = never expires) |
| Training record | Employee, course, completion date, result (passed / completed / failed), trainer or provider, hours. Expiry is fixed when recorded from the course validity; later validity changes do not rewrite past records. Records are never deleted; a wrong record is **revoked** with a reason |
| Method | A test method in scope: code, name, standard reference as the lab cites it, discipline, matrix, optional branch, **required courses**, and the **periodic review interval** for authorizations |
| Assessment | Evidence that a person is (or is not yet) competent for a method and activity: approach (witnessed, replicate / CRM, retained sample, proficiency test, interlaboratory comparison, written), date, result, evidence text, assessor. Assessments are immutable |
| Authorization | Person × method × activity (sampling, perform, review results, authorize reports). Lifecycle below; every change is kept in an event history |

## Authorization lifecycle

```
assessment (competent) ──request──▶ pending ──quality approves──▶ authorized ──review due passes──▶ expired
                                      │                            │   ▲
                                      ├─ rejected / cancelled       │   └─ reinstate (training valid, review not overdue)
                                      │                            ▼
                                      │                         suspended ──▶ withdrawn
                                      └─ (renewal while authorized) ──approved──▶ previous one becomes superseded
```

Rules enforced by the server:

- **Separation of duties.** Nobody records an assessment for themselves, requests their own authorization, grants or changes their own authorization. The requester (usually the laboratory manager) can never approve their own request; a database CHECK also rejects `authorized_by = requested_by`.
- **Prerequisites.** A request, an approval and a reinstatement all require every required course to be valid that day; otherwise `409 prerequisites_missing` lists them.
- **Fresh evidence.** The assessment must be `competent`, not older than the setting `competency.assessment_validity_days` (default 180), and not contradicted by a later *not yet competent* assessment. Each assessment supports one request.
- **One at a time.** At most one pending and one in-force authorization per person, method and activity (unique indexes). A renewal stays pending while the current authorization stays in force.
- **In force** means: status `authorized`, review not overdue, and all required training valid **today**. If training lapses or is revoked, or the method gains a new requirement, the authorization stays on record but is reported as *not in force* by `/check`, the matrix and the detail view. Quality decides whether to suspend.
- **Review.** Approval sets `review_due = approval date + method review interval`. The daily job `competency.review` (07:45) expires overdue authorizations and reminds quality and the employee 30 and 7 days ahead. The daily job `training.expiry` (07:30) reminds the employee and training managers 30 and 7 days before a training record lapses and on the day, unless it has already been renewed.

## API (prefix `/api/v1/competency`)

| Endpoint | Permission |
|---|---|
| `GET/POST /courses`, `PUT /courses/:id` | read: training or competency roles · write: `training.manage` |
| `GET/POST /training-records`, `POST /training-records/:id/revoke` | read: `training.manage`, `competency.read`, or own (`competency.self`) · write: `training.manage` |
| `GET/POST /methods`, `PUT /methods/:id` | write: `competency.manage` |
| `GET/POST /assessments` | write: `competency.assess` |
| `POST /authorizations` `{assessmentId}` | `competency.assess` (creates the approval request for `competency.authorize`) |
| `GET /authorizations[?status=pending\|in_force\|review_due\|suspended\|ended]`, `GET /authorizations/:id` | `competency.read`, `competency.authorize`, or own |
| `POST /authorizations/:id/suspend\|reinstate\|withdraw` `{reason}` | `competency.authorize` |
| `POST /authorizations/:id/cancel` | the requester, while pending |
| `GET /check?employeeCode=&methodCode=&activity=` | `competency.read` / `competency.authorize`, or own. Returns `authorized` and the reasons if not |
| `GET /matrix[?discipline=&branchId=]` | `competency.read` |
| `GET /me` | `competency.self` |

`/check` is meant for a LIMS or report sign-off step ("may this analyst release this result?"). It answers for **today** only; historical questions are answered from the event history. Machine-to-machine access (API keys for a LIMS) is not built yet; today the caller needs a user session.

## Default roles

| Role | Permissions |
|---|---|
| Employee (everyone) | `competency.self` |
| Laboratory Manager | `training.manage`, `competency.read`, `competency.assess` |
| Quality Manager | `training.manage`, `competency.read`, `competency.manage`, `competency.assess`, `competency.authorize` |
| HR Administrator | `training.manage`, `competency.read` |
| HR Executive | `training.manage` |
| Auditor | `competency.read` |

## Not included / to verify

- Training plans, needs analysis, scheduling sessions, attendance sheets, effectiveness evaluation and trainer qualification records are not built.
- Certificates are stored through the Documents module (no direct link from a training record yet).
- Instrument-specific authorization, supervision periods and the link to proficiency-testing schemes are captured only as free-text evidence.
- Whether these records satisfy a given accreditation body's expectations must be confirmed by the laboratory's quality manager.
