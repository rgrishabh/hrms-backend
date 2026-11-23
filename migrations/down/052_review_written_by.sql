-- Undoes 052. Who wrote each manager review is forgotten.
ALTER TABLE performance_reviews DROP COLUMN manager_submitted_by;
