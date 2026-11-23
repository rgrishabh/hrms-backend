-- Who wrote the manager review, so that the same person does not also finalize it when HR writes it for someone with no reviewing manager.
ALTER TABLE performance_reviews ADD COLUMN manager_submitted_by uuid;
