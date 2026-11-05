-- Undoes 032. Data: carry_out entries become adjustments, so every balance adds up as before and the note says what they were; going up again does not turn them back.
ALTER TABLE leave_ledger DROP CONSTRAINT leave_ledger_entry_type_check;
UPDATE leave_ledger SET entry_type = 'adjustment', note = concat_ws(' ', note, '[carry_out before rollback of 032]') WHERE entry_type = 'carry_out';
ALTER TABLE leave_ledger ADD CONSTRAINT leave_ledger_entry_type_check
  CHECK (entry_type IN ('opening','accrual','consumption','reversal','adjustment','carry_forward','lapse'));
DROP TABLE leave_year_closures;
