-- 036: the database refuses overlapping open leave for one employee (F-13). Half days are half-day slots, so a morning and
-- an afternoon on one date fit together.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE FUNCTION leave_half_slots(start_date date, start_half text, end_date date, end_half text) RETURNS int4range
  LANGUAGE sql IMMUTABLE AS $$
  SELECT int4range((start_date - DATE '2000-01-01') * 2 + CASE WHEN start_half = 'second_half' THEN 1 ELSE 0 END,
                   (end_date - DATE '2000-01-01') * 2 + CASE WHEN end_half = 'first_half' THEN 1 ELSE 2 END)
$$;

-- Overlaps that already exist (the application check could race) are left for HR to resolve, not cancelled here, and do
-- not stop the constraint from applying to everything new. Find them with: WHERE overlap_legacy AND status IN ('pending','approved').
ALTER TABLE leave_requests ADD COLUMN overlap_legacy boolean NOT NULL DEFAULT false;
SELECT set_config('app.platform_bypass', 'on', true);
UPDATE leave_requests a SET overlap_legacy = true
 WHERE a.status IN ('pending','approved') AND EXISTS (
   SELECT 1 FROM leave_requests b WHERE b.tenant_id = a.tenant_id AND b.employee_id = a.employee_id AND b.id <> a.id AND b.status IN ('pending','approved')
     AND leave_half_slots(b.start_date, b.start_half, b.end_date, b.end_half) && leave_half_slots(a.start_date, a.start_half, a.end_date, a.end_half));

ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_no_overlap
  EXCLUDE USING gist (tenant_id WITH =, employee_id WITH =, leave_half_slots(start_date, start_half, end_date, end_half) WITH &&)
  WHERE (status IN ('pending','approved') AND NOT overlap_legacy);
