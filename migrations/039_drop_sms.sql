-- SMS is removed. Email is the only external notification channel. 025 stays as it was: it is checksummed.
DROP TABLE IF EXISTS sms_outbox;
DROP TABLE IF EXISTS sms_templates;
ALTER TABLE users DROP COLUMN IF EXISTS sms_notifications;
DELETE FROM tenant_modules WHERE feature_key = 'notifications.sms';
DELETE FROM tenant_feature_entitlements WHERE feature_key = 'notifications.sms';
DELETE FROM feature_definitions WHERE key = 'notifications.sms';
