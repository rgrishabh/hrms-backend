-- Undoes 036. btree_gist is left alone if another role owns it: it was there before us.
ALTER TABLE leave_requests DROP CONSTRAINT leave_requests_no_overlap;
ALTER TABLE leave_requests DROP COLUMN overlap_legacy;
DROP FUNCTION leave_half_slots(date, text, date, text);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension e WHERE e.extname = 'btree_gist' AND pg_has_role(current_user, e.extowner, 'MEMBER')) THEN
    DROP EXTENSION btree_gist;
  END IF;
END $$;
