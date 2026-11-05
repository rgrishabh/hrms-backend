# Authentication

Sign-in, sessions, MFA, links and upload scanning. Decisions are in `DECISIONS.md` (D40, D44 to D48). Variables are in `hrms-deployment/docs/CONFIGURATION.md`.

## Passwords

Argon2id through `node:crypto`: 64 MiB, 3 passes, 1 lane, about 100 ms on a laptop core. A scrypt hash from an older release is checked as scrypt and replaced at the next right password. With no hash to check, the same Argon2id work runs on a fixed salt, so an unknown address costs the same.

| Rule | Value |
|---|---|
| Length | At least 12, or `security.password_min_length` if higher. At most 256 |
| Character classes | None required: length is what counts |
| Leaked | Refused, from a bundled list. Case is ignored, and so are numbers and marks on the end |
| Personal | Refused if it contains the email's local part or domain name, or a part of the person's name, of 4 characters or more |
| Repetitive | Refused under 5 distinct characters, or one block repeated |

A refusal is 400 `weak_password`, with `problems` listing `too_short`, `too_long`, `breached`, `personal` or `too_simple`.

### The leaked password list

72,518 entries, in `src/core/auth/breached-list.data.ts`, rebuilt by `scripts/build-breached-list.ts`. It is the union of two lists, keeping only entries of 12 to 64 printable characters, since shorter ones are refused by length anyway.

| | |
|---|---|
| Source | [SecLists](https://github.com/danielmiessler/SecLists), `Passwords/Common-Credentials`: `xato-net-10-million-passwords-1000000.txt`, `Pwdb_top-1000000.txt` |
| Licence | MIT, Copyright (c) 2018 Daniel Miessler. The licence text is below |
| Size in the image | 620 KB of source and of compiled JavaScript, gzip then base64 |
| Memory | 4.8 MB of heap, opened at the first password check (17 ms) and kept |
| Network | None. It is checked in memory |

A list of common passwords is not a list of everything leaked. It stops the passwords attackers try first. It says nothing about a password that was merely exposed once.

```
MIT License

Copyright (c) 2018 Daniel Miessler

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Failed sign-ins

Failures are counted in the database by what was typed, whether or not the account exists (D44).

| Counter | Blocks after | Whom it stops |
|---|---|---|
| Account, from one address | `security.max_failed_logins`, default 5 | That address, for that account |
| One address, across accounts | 50 | That address |
| Account, from every address | 30 | Browsers that have not signed in to this account before |

The wait doubles from 30 seconds to 15 minutes, and comes back as 429 with `Retry-After` before any password work. Counters are forgotten after 30 quiet minutes. An administrator clears what is held against an account with `PATCH /tenant/users/:id { "unlock": true }`, and a password reset does the same.

## Sessions

An opaque token in `hrms_sid`, SHA-256 in the database: `HttpOnly`, `SameSite=Lax`, `Secure` as `COOKIE_SECURE` says, and production refuses it off. Unsafe methods need the CSRF token derived from the session.

| | |
|---|---|
| Absolute limit | `min(security.session_ttl_hours, SESSION_TTL_HOURS)`. Activity does not move it |
| Idle limit | `security.session_idle_minutes`, default 30, copied to the session at sign-in |
| New token | At sign-in, which also revokes the session the browser presented; after a code is verified; after a password or MFA change |
| Ended | Others at a password or MFA change; all at a reset, role change, salary level change or MFA reset by an administrator |

A route that rotates answers with `csrfToken` and sets the cookie. `GET /auth/sessions` lists a user's sessions, `DELETE /auth/sessions/:id` ends one of their own, and `POST /auth/sessions/revoke-all` logs out everywhere.

`hrms_did` is a random long-lived cookie that recognizes a browser. It authenticates nothing.

## MFA

| `MFA_AVAILABLE` | `MFA_ENFORCED` | Result |
|---|---|---|
| `false` | | Off for everyone. `/auth/mfa/*` is 404. Enrolments are kept, and count again if it is turned back on |
| `true` | `false` | Each user chooses. `/auth/me` has `mfa.suggested` for those holding an L4 permission, and it blocks nothing |
| `true` | `true` | Everyone enrols at next sign-in, and cannot turn it off |

**With `MFA_ENFORCED=false`, people who can read salaries and bank details are not required to enrol** (D45).

`MFA_METHODS` decides which routes exist. `GET /auth/mfa/methods` says what is offered and whether each can be used now.

| Route | Purpose |
|---|---|
| `POST /auth/mfa/setup`, `/enable` | TOTP: the secret and `otpauthUri`, which the browser turns into a QR code, then a code, then 10 recovery codes |
| `POST /auth/mfa/email/setup`, `/email/enable` | Email: a code to prove the mailbox, then 10 recovery codes. 409 `feature_not_configured` without a mail transport |
| `POST /auth/mfa/verify` | A code or a recovery code, during sign-in |
| `POST /auth/mfa/email/send` | Another code |
| `POST /auth/mfa/recovery-codes` | New recovery codes, for a current code |
| `POST /auth/mfa/disable` | Password and code |

| Limit | Value |
|---|---|
| Email code | 6 digits, 10 minutes, single use, the newest only, hashed with a key the database does not hold |
| Guesses | 5 per email code. 5 per session, then the session ends. 10 per user across sessions, then 15 minutes of nothing, right code included |
| Sending | One a minute, five an hour, per user |

`/auth/login` answers `mfaRequired` and `mfaMethod`. For email codes it also sends one and answers `mfaDelivery`: `sent`, `wait`, or `unavailable`, when a recovery code is the way in.

## Links

Invitations and resets share `admin_setup_tokens` with the bootstrap link, by `purpose`. By email only, single use, a new link ends the last of its kind, three per hour per person, and the token is hashed at rest and kept in the URL fragment.

| | Expires | Page | Finished at |
|---|---|---|---|
| Reset | 30 minutes | `/reset-password#token=` | `POST /auth/password/reset` |
| Invitation | 72 hours | `/setup#token=` | `POST /auth/setup` |
| Bootstrap | 1 to 168 hours | `/setup#token=` | `POST /auth/setup` |

`POST /auth/password/forgot` always answers `{"ok":true}` after at least 250 ms, whatever the address. A reset ends all sessions and leaves MFA in place.

`POST /tenant/users` takes no password and sends an invitation, answering `inviteSent`. `POST /tenant/users/:id/invite` sends another, and `POST /tenant/users/:id/password-reset` sends a reset, to someone below the sender.

Without email, `hrms bootstrap --issue-link --admin-email X` prints a one-time link for an existing user, for the operator to pass on.

**Secrets and the outbox.** A code or token is never stored readable in `email_outbox`. The body holds a placeholder, the secret is sealed in `secret_enc`, opened only to send, and cleared after. A mail that outlives its secret is not sent. The worker delivers every 5 seconds as well as on each pass.

## Security email

These go out whatever `email_notifications` says, and say they cannot be turned off: a new browser signing in, password changed, MFA on or off, a recovery code used. Without a mail transport they stay in-app only.

## Rate limits

Per process (D27), on top of the database counters above.

| Path | Per address | Per user or account |
|---|---|---|
| Sign-in | `AUTH_RATE_LIMIT_PER_MINUTE`, default 20 | `AUTH_ACCOUNT_RATE_LIMIT_PER_MINUTE`, default 10 |
| MFA verify, enable | 10 | 10 |
| Email code, recovery codes, MFA off | 5 | 5 |
| Forgot password | 5 | 3 links an hour, silently |
| Finishing a link | 10 | |
| Change password | 5 | 5 |
| Exports: `*.csv`, `*.xlsx`, `*/export*` | 4 x `EXPORT_RATE_LIMIT_PER_MINUTE` | `EXPORT_RATE_LIMIT_PER_MINUTE`, default 30 |

## Uploads

Every upload goes through `prepareUpload`: content decides the type by magic bytes, clamd sees the file as it arrived, and images lose their metadata.

**Scanning.** `CLAMAV_HOST` and `CLAMAV_PORT` (default 3310), the INSTREAM command on `node:net`. Production with `FEATURE_DOCUMENTS` on refuses to start without it. In production a file that could not be scanned is not stored, answering 503 `scanner_unavailable`, also in other modules with documents off. A hit answers 422 `malware_detected` and writes `upload.malware_blocked`. clamd's `StreamMaxLength` must be at least `STORAGE_MAX_FILE_MB`. Outside production, with no host, scanning is skipped with a warning at startup.

**Metadata.** JPEG keeps JFIF, the colour profile and the orientation, and loses Exif, XMP, IPTC, comments and anything after the image. PNG loses text, Exif and time chunks. WebP loses Exif and XMP. An image whose structure does not hold together is refused. Stored size and hash are of the stripped file. PDF and Office files are not changed.
