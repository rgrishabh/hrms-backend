-- Undoes 028.
ALTER TABLE approval_steps DROP COLUMN activated_at, DROP COLUMN escalated_at, DROP COLUMN escalated_to, DROP COLUMN escalated_permission, DROP COLUMN acted_for, DROP COLUMN acted_via;
DROP TABLE approval_delegations;
