import { describe, it, expect } from 'vitest';
import { CLASSIFICATION, SYSTEM_COLUMNS, SYSTEM_TABLES, levelOf } from '../src/core/policy/classification.js';
import { ENCRYPTED_COLUMNS } from '../src/core/crypto/columns.js';
import { ownerQuery } from './helpers.js';

const columns = () => ownerQuery<{ table_name: string; column_name: string }>(`SELECT c.table_name, c.column_name FROM information_schema.columns c
  JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name WHERE c.table_schema='public' AND t.table_type='BASE TABLE'`);

describe('data classification', () => {
  it('every column of the schema has a level, unless it is on the explicit exempt lists', async () => {
    const missing = (await columns()).filter((c) => !SYSTEM_TABLES.has(c.table_name) && !SYSTEM_COLUMNS.has(c.column_name) && !levelOf(c.table_name, c.column_name));
    expect(missing.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([]);
  });

  it('the registry names no column that no longer exists', async () => {
    const real = new Set((await columns()).map((c) => `${c.table_name}.${c.column_name}`));
    const stale = Object.entries(CLASSIFICATION).flatMap(([t, cols]) => Object.keys(cols).map((c) => `${t}.${c}`)).filter((c) => !real.has(c));
    expect(stale).toEqual([]);
  });

  it('the levels of the requirement', () => {
    for (const [t, c] of [['employees', 'first_name'], ['employees', 'designation'], ['employees', 'department_id'], ['employees', 'work_email']]) expect(levelOf(t!, c!), `${t}.${c}`).toBe('L1');
    for (const [t, c] of [['employees', 'reporting_manager_id'], ['employees', 'date_of_joining'], ['employees', 'branch_id'], ['attendance_daily', 'status']]) expect(levelOf(t!, c!), `${t}.${c}`).toBe('L2');
    for (const [t, c] of [['employees', 'phone'], ['employees', 'date_of_birth'], ['employee_addresses', 'line1'], ['employee_emergency_contacts', 'phone'], ['leave_requests', 'reason'], ['documents', 'title']]) expect(levelOf(t!, c!), `${t}.${c}`).toBe('L3');
    for (const [t, c] of [['employee_salaries', 'amounts_enc'], ['employee_salaries', 'annual_ctc_enc'], ['payroll_items', 'data_enc'], ['employee_bank_accounts', 'account_number_enc'], ['employee_statutory', 'pan_enc'], ['employee_statutory', 'aadhaar_enc'], ['employee_loans', 'amount'], ['job_offers', 'annual_ctc']]) expect(levelOf(t!, c!), `${t}.${c}`).toBe('L4');
  });

  it('every column that holds ciphertext can be rotated', async () => {
    const enc = (await columns()).filter((c) => c.column_name.endsWith('_enc')).map((c) => `${c.table_name}.${c.column_name}`).sort();
    expect(ENCRYPTED_COLUMNS.map((c) => `${c.table}.${c.column}`).sort()).toEqual(enc);
  });

  it('no plaintext pay column is left', async () => {
    const names = (await columns()).map((c) => `${c.table_name}.${c.column_name}`);
    for (const c of ['employee_salaries.amounts', 'employee_salaries.annual_ctc', 'payroll_items.net', 'payroll_items.gross', 'payroll_items.lines', 'payroll_items.warnings', 'payroll_runs.totals', 'payroll_adjustments.amount', 'accounting_exports.total', 'report_snapshots.rows']) expect(names).not.toContain(c);
  });
});
