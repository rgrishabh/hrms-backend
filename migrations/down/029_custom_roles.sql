-- Undoes 029.
DROP INDEX tenant_roles_name_uq;
ALTER TABLE tenant_roles DROP CONSTRAINT tenant_roles_name_len;
ALTER TABLE tenant_roles DROP COLUMN description, DROP COLUMN created_by, DROP COLUMN updated_by, DROP COLUMN updated_at;
