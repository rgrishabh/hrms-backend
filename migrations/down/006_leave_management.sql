-- Undoes 006. Data: leave is gone, and a day calculated as on_leave becomes absent, since the old status list has nothing nearer. Recalculate days that are not locked.
ALTER TABLE attendance_daily DROP CONSTRAINT attendance_daily_status_check;
UPDATE attendance_daily SET status = 'absent' WHERE status = 'on_leave';
ALTER TABLE attendance_daily ADD CONSTRAINT attendance_daily_status_check
  CHECK (status IN ('present','half_day','absent','missing_punch','weekly_off','holiday','not_joined'));
ALTER TABLE attendance_daily DROP COLUMN leave_fraction, DROP COLUMN leave_type_code;
DROP TABLE leave_ledger, leave_requests, leave_types;
