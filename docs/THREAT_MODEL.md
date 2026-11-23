# Threat model: the API

STRIDE for what `hrms-backend` itself decides: HTTP routes, sessions, roles, money and personal data, jobs. The network, cluster, cloud account, secrets store and images are in the [deployment repository's threat model](../../hrms-deployment/docs/THREAT_MODEL.md) and are not repeated here.

Findings with scores are in [`SECURITY_REPORT.md`](../SECURITY_REPORT.md). Each row names the test that attacks the control, so a control with no test says so.

## What is worth attacking

| Asset | Level | Who wants it |
|---|---|---|
| Salary, payslips, bank account, PAN, loans | L4 | A colleague; HR staff curious about those above them; someone redirecting pay |
| Medical and identity documents, leave reasons, separation reasons, POSH complaints | L3 | A colleague, a manager, a respondent in a complaint |
| Payroll runs, payment batches, bank files | Money | An insider paying themselves; an outsider with a stolen session |
| Sessions, password reset links, recovery codes | Credentials | An outsider |
| The audit log | Evidence | An insider covering their tracks |

## Who attacks, and from where

| Actor | Starting point |
|---|---|
| Anonymous | The public host: sign-in, password links, public config, device events with no key |
| Employee | A valid session and their own record |
| Manager | Their reporting chain |
| HR, payroll, finance, IT staff | Real permissions, a level below someone they want to reach. **The most likely attacker in this system** |
| Administrator | Everything but L4 of those above, and any way to act alone on money |
| A device | One biometric key |
| Another organization on the same database | Test and defence-in-depth only: production is one installation per customer (D16, D19) |

Trust boundaries: browser to API (cookie and CSRF token); API to PostgreSQL (the runtime role, without BYPASSRLS, tenant set per transaction); API to object store and clamd; worker to mail and push services; the deployment's environment to the process (flags and brand are never written from the app).

## STRIDE

### Spoofing

| Threat | Control | Test |
|---|---|---|
| Forged or tampered session token, JWT-shaped or not | Opaque random token, SHA-256 at rest, nothing self-describing to re-sign (D5) | `security/session-csrf` |
| Replay after logout, password change, role change, disable, expiry | Server-side revocation on each | `security/session-csrf`, `sessions`, `tenancy-security` |
| Password guessing, spraying, stuffing | Back-off in the database by account and address, by address, by account for unknown browsers; rate limits; Argon2id | `security/brute-force`, `sessions`, `rate-limit` |
| Second-factor guessing | 5 per session, 10 across sessions then 15 minutes | `security/brute-force`, `mfa` |
| Forged `X-Forwarded-For` | `TRUST_PROXY` as a hop count | `security/brute-force`, `rate-limit` |
| Forged Host or `X-Forwarded-Host` selecting another organization | Only verified, active domains resolve; `X-Forwarded-Host` is never read | `security/flags-headers`, `tenancy-security` |
| A reset or invite link outliving its purpose | Single use, hashed, ended by any password change (F-117) | `security/privilege-abuse`, `links-and-notices` |
| A login attached to someone else's record, read as "self" | Address must match the record, or HR above them vouches (F-103) | `security/privilege-abuse` |
| A device key used elsewhere | Per device, hashed, organization taken from the key | `attendance-flows` |

### Tampering

| Threat | Control | Test |
|---|---|---|
| SQL or operator injection | Parameters only; identifiers from fixed maps; zod on every input | `security/injection` (every field of the document), Semgrep |
| CSRF | Session-bound header on every unsafe cookie request; SameSite=Lax; JSON only | `security/session-csrf` (every unsafe route) |
| Changing someone at or above you | One rule: `assertOutranks`, `assertMayChangeSubject` (F-104, F-109, F-111, F-113) | `security/privilege-abuse`, `permission-matrix`, `role-grants` |
| Paying yourself | Nobody changes their own pay inputs through a staff route (F-101); maker-checker on runs and batches | `security/privilege-abuse`, `payroll`, `expenses` |
| Choosing your own approver | No self-delegation for someone else, no reassigning back to yourself (F-102), no changing your own manager (F-104) | `security/privilege-abuse`, `approvals` |
| Clearing your own exit | Whoever is leaving answers only for their own tasks (F-110) | `security/privilege-abuse` |
| Editing a sealed value in the database | AES-256-GCM with a full-length tag (F-124); hash chain on the audit log | `security/files-exports`, `audit-chain` |
| Malicious upload | Content decides type, no active PDF content or macros (F-120, F-121), clamd, generated keys, attachment disposition | `security/files-exports`, `uploads`, `documents` |
| A forged row or formula in a bank or journal file | One CSV writer, with quoting and formula neutralization (F-122, F-123) | `security/files-exports` |

### Repudiation

| Threat | Control | Test |
|---|---|---|
| Denying an L4 read or export | One audit row per subject with who, whose, which fields, IP, device | `permission-matrix` |
| Altering the record | Append-only, hash-chained, verified by `audit_chain_verify` | `audit-chain`, `audit-chain-concurrency` |
| A failed attempt leaving no trace | Rejected links and failed sign-ins are audited outside the failed transaction | `installation`, `tenancy-security` |

**Accepted:** someone holding the schema owner's credentials can disable triggers. The chain then shows the change unless every later hash is rewritten too (`docs/DATA_SECURITY.md`).

### Information disclosure

| Threat | Control | Test |
|---|---|---|
| IDOR across organizations | Host and session must agree; tenant in every query; RLS below that | `security/isolation` (every route with an id) |
| IDOR inside an organization | Row filters, 404 for what you may not reach | `live-responses` walks every GET per persona; `permission-matrix` |
| HR reading HR or higher pay through API, export, search, report, file | `l4RowFilter`, whole-or-refused files, aggregates over visible people | `permission-matrix`, `security/privilege-abuse` |
| L3 by inference: duplicate warnings, history, a named employee on a team list | Checked at the source (F-114, F-115, F-116) | `security/privilege-abuse` |
| A read-only role seeing what it should not | L3 fields masked per reader (F-107, F-112) | `security/privilege-abuse` |
| A browser or proxy keeping personal JSON | `Cache-Control: no-store` by default on the API (F-125) | `security/flags-headers` |
| Errors quoting the database | One problem handler, a reference and no detail; class 22 answered as a bad value (F-119) | `security/injection`, `problem` |
| Stored XSS in the SPA | API answers JSON under `default-src 'none'`, `nosniff`; the SPA's CSP has no inline script; mail escapes | `security/files-exports` |
| Secrets in logs | Named fields redacted, no bodies, no query strings | `logging-redaction` |
| A module that is off | Not registered; its reports, jobs, permissions and settings gone | `security/flags-headers`, `feature-routes`, `feature-off` |

### Denial of service

| Threat | Control | Test |
|---|---|---|
| Request floods | Global limit per address, tighter on sign-in, links, MFA, exports | `security/brute-force`, `rate-limit` |
| Oversized bodies and files | 1 MB JSON, `STORAGE_MAX_FILE_MB`, one file per request | `security/files-exports` |
| Locking someone out from outside | Back-off by who is failing, known browsers exempt (D44) | `sessions` |
| One connection held by password hashing | Hash outside any transaction | `sessions` |
| Crash by a value | Class 22 mapped, money parsed safely (F-119) | `security/injection` |
| Laptop-sized load numbers | `QA_REPORT.md`, with what they do not show | `load/` |

**Accepted:** rate limits are per process (D27). With N replicas the real limit is N times the number, and the database back-off is what holds across them.

### Elevation of privilege

| Threat | Control | Test |
|---|---|---|
| Raising your own or someone's level | Role grants count as setting a level (D40); salary-level route under the same limit (F-105) | `role-grants`, `security/privilege-abuse` |
| A custom role with a permission you lack, or of a module that is off | `checkPermissions` (F-126) | `custom-roles`, `security/flags-headers` |
| An empty or read-only role reaching a route | Every declared permission tried both ways | `contract/route-permissions` |
| A flag bypass | Flags read from the environment only, no write path | `security/flags-headers` |
| Mass assignment | zod objects, `COLS` allow-list on employee patches | `security/injection`, `employees` |
| A mode with fewer checks | Exceptions name the collapsed-mode owner only | `contract/mode-flags`, `management-modes` |
| SSRF through a URL setting | No setting is fetched; push endpoints are an allow-list, redirects refused | `security/files-exports` |

## Known limits

- One person holding both a low-level HR role and an accomplice's cooperation can still route a stuck approval to that accomplice (`POST /approvals/:id/reassign`). The move is audited and announced (F-14).
- A PDF can hide active content inside a compressed object stream, which the content check does not open. Downloads are attachments, and the malware scanner sees the file as it arrived.
- Travel advance amounts are L3 in the classification and shown to those who approve or pay them, whoever they are. See `SECURITY_REPORT.md`.
- Nothing here has had an external penetration test.
