-- Undoes 008.
ALTER TABLE users DROP COLUMN email_notifications;
DROP TABLE email_outbox, notifications;
