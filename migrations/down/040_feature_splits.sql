-- Undoes 040. Data: geofences, selfie records (not the stored images), push subscriptions and the push outbox are gone. Requests get their old entity types back.
-- The advances_loans rows 040 deleted were not kept, so that module's per-tenant switches do not return; the build that knows the feature writes its definition when it migrates.
DROP TABLE push_outbox, push_subscriptions, attendance_selfies, branch_geofences;
ALTER TABLE attendance_events DROP COLUMN outside_geofence;
UPDATE approval_requests SET entity_type = 'employee_loan' WHERE entity_type = 'salary_advance';
UPDATE approval_requests SET entity_type = 'overtime_claim' WHERE entity_type = 'overtime_comp_off';
