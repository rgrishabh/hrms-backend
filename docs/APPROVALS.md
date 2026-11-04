# Approvals: delegation and escalation

Every module's approvals run through one engine (`src/core/workflow/engine.ts`). A request has ordered steps. Each step is addressed either to **one person** (for example the reporting manager) or to **a group**: everyone holding a permission, such as HR for `leave.approve` or finance for `expenses.approve`.

These rules always hold:
- nobody approves their own request;
- people the request excludes never see it or act on it (the author when someone else submits, the employee it is about);
- one person never decides two steps of the same request.

Delegation and escalation keep requests moving when the person a step is addressed to isn't there. Neither one breaks those rules.

Code: `src/core/workflow/` (`engine.ts`, `delegations.ts`, `routes.ts`); migration `028_approval_delegation.sql`. Tests: `test/approval-delegation.test.ts`, `test/approvals.test.ts`.

## Delegation

An approver who will be away hands their approvals to a colleague for a period, from **Approvals → While I'm away**.

- **What moves:** steps addressed to the approver **personally**. Requests already waiting move too, as do new ones that arrive during the period. Group steps never move: delegating one would hand a permission to someone who doesn't hold it, and the rest of the group still covers the absence.
- **The approver can still act.** The delegate's decision is recorded as made on the approver's behalf, and the approval history shows "Ravi Kulkarni for Meera Nair". The audit log records `via: delegation` and `onBehalfOf`.
- **Limits**
  - The period uses the organization's timezone. It starts today or later, lasts at most 90 days, and can be set up at most a year ahead.
  - An approver has one delegation at a time.
  - The delegate must have an active account and must not be handing over their own approvals during that period. Delegations don't chain.
- **Separation of duties.** A delegate never decides:
  - their own request;
  - a request that excludes them;
  - a step after one they decided themselves;
  - a step after one the approver they cover for decided.
- **Ending one:** the approver, whoever set it up, or HR can end it at any time, and the delegate can decline it. Waiting requests go back to the approver at once. Delegations are never deleted: the history of who could approve stays.
- **HR on someone's behalf.** Holders of `approvals.delegations` (HR Administrator) set one up for an unplanned absence. Both people are notified.

## Escalation

The setting **Escalate unanswered approvals after (days)** (`approvals.escalate_after_days`) controls escalation. It defaults to 5 days; 0 turns it off.

The `approvals.escalation` job runs daily at 10:00. When a step addressed to one person has been active for longer than the setting, the job sends it on:
- to the approver's **reporting manager**, when they have an active account and may act on the request;
- otherwise to holders of `approvals.escalations` (HR Administrator).

Escalation details:
- Each step escalates **once**.
- The original approver can still decide it, and is told who it went to.
- A delegate of the original approver, or of the person it escalated to, can act too.
- The decision is recorded with `via: escalation`.
- **Group steps are not escalated on time.** Their daily reminders (`notifications.approval_reminder_days`) keep going to the whole group.

## When nobody can act

A request never waits on someone who cannot act:
- A step for a **disabled** person goes to the fallback owner when the request is made. When an account is disabled, including at exit, its pending steps go to that person's manager, or the fallback owner.
- A **group step with no eligible holder** (the only holder is the requester or an excluded person, or nobody holds it) goes to the fallback owner, at creation and in the daily `approvals.escalation` job.
- The **fallback owner** is holders of `approvals.escalations` (HR Administrator).
- If the fallback owner cannot act either, the request is still created. Administrators and the requester are notified (`approval.no_approver`) and it is audited.
- Holders of `approvals.escalations` can **reassign** the active step to a named active person: `POST /approvals/:id/reassign {userId, reason}`. Holders of `users.manage` can do so only when nobody can act on the request. Not to themselves, the requester, or an excluded person.

## API

| Method and path | Who | Notes |
|---|---|---|
| GET `/approvals/delegations` | session | `{today, given, received}`. With `?scope=all`, `{today, items}` (needs `approvals.delegations`). Each row has `state` (scheduled, active, ended or revoked) |
| POST `/approvals/delegations` | session | `{delegateId, startsOn, endsOn, note?, delegatorId?}`. `delegatorId` (on someone's behalf) needs `approvals.delegations`. 201 `{id}`; 409 on overlap or chaining |
| POST `/approvals/delegations/:id/revoke` | the delegator, whoever set it up, the delegate, or HR | Ends it now |
| GET `/approvals/delegates?q=` | `employees.directory` | Active accounts to choose from (never yourself) |
| GET `/approvals/inbox` | session | Each item has `via` (null, delegation or escalation) and `on_behalf_of` |
