-- Undoes 022.
ALTER TABLE field_duty_requests DROP COLUMN travel_request_id;
DROP INDEX expense_claims_travel_idx;
ALTER TABLE expense_claims DROP CONSTRAINT expense_claims_adjusted_le_total;
ALTER TABLE expense_claims DROP COLUMN advance_adjusted, DROP COLUMN travel_request_id;
DROP TABLE travel_requests;
