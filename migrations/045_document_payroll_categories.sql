-- 045: payroll staff and auditors read payroll-category documents only (DECISIONS.md D43). HR marks which categories those are.
ALTER TABLE document_categories ADD COLUMN payroll_related boolean NOT NULL DEFAULT false;
