# Notifications

In-app notifications are always on. Email is module `notifications.email`: add it to `ENABLED_MODULES` and configure a transport. Code: `apps/api/src/core/notify/`, `modules/notifications/`. Tests: `test/notifications.test.ts`.

## What triggers a notification

| Event | Who | Link |
|---|---|---|
| Approval requested, or moved to the next step | The step's approver (named user), or **every active user holding the step's permission** (e.g. HR for `leave.approve`), plus a delegate covering for a named approver ("covering for …"). Never the requester | `/approvals` |
| Approvals handed over, ended or declined (docs/APPROVALS.md) | The delegate; the approver when HR set it up or the delegate declined | `/approvals` |
| Step escalated after `approvals.escalate_after_days` | The approver's manager or HR (`approvals.escalations`), and the original approver | `/approvals` |
| Request approved / rejected / returned | The requester, with the approver's comment | Module page (`/leave`, `/attendance/me`) |
| Request waiting longer than `notifications.approval_reminder_days` (default 2; 0 = off) | Current approvers (including delegates and anyone it was escalated to), at most **once per day** (`approvals.reminder` job, 09:30) | `/approvals` |
| Password changed | The user (security notice) | `/account` |

Content is a title, a short summary and a link. **Never** salary, bank, identity or other sensitive data.

## Delivery (transactional outbox)

1. The event's transaction inserts the in-app row and, if email applies, an `email_outbox` row. A rollback means nothing is sent.
2. Every scheduler tick (each app instance, every `JOBS_INTERVAL_SECONDS`) claims due emails with `FOR UPDATE SKIP LOCKED`, so no email is sent twice. Stuck `sending` rows are re-queued after 10 minutes.
3. A failed send is retried after 2, 4, 8 and 16 minutes, then marked `failed` (5 attempts). The last error is kept, without credentials.

Email is queued only when the module is enabled, a transport is configured, the user is active, and the user hasn't turned off **Email notifications** (My account). In-app notifications are always created.

## Configuration (deployment-level)

| Setting | Compose `.env` | Terraform `mail = {…}` |
|---|---|---|
| Transport | `MAIL_TRANSPORT=smtp` (or `disabled`; `log` is development only and records recipient + subject, never the body) | `transport` |
| Server | `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_SECURE` (`true` = implicit TLS on 465; otherwise STARTTLS is required) | `smtp_host`, `smtp_port`, `smtp_secure` |
| Credentials | `SMTP_USER`, `SMTP_PASSWORD` | `smtp_user`. The password goes in Secrets Manager `hrms/smtp-password` (Terraform creates the empty secret; set it with `aws secretsmanager put-secret-value`) |
| Sender | `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME` (default: brand name) | `from_address`, `from_name` |

Startup refuses `smtp` without a host or sender, a user without a password (or the reverse), and `log` in production. Emails use the installation's branding (name, primary colour, product, support email) and link to `APP_URL`.

Amazon SES: verify the sender domain (SPF/DKIM) and use the SES SMTP endpoint for the region. Request production access before sending to unverified recipients.

## API

`GET /api/v1/notifications?unread=true&page=` · `GET /api/v1/notifications/unread-count` · `POST /api/v1/notifications/:id/read` · `POST /api/v1/notifications/read-all` · `PUT /api/v1/auth/preferences {emailNotifications}`. All are scoped to the signed-in user.

## Not yet implemented

SMS and push, per-event preferences, digest emails, expiry reminders (contracts, probation, certifications: these come with the respective modules), and a bounce/complaint feedback loop.
