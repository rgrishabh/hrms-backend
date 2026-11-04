# SMS notifications

Module `notifications.sms`. Code: `src/core/notify/sms.ts`, `src/core/notify/service.ts` (outbox), `src/modules/sms/routes.ts`. Tests: `test/sms.test.ts`.

Selected notifications also go out by SMS, through the organization's own SMS provider. In-app notifications and email are unchanged.

## How it works

- **Queuing.** When a notification is created and the organization has an enabled template for its kind, an SMS is queued in `sms_outbox`. This happens in the same transaction as the change (outbox pattern), so a rolled-back change sends nothing.
  - It goes only to users who haven't opted out (`users.sms_notifications`; `PUT /auth/preferences {smsNotifications}`).
  - The user also needs a mobile number on their employee record.
- **Delivery.** The scheduler delivers the outbox every minute, as it does for email.
  - Rows are claimed with `SKIP LOCKED`.
  - A failed send is retried after 2, 4, 8 … minutes, with at most 5 attempts.
  - A number that isn't a valid mobile number fails at once.
- **Numbers.** A 10-digit Indian mobile number (starting 6–9, with or without `0`/`91`) becomes `+91…`. Other countries need the full `+` form.
- **Masking.** Numbers are masked in the admin outbox and in logs. Neither the number nor the text is written to the application log.

## DLT (India)

Under TRAI's rules (TCCCPR 2018), every transactional SMS needs three things registered on the operator's DLT platform:
1. The **principal entity** (`SMS_DLT_ENTITY_ID`).
2. A **sender ID** / header (`SMS_SENDER_ID`).
3. A **content template** for each message.

The text sent must match the registered template, or the operator blocks it. The organization registers its templates and enters them under **Settings → SMS**, one per notification kind:
- the DLT template ID (10–25 digits);
- the exact registered text, with up to two `{#var#}` placeholders. The first is filled with the notification title, the second with its detail, each cut to 30 characters as DLT allows.

Example to register: `HRMS: {#var#}. Details: {#var#}. Open HRMS to act. -ACMELB`

**Settings → SMS → Send test** sends one template to a number straight away, to check the provider and the registration.

## Deployment settings

| Variable | Meaning |
|---|---|
| `SMS_TRANSPORT` | `disabled` (default), `http`, or `log` (development: records that an SMS would be sent, with a masked number) |
| `SMS_HTTP_URL` | The provider's send endpoint (https in production) |
| `SMS_HTTP_AUTH_HEADER` | One header, `Name: value` (for example the provider's API key). Keep it in the secret store |
| `SMS_HTTP_CONTENT_TYPE` | `json` (default) or `form` |
| `SMS_HTTP_BODY` | The request body with placeholders `{{to}}` (+91…), `{{to_digits}}` (91…), `{{message}}`, `{{template_id}}`, `{{sender_id}}`, `{{entity_id}}`. Values are JSON-escaped or URL-encoded to suit the content type |
| `SMS_SENDER_ID`, `SMS_DLT_ENTITY_ID` | Your DLT header and entity ID |

Build `SMS_HTTP_BODY` from your provider's API documentation. Two examples are shown below; check the field names against your provider's current documentation before use.

```
# JSON API
SMS_HTTP_BODY={"sender":"{{sender_id}}","route":"4","DLT_TE_ID":"{{template_id}}","sms":[{"message":"{{message}}","to":["{{to_digits}}"]}]}
# Form API
SMS_HTTP_CONTENT_TYPE=form
SMS_HTTP_BODY=To={{to}}&From={{sender_id}}&Body={{message}}
```

A provider answer other than 2xx counts as a failure and is retried. The first 200 characters of the answer are kept on the outbox row.

## Notifications available by SMS

These kinds can have a template:
- approvals waiting, and approval reminders
- payslip available
- expense claim reimbursed
- travel advance paid
- advance or loan paid out
- interview scheduled
- onboarding or exit task due
- new policy to read
- document or training expiring
- an update on a grievance or complaint
- password changed
- two-step sign-in turned off

All other notifications stay in-app and email only.
