-- 029: organizations manage their own roles (tenant_roles existed since 001 and was already enforced at sign-in).
ALTER TABLE tenant_roles
  ADD COLUMN description text CHECK (description IS NULL OR length(description) <= 300),
  ADD COLUMN created_by  uuid REFERENCES users(id),
  ADD COLUMN updated_by  uuid REFERENCES users(id),
  ADD COLUMN updated_at  timestamptz NOT NULL DEFAULT now();

ALTER TABLE tenant_roles ADD CONSTRAINT tenant_roles_name_len CHECK (length(name) BETWEEN 2 AND 60);
CREATE UNIQUE INDEX tenant_roles_name_uq ON tenant_roles (tenant_id, lower(name));
