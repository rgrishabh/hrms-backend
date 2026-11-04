-- 028: approval delegation (an approver hands their approvals to someone while away) and
-- time-based escalation (a step addressed to one person that sits unanswered goes to their manager, or to HR).

-- A delegation covers steps addressed to the delegator personally (e.g. as reporting manager), from starts_on to
-- ends_on inclusive, in the organization's timezone. Group steps (anyone with a permission) are never delegated:
-- that would hand a permission to someone who doesn't hold it, and the group still covers the absence.
CREATE TABLE approval_delegations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  delegator_id  uuid NOT NULL REFERENCES users(id),
  delegate_id   uuid NOT NULL REFERENCES users(id),
  starts_on     date NOT NULL,
  ends_on       date NOT NULL,
  note          text CHECK (note IS NULL OR length(note) <= 300),
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES users(id),
  CHECK (ends_on >= starts_on),
  CHECK (delegator_id <> delegate_id)
);
CREATE INDEX approval_delegations_delegator_idx ON approval_delegations (tenant_id, delegator_id, ends_on) WHERE revoked_at IS NULL;
CREATE INDEX approval_delegations_delegate_idx ON approval_delegations (tenant_id, delegate_id, ends_on) WHERE revoked_at IS NULL;

ALTER TABLE approval_delegations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON approval_delegations
  USING (app_platform_bypass() OR tenant_id = app_current_tenant())
  WITH CHECK (app_platform_bypass() OR tenant_id = app_current_tenant());

-- When the step became active (escalation counts from here), who it was escalated to, and on whose behalf it was decided.
ALTER TABLE approval_steps
  ADD COLUMN activated_at         timestamptz,
  ADD COLUMN escalated_at         timestamptz,
  ADD COLUMN escalated_to         uuid REFERENCES users(id),
  ADD COLUMN escalated_permission text,
  ADD COLUMN acted_for            uuid REFERENCES users(id),
  ADD COLUMN acted_via            text CHECK (acted_via IS NULL OR acted_via IN ('delegation','escalation'));

UPDATE approval_steps s SET activated_at = r.created_at
  FROM approval_requests r WHERE r.tenant_id = s.tenant_id AND r.id = s.request_id AND s.status = 'active';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    REVOKE DELETE ON approval_delegations FROM hrms_app;   -- revoked, never deleted: the history of who could approve stays
  END IF;
END $$;
