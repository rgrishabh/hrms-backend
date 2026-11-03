# Security

Report vulnerabilities privately to the repository owner. Do not open public issues for them.

## Implemented controls (with automated tests)

| Control | Implementation | Test |
|---|---|---|
| Tenant isolation (app) | Tenant derived from verified host + session; every query tenant-filtered | `tenancy-security.test.ts` |
| Tenant isolation (DB) | RLS on all tenant tables; runtime role without BYPASSRLS; boot check | Manual check in TESTING.md + integration tests |
| Cross-tenant references | Composite `(tenant_id, id)` foreign keys | `tenancy-security.test.ts` |
| Host validation | The app answers only its configured domains (`APP_URL`/`APP_EXTRA_DOMAINS`); ALB/Caddy also route only those | `installation.test.ts`, `tenancy-security.test.ts`, Terraform test |
| Deployment-controlled config | No write API for branding, domains or modules; public config contains no secrets | `installation.test.ts`, `features-settings.test.ts`, `config.test.ts` |
| Administrator bootstrap | CLI only (owner DB credentials); first admin only; one-time hashed setup links in the URL fragment, or a Secrets Manager password with forced change; audited, including rejected links | `installation.test.ts` |
| Configuration validation | Startup fails with field-level errors; production requires https, Secure cookies and an explicit DB TLS mode; secrets never echoed | `config.test.ts` |
| Branding assets | Image types only, ≤ 2 MB, in-memory map (no traversal), served with a sandbox CSP | `installation.test.ts` |
| Authentication | scrypt hashes; constant work for unknown users; generic error messages | — |
| Brute force | Per-IP login rate limit (`AUTH_RATE_LIMIT_PER_MINUTE`); account lockout after N failures (tenant setting, 3–10) for 15 min | `rate-limit.test.ts`, `tenancy-security.test.ts` |
| Sessions | Opaque, hashed at rest, httpOnly, SameSite=Lax, Secure in production; revoked on logout, password change, disable, role change, tenant suspension | `tenancy-security.test.ts` |
| CSRF | Session-bound token required on every state-changing cookie request | `tenancy-security.test.ts` |
| Authorization | Server-side permission checks per route; segregation of duties in system roles | multiple suites |
| Two-factor authentication | TOTP (RFC 6238, Node crypto only); secrets encrypted with the field key; replay-protected; 10 hashed one-time recovery codes; 5 wrong codes end the session; required for privileged roles by default (`MFA_ENFORCEMENT`, organizations can only tighten); nothing about the organization is returned before the code; admin reset revokes sessions; security notices on enable/disable/recovery use | `mfa.test.ts` (incl. RFC 4226/6238 vectors) |
| Maker-checker | Requester can never act on their own approval request | `attendance-flows.test.ts` |
| Restricted data | Bank account numbers AES-256-GCM encrypted; masked in API; every view audited; tenant admin cannot view | `employees.test.ts` |
| Audit | Append-only (DB grants); same transaction as the change; secrets redacted from metadata | several |
| Device auth | Per-device key (prefix + secret, secret stored hashed), rotation, disable | `attendance-flows.test.ts` |
| Input validation | zod on every body/query/param; DB constraints as a backstop | — |
| SQL injection | Parameterized queries only. Dynamic identifiers only from fixed code maps | Code review |
| Headers | Helmet: CSP `default-src 'none'` on API responses, nosniff, frame-ancestors none | `tenancy-security.test.ts` |
| Logging | Cookie, authorization, device key and CSRF headers redacted. No request bodies logged | — |
| Location privacy | Mobile location stored only when tenant policy asks, captured only at punch time | `attendance-flows.test.ts` |

## Outstanding (must be done before production)

1. ~~MFA for privileged roles~~ — implemented (TOTP). Still open: WebAuthn/passkeys; SSO via an external identity provider.
2. **Secrets.** Load `DATABASE_URL` and `DATA_ENCRYPTION_KEY` from AWS Secrets Manager at task start. Plan KMS envelope encryption and key rotation for field encryption (the ciphertext has a `v1.` prefix to allow versioning).
4. **File uploads.** Not implemented. When added: type/size allow-lists, malware scanning, private S3 with tenant-prefixed keys and short-lived signed URLs.
5. **Dependency and container scanning.** `npm audit` runs in CI. Add container image scanning (ECR/Trivy) once images are built.
6. **Password policy.** A forced change exists for bootstrap administrators. Users created by admins don't have it yet. Add a breached-password check and a self-service password reset by email (needs the email module).
7. **Session listing / remote sign-out UI** for users and admins (the API supports revoke-all for oneself).
8. **Data protection (DPDP Act 2023).** Technical safeguards exist. Privacy notice, consent and purpose records, retention schedules, and data-principal request workflows are **not** implemented. Legal applicability and the current status of rules and commencement must be verified by counsel. Technical controls alone do not establish compliance.
9. **Penetration test and threat model review** before go-live.

## Data minimization

There are no Aadhaar or other national identity fields. Bank details are restricted. Location is policy-driven. Biometric templates are never collected; devices send only attendance events (see docs/BIOMETRIC_INTEGRATION.md).

## Never log or store in plain text

Passwords, session tokens, device secrets, full bank account numbers, encryption keys. `core/audit/audit.ts` redacts keys that match these names from audit metadata.
