-- Undoes 021. Data: a day calculated as on_duty becomes present, since it was paid and the old status list has nothing nearer. Recalculate days that are not locked.
ALTER TABLE attendance_daily DROP CONSTRAINT attendance_daily_status_check;
UPDATE attendance_daily SET status = 'present' WHERE status = 'on_duty';
ALTER TABLE attendance_daily ADD CONSTRAINT attendance_daily_status_check
  CHECK (status IN ('present','half_day','absent','missing_punch','weekly_off','holiday','not_joined','on_leave'));
ALTER TABLE attendance_daily DROP COLUMN duty_fraction;
DROP TABLE field_duty_requests;
