-- Undoes 025.
DROP TABLE sms_outbox, sms_templates;
ALTER TABLE users DROP COLUMN sms_notifications;
