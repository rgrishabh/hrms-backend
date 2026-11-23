-- Undoes 005.
DROP TABLE admin_setup_tokens;
ALTER TABLE users DROP COLUMN must_change_password;
