-- Undoes 031.
ALTER TABLE expense_items DROP COLUMN quantity, DROP COLUMN rate, DROP COLUMN rate_id, DROP COLUMN tier, DROP COLUMN vehicle;
ALTER TABLE expense_categories DROP COLUMN calc;
DROP TABLE allowance_rates;
