# Security

Report vulnerabilities privately to the repository owner. Do not open public issues for them.

## Implemented controls (with automated tests)

| Control | Implementation | Test |
|---|---|---|
| Tenant isolation (app) | Tenant derived from verified host + session; every query tenant-filtered | `tenancy-security.test.ts` |
| Tenant isolation (DB) | RLS on all tenant tables; runtime role without BYPASSRLS; boot check | Manual check in TESTING.md + integration tests |
| Cross-tenant references | Composite `(tenant_id, id)` foreign keys | `tenancy-security.test.ts` |
| Host validation | The app answers only its configured domains (`BRAND_DOMAIN`/`BRAND_EXTRA_DOMAINS`); ALB/Caddy also route only those | `installation.test.ts`, `tenancy-security.test.ts`, Terraform test |
| Deployment-controlled config | No write API for branding, domains or modules; public config contains no secrets | `installation.test.ts`, `features-settings.test.ts`, `config.test.ts` |
| Administrator bootstrap | CLI only (owner DB credentials); first admin only; one-time hashed setup links in the URL fragment, or a Secrets Manager password with forced change; audited, including rejected links | `installation.test.ts` |
| Configuration validation | Startup fails with field-level errors; production requires https, Secure cookies and an explicit DB TLS mode; secrets never echoed | `config.test.ts` |
| Branding assets | Image types only, ≤ 2 MB, in-memory map (no traversal), served with a sandbox CSP | `installation.test.ts` |
| Authentication | Argon2id, scrypt upgraded at sign-in; the same work for unknown users; generic error messages; bundled leaked-password list; hashing outside any transaction | `passwords.test.ts`, `links-and-notices.test.ts` |
| Brute force | Back-off counted in the database by account and address, by address, and by account with known browsers exempt, so a known email cannot be locked out from elsewhere (D44); per-address and per-account rate limits | `sessions.test.ts`, `rate-limit.test.ts` |
| Sessions | Opaque, hashed at rest, httpOnly, SameSite=Lax, Secure in production; revoked on logout, password change, disable, role change, tenant suspension | `tenancy-security.test.ts` |
| CSRF | Session-bound token required on every state-changing cookie request | `tenancy-security.test.ts` |
| Authorization | Server-side permission checks per route; segregation of duties in system roles | multiple suites |
| Module switches | A module that is off refuses every one of its routes (a gate on the whole module plus per-route checks for sub-modules such as shifts, holidays, statutory rules, separations, self-service payslips); without a session the answer stays 401 | `feature-gates.test.ts` |
| Two-factor authentication | Set by `MFA_AVAILABLE` and `MFA_ENFORCED` only. TOTP (RFC 6238, Node crypto only), secrets encrypted, replay-protected; email codes, keyed hash, single use; 10 hashed one-time recovery codes; 5 wrong codes end the session, 10 across sessions stop it for 15 minutes. **Optional unless enforced, including for people who read L4 data: see D45** | `mfa.test.ts` |
| Maker-checker | The requester never acts on their own approval request. Nor do excluded parties: the author of an offer or requisition someone else submitted, or the employee a salary change, leave, expense claim, overtime claim, field duty recorded for them, probation review or separation concerns. Each step of a multi-step approval needs a different person. Payment batches, policy publishing and payroll runs need a second person. Nobody pays their own travel advance or disburses their own loan | `approvals.test.ts`, `attendance-flows.test.ts`, `expenses.test.ts`, `payroll.test.ts`, `field-duty.test.ts`, `travel.test.ts`, `loans.test.ts` |
| No privilege escalation | Nobody raises anyone's effective level to their own or above, through a role or otherwise, and nobody changes someone at or above them; the last owner stays; only bootstrap works outside this (D40). `users.manage` holders other than administrators grant only roles whose permissions they hold | `role-grants.test.ts`, `tenancy-security.test.ts` |
| No self-certification | Nobody records their own training, assesses or authorizes their own competence, changes their own salary, or finalizes a rating they wrote as the manager | `competency.test.ts`, `payroll.test.ts`, `performance-assets.test.ts` |
| Confidential cases (POSH / grievance) | Administrators maintain the Internal Committee but cannot read complaints. Nobody adds themselves to the committee, and every change is audited with names and announced to members. A complainant's own actions are audited without their identity or IP, so audit readers cannot learn who filed | `cases.test.ts` |
| Restricted documents | Medical and identity categories need `documents.restricted`, both to read and to change the category's restricted setting | `documents.test.ts` |
| Blind evaluations | Interview panel members, HR and hiring managers included, see colleagues' feedback only after submitting their own. Nobody sees the manager or final rating of their own review early. Neither appears in the audit log | `recruitment.test.ts`, `performance-assets.test.ts` |
| Restricted data | Bank account numbers AES-256-GCM encrypted; masked in API; every view audited; tenant admin cannot view | `employees.test.ts` |
| Audit | Append-only (DB grants); same transaction as the change; secrets redacted from metadata | several |
| Device auth | Per-device key (prefix + secret, secret stored hashed), rotation, disable | `attendance-flows.test.ts` |
| Input validation | zod on every body/query/param; DB constraints as a backstop; bad values answer 400, never 500 | `security/injection.test.ts` |
| SQL injection | Parameterized queries only. Dynamic identifiers only from fixed code maps | `security/injection.test.ts` (hostile values in every field of the document), Semgrep |
| Headers | Helmet: CSP `default-src 'none'` on API responses, nosniff, frame-ancestors none; `Cache-Control: no-store` by default on the API (D64) | `security/flags-headers.test.ts` |
| Logging | Cookie, authorization, device key and CSRF headers redacted. No request bodies logged | `logging-redaction.test.ts` |
| Writes on a person | Status, manager, separation, loan and document changes need rank over the subject; nobody changes their own pay inputs (D62) | `security/privilege-abuse.test.ts` |
| Taking over a record | A login on an employee record goes to that record's address, or someone who outranks them vouches (D63) | `security/privilege-abuse.test.ts` |
| Choosing your approver | Nobody delegates someone else's approvals to themselves, or reassigns to someone who delegates to them | `security/privilege-abuse.test.ts` |
| Uploads | Content decides type; no active PDF content, including hex-escaped names; no macros; generated keys; attachments | `security/files-exports.test.ts`, `uploads.test.ts` |
| Spreadsheet exports | One CSV writer: formulas neutralized, including leading white space and full-width forms, and separators quoted. XLSX has inline strings only | `security/files-exports.test.ts` |
| SSRF | No setting is fetched. Push endpoints are an allow-list, redirects refused. A test lists every outbound fetch in the code | `security/files-exports.test.ts` |
| Permissions on routes | Every declared permission tried: refused with nothing, allowed with exactly it. Every route 401 without a session | `contract/route-permissions.test.ts` |
| Location privacy | Mobile location stored only when tenant policy asks, captured only at punch time | `attendance-flows.test.ts` |

## Reports

- [`SECURITY_REPORT.md`](SECURITY_REPORT.md): findings with CVSS and status, and scanner results.
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md): STRIDE for the API. The infrastructure's is in `hrms-deployment/docs/THREAT_MODEL.md`.
- `test/security/`: the abuse suite. `load/`: the k6 scripts. Results are in `QA_REPORT.md`.

## Scanning

| Tool | Where | Gate |
|---|---|---|
| `npm audit --omit=dev` | Reusable CI | High and above |
| Gitleaks | Reusable CI | Any finding |
| Trivy, repository | `security.yml` | Fixable high or critical |
| Trivy, image | Reusable CI and publish | Fixable critical |
| Semgrep: `p/owasp-top-ten`, `p/nodejs`, `p/typescript` | `security.yml` | `ERROR` |
| CodeQL, `security-extended` | `security.yml` | Reports to code scanning |
| ZAP baseline, per pull request; full, nightly | `security.yml` | Rules in `.zap/rules.tsv` |
| SBOM, CycloneDX | `security.yml`, and attached to images | None |

## Outstanding (must be done before production)

1. Required MFA for people who read L4 data: not done, by the owner's decision, and `MFA_ENFORCED=true` gives it to everyone (D45). Still open: WebAuthn/passkeys; SSO via an external identity provider.
2. **Data protection (DPDP Act 2023).** Technical safeguards exist. Legal applicability and the current status of rules and commencement must be verified by counsel. Technical controls alone do not establish compliance.
3. **An external penetration test** before go-live. Nothing so far has been tested by anyone outside this project.

## Data minimization

There are no Aadhaar or other national identity fields. Bank details are restricted. Location is policy-driven. Biometric templates are never collected; devices send only attendance events (see docs/BIOMETRIC_INTEGRATION.md).

## Never log or store in plain text

Passwords, session tokens, device secrets, full bank account numbers, encryption keys. `core/audit/audit.ts` redacts keys that match these names from audit metadata.
