import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import type { FastifyInstance } from 'fastify';
import { calculate, type CalcInput, type Component } from '../src/modules/payroll/calc.js';
import { checkAdjustmentAmount, openTotals, sealItem, sealSalary, visibleRunTotals } from '../src/modules/payroll/sealed.js';
import { approvedLeaveByDate, assertApplicable, dateFraction, loadEmployee, yearClosed, type EmployeeLite, type LeaveType } from '../src/modules/leave/service.js';
import { runAccruals, insertLedgerEntry } from '../src/modules/leave/jobs.js';
import { applyRecoveries, balanceOf, closeRepaid, outstandingOf, plannedRecoveries } from '../src/modules/loans/service.js';
import { calculateDay, type ShiftPolicy } from '../src/modules/attendance/calc.js';
import { assertSubjectVisible, l4RowFilter, subjectVisible, hiddenSubjects, maskFields, type PolicyViewer } from '../src/core/policy/salary.js';
import { FEATURES, validateRegistry, type FeatureDefinition } from '../src/core/features/registry.js';
import { loadEnv, loadInstallationEnv } from '../src/config/env.js';
import { reconcileInstallation } from '../src/config/installation.js';
import { withTenant } from '../src/db/tx.js';
import { createTenant, flags, inApp, makeApp, ownerQuery, seal, testCipher, type TenantFixture } from './helpers.js';
import { TEST_BRAND } from './env.js';
import { setDataCipher } from '../src/core/crypto/index.js';

const comp = (code: string, o: Partial<Component> = {}): Component => ({
  code,
  name: code,
  kind: 'earning',
  calc: 'fixed',
  base_codes: [],
  prorate: true,
  taxable: true,
  pf_wage: false,
  esi_wage: false,
  position: 1,
  ...o,
});
const base = (o: Partial<CalcInput> = {}): CalcInput => ({
  month: 6,
  daysInPeriod: 30,
  paidDays: 30,
  components: [comp('BASIC')],
  amounts: { BASIC: 30000 },
  adjustments: [],
  statutory: { pfExcluded: true, regime: 'new', ptState: 'X' },
  rules: {},
  expect: [],
  ...o,
});
const TDS = { slabs: [{ upTo: null, rate: 10 }], standardDeduction: 0, rebateLimit: 0, rebateMax: 0, cessRate: 0 };

describe('payroll calculation rules', () => {
  it('a percentage of a component this salary lacks warns, and counts it as nothing', () => {
    const r = calculate(base({ components: [comp('BASIC'), comp('HRA', { calc: 'percent', base_codes: ['BASIC', 'DA'], position: 2 })], amounts: { BASIC: 10000, HRA: 50 } }));
    expect(r.warnings).toContain('HRA: base DA not in this salary');
    expect(r.lines.find((l) => l.code === 'HRA')?.amount).toBe(5000);
  });

  it('the same warning from two salary stretches is said once', () => {
    const percent = comp('HRA', { calc: 'percent', base_codes: ['DA'], position: 2 });
    const r = calculate(
      base({
        components: [comp('BASIC'), percent],
        amounts: { BASIC: 10000, HRA: 50 },
        segments: [
          { amounts: { BASIC: 10000, HRA: 50 }, paidDays: 15, days: 15 },
          { amounts: { BASIC: 12000, HRA: 50 }, paidDays: 15, days: 15, from: '2030-06-16' },
        ],
      }),
    );
    expect(r.warnings.filter((w) => w === 'HRA: base DA not in this salary')).toHaveLength(1);
  });

  it('a period with no days pays nothing from its stretches', () => {
    const r = calculate(base({ daysInPeriod: 0, paidDays: 0, segments: [{ amounts: { BASIC: 10000 }, paidDays: 0, days: 1 }] }));
    expect(r.gross).toBe(0);
  });

  it('PT: an amount for this month beats the slab amount, and no slab means none', () => {
    const pt = {
      slabs: [
        { upTo: 5000, amount: 0 },
        { upTo: null, amount: 200, monthAmounts: { '06': 300 } },
      ],
    };
    const inJune = calculate(base({ rules: { pt: pt as never } }));
    expect(inJune.lines.find((l) => l.code === 'PT')?.amount).toBe(300);
    const inJuly = calculate(base({ month: 7, rules: { pt: pt as never } }));
    expect(inJuly.lines.find((l) => l.code === 'PT')?.amount).toBe(200);
    expect(calculate(base({ rules: { pt: { slabs: [{ upTo: 100, amount: 7 }] } as never } })).lines.find((l) => l.code === 'PT')).toBeUndefined();
  });

  it('LWF: each side only when it is above nothing', () => {
    const lwf = (employee: number, employer: number) =>
      calculate(base({ rules: { lwf: { employee, employer, months: [6] } as never } }))
        .lines.filter((l) => l.code.startsWith('LWF'))
        .map((l) => l.code);
    expect(lwf(5, 0)).toEqual(['LWF_EE']);
    expect(lwf(0, 7)).toEqual(['LWF_ER']);
    expect(lwf(0, 0)).toEqual([]);
  });

  it('a supplementary run: only the one-off is paid, its tax over the salary it did not pay, and no second PT', () => {
    const r = calculate(
      base({
        supplementary: true,
        adjustments: [{ kind: 'earning', label: 'Bonus', amount: 12000, taxable: true }],
        rules: { tds: TDS as never, pt: { slabs: [{ upTo: null, amount: 200 }] } as never },
      }),
    );
    expect(r.gross).toBe(12000);
    expect(r.lines.find((l) => l.code === 'BASIC')).toBeUndefined();
    expect(r.lines.find((l) => l.code === 'PT')).toBeUndefined();
    // 10% on the one-off, all of it this month.
    expect(r.lines.find((l) => l.code === 'TDS')?.amount).toBe(1200);
    // The same bonus on a regular run spreads the salary's tax over twelve months.
    const regular = calculate(base({ adjustments: [{ kind: 'earning', label: 'Bonus', amount: 12000, taxable: true }], rules: { tds: TDS as never } }));
    expect(regular.lines.find((l) => l.code === 'TDS')?.amount).toBe(4200);
  });

  it('a taxable component missing from the salary adds nothing to the year', () => {
    const r = calculate(base({ components: [comp('BASIC'), comp('SPECIAL', { position: 2 })], rules: { tds: TDS as never } }));
    expect(r.lines.find((l) => l.code === 'TDS')?.amount).toBe(3000);
  });
});

describe('one-offs over a salary that lacks a component', () => {
  it('a supplementary run counts only what the salary has toward the year', () => {
    const r = calculate(
      base({
        supplementary: true,
        components: [comp('BASIC'), comp('SPECIAL', { position: 2 })],
        adjustments: [{ kind: 'earning', label: 'Bonus', amount: 1000, taxable: true }],
        rules: { tds: TDS as never },
      }),
    );
    expect(r.lines.find((l) => l.code === 'TDS')?.amount).toBe(100);
  });
});

describe('sealed pay', () => {
  beforeAll(() => {
    setDataCipher(testCipher);
  });
  it('refuses what cannot be a figure', () => {
    expect(() => sealItem({ lines: [], gross: Number.NaN, deductions: 0, net: 0, employerCost: 0, warnings: [] })).toThrow(/gross is not a number/);
    expect(() => checkAdjustmentAmount('earning', 1e10)).toThrow(/too large/);
  });
  it('no CTC stays no CTC; no totals stay no totals', () => {
    expect(sealSalary({ BASIC: 1 }, null).annual_ctc_enc).toBeNull();
    expect(sealSalary({ BASIC: 1 }, 12).annual_ctc_enc).not.toBeNull();
    expect(openTotals(null)).toBeNull();
    expect(openTotals(seal({ employees: 1, gross: 5, deductions: 1, net: 4, employerCost: 5, held: 0 }))).toMatchObject({ net: 4 });
  });
});

describe('leave rules', () => {
  const type = (o: Partial<LeaveType>) => ({ name: 'CL', status: 'active', applicable_employment_types: [], eligible_after_days: 0, ...o }) as LeaveType;
  const emp = { employment_type: 'contract', date_of_joining: '2030-01-01' } as EmployeeLite;
  it('a type that does not apply says why', () => {
    expect(() => assertApplicable(type({ status: 'inactive' }), emp, '2030-06-01')).toThrow(/not currently available/);
    expect(() => assertApplicable(type({ applicable_employment_types: ['permanent'] }), emp, '2030-06-01')).toThrow();
    expect(() => assertApplicable(type({ eligible_after_days: 365 }), emp, '2030-06-01')).toThrow();
    expect(() => assertApplicable(type({ applicable_employment_types: ['contract'], eligible_after_days: 10 }), emp, '2030-06-01')).not.toThrow();
  });
  it('a date outside a request counts as nothing', () => {
    expect(dateFraction('2030-01-01', { start_date: '2030-02-01', end_date: '2030-02-02', start_half: 'full', end_half: 'full' } as never)).toBe(0);
    expect(dateFraction('2030-03-01', { start_date: '2030-02-01', end_date: '2030-02-02', start_half: 'full', end_half: 'full' } as never)).toBe(0);
  });
});

describe('attendance calculation rules', () => {
  const shift: ShiftPolicy = {
    id: 's',
    code: 'G',
    startTime: '09:00',
    endTime: '18:00',
    breakMinutes: 0,
    graceMinutes: 0,
    earlyExitGraceMinutes: 0,
    halfDayMinMinutes: 240,
    fullDayMinMinutes: 480,
    overtimeAfterMinutes: null,
  };
  const at = (h: string) => new Date(`2030-06-03T${h}:00+05:30`);
  const day = (o: Partial<Parameters<typeof calculateDay>[0]>) =>
    calculateDay({
      workDate: '2030-06-03',
      timezone: 'Asia/Kolkata',
      shift,
      dayType: 'working',
      punches: [],
      minGapSeconds: 0,
      overtimeEnabled: false,
      employment: { joiningDate: '2020-01-01', exitDate: null },
      leave: null,
      duty: null,
      ...o,
    });

  it('the latest correction wins, with or without a sequence', () => {
    const r = day({
      punches: [
        { id: 'r1', time: at('10:00'), direction: 'in', source: 'regularization' },
        { id: 'r2', time: at('09:30'), direction: 'in', source: 'regularization', seq: 5 },
        { id: 'o1', time: at('18:00'), direction: 'out', source: 'regularization', seq: 1 },
      ],
    });
    expect(r.firstIn?.toISOString()).toBe(at('09:30').toISOString());
  });

  it('corrections with no sequence at all keep their order, and one still wins', () => {
    const r = day({
      punches: [
        { id: 'r1', time: at('09:15'), direction: 'in', source: 'regularization' },
        { id: 'r2', time: at('09:45'), direction: 'in', source: 'regularization' },
        { id: 'r3', time: at('10:15'), direction: 'in', source: 'regularization' },
      ],
    });
    expect(r.firstIn?.toISOString()).toBe(at('09:15').toISOString());
  });

  it('the latest correction wins whichever arrives first', () => {
    const r = day({
      punches: [
        { id: 'r2', time: at('09:30'), direction: 'in', source: 'regularization', seq: 5 },
        { id: 'r1', time: at('10:00'), direction: 'in', source: 'regularization' },
        { id: 'o1', time: at('18:00'), direction: 'out', source: 'regularization', seq: 1 },
      ],
    });
    expect(r.firstIn?.toISOString()).toBe(at('09:30').toISOString());
  });

  it('a correction at the same instant as another punch keeps a fixed order', () => {
    const with_ = (ids: [string, string]) =>
      day({
        punches: [
          { id: 'first', time: at('09:00'), direction: 'in' },
          { id: ids[0], time: at('13:00'), direction: 'in' },
          { id: ids[1], time: at('13:00'), direction: 'in', source: 'regularization', seq: 1 },
          { id: 'last', time: at('18:00'), direction: 'out' },
        ],
      });
    expect(with_(['a', 'b']).firstIn?.toISOString()).toBe(at('13:00').toISOString());
    expect(with_(['b', 'a']).workedMinutes).toBe(with_(['a', 'b']).workedMinutes);
  });

  it('work on a day off is flagged; it is overtime only where overtime is on', () => {
    const punches = [
      { id: 'i', time: at('09:00'), direction: 'in' as const },
      { id: 'o', time: at('13:00'), direction: 'out' as const },
    ];
    const off = day({ dayType: 'weekly_off', punches });
    expect(off.exceptions).toContain('worked_on_weekly_off');
    expect(off.overtimeMinutes).toBe(0);
    expect(day({ dayType: 'weekly_off', punches, overtimeEnabled: true }).overtimeMinutes).toBe(240);
  });

  it('punches at one instant are ordered by id, so the result does not depend on arrival', () => {
    const a = day({
      punches: [
        { id: 'b', time: at('09:00'), direction: 'in' },
        { id: 'a', time: at('09:00'), direction: 'in' },
        { id: 'c', time: at('18:00'), direction: 'out' },
      ],
    });
    const b = day({
      punches: [
        { id: 'c', time: at('18:00'), direction: 'out' },
        { id: 'a', time: at('09:00'), direction: 'in' },
        { id: 'b', time: at('09:00'), direction: 'in' },
      ],
    });
    expect(a.workedMinutes).toBe(b.workedMinutes);
  });

  it('leave charged on a day off: half or whole, and none with no fraction', () => {
    const off = (fraction: number) => day({ dayType: 'weekly_off', leave: { fraction, code: 'CL', chargedOnOffDay: true, paid: true } as never });
    expect(off(0.5)).toMatchObject({ leaveFraction: 0.5, leaveTypeCode: 'CL' });
    expect(off(1)).toMatchObject({ leaveFraction: 1, leaveTypeCode: 'CL' });
    expect(off(0).leaveFraction).toBe(0);
  });
});

describe('the salary policy refuses what it cannot quote', () => {
  const v = (o: Partial<PolicyViewer>): PolicyViewer => ({ userId: 'u', employeeId: null, level: 10, has: () => true, ...o });
  it('an id or a level that is not one never reaches SQL', () => {
    expect(() => l4RowFilter(v({ employeeId: "1'; DROP TABLE x" }), 'e')).toThrow('Not a uuid');
    expect(() => l4RowFilter(v({ level: 1.5 }), 'e')).toThrow('Not a level');
  });
  it('masking: an empty field is not reported as masked; nothing masked adds no keys', () => {
    expect(maskFields({ a: 1, b: null }, ['a', 'b'])).toEqual({ a: null, b: null, masked: true, maskedFields: ['a'] });
    expect(maskFields({ a: null }, ['a'])).toEqual({ a: null });
    expect(maskFields({ a: 1 }, ['a', 'absent'])).toEqual({ a: null, masked: true, maskedFields: ['a'] });
  });
});

describe('the feature registry catches its own mistakes', () => {
  const f = (o: Partial<FeatureDefinition>): FeatureDefinition => ({
    key: 'a',
    envName: 'FEATURE_A',
    name: 'A',
    description: '',
    category: 'operations',
    availability: 'available',
    defaultEnabled: false,
    dependencies: [],
    core: false,
    ...o,
  });
  it.each([
    [[f({ dependencies: ['nope'] })], {}, /unknown feature nope/],
    [[f({ dependencies: ['b'] }), f({ key: 'b', envName: 'FEATURE_B', dependencies: ['a'] })], {}, /cycle/],
    [[f({ envName: null })], {}, /no environment variable/],
    [[f({ core: true })], {}, /cannot have a flag/],
    [[f({})], { ghost: 'FEATURE_GHOST' }, /unknown feature ghost/],
  ] as const)('case %#', (features, env, err) => {
    expect(() => validateRegistry(features, env)).toThrow(err);
  });
  it('the real one is valid', () => {
    expect(() => validateRegistry(FEATURES, {})).not.toThrow();
  });
});

describe("the bootstrap task's smaller configuration", () => {
  it('says what is wrong', () => {
    expect(() => loadInstallationEnv({ NODE_ENV: 'test' })).toThrow(/Invalid deployment configuration/);
  });
});

describe('deployment configuration refusals', () => {
  const env = (o: Record<string, string>) =>
    loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://a@b/c',
      COOKIE_SECURE: 'false',
      DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      ...TEST_BRAND,
      ...flags('default'),
      ...o,
    });
  it.each([
    [{ MFA_AVAILABLE: 'true', MFA_ENFORCED: 'true', MFA_METHODS: 'email' }, /only email codes needs SMTP_HOST/],
    [{ STORAGE_DRIVER: 'local' }, /needs STORAGE_PATH/],
    [{ STORAGE_DRIVER: 's3' }, /needs AWS_S3_BUCKET/],
    [{ PORT: 'not-a-port' }, /Invalid deployment configuration/],
    [{ TRUST_PROXY: '1.2.3.4,not an ip' }, /TRUST_PROXY/],
  ] as const)('%j', (o, err) => {
    expect(() => env(o)).toThrow(err);
  });
  it('email-only MFA enforced is fine with SMTP', () => {
    expect(env({ MFA_AVAILABLE: 'true', MFA_ENFORCED: 'true', MFA_METHODS: 'email', SMTP_HOST: 'mail.test', ...flags('default,notifications.email') }).MFA_ENFORCED).toBe(true);
  });
});

describe('rules that read the database', () => {
  let app: FastifyInstance;
  let T: TenantFixture;
  const tx = <R>(fn: (db: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<R>) => inApp(app, () => withTenant(app.deps.pool, T.id, fn));
  beforeAll(async () => {
    app = await makeApp({ ...flags('default,payroll,loans') });
    T = await createTenant();
  });
  afterAll(() => app.close());

  it('an unknown employee, a year not closed, an unknown loan', async () => {
    const nobody = '00000000-0000-4000-8000-000000000000';
    expect(await tx((db) => loadEmployee(db, T.id, nobody))).toBeNull();
    expect(await tx((db) => yearClosed(db, T.id, 2001))).toBe(false);
    expect(await tx((db) => balanceOf(db, T.id, nobody))).toEqual({ amount: '0.00', outstanding: '0.00', recovered: '0.00', inProgress: '0.00' });
    expect(await tx((db) => outstandingOf(db, T.id, []))).toEqual(new Map());
    expect(await tx((db) => closeRepaid(db, T.id, [nobody]))).toBe(0);
    await expect(tx((db) => assertSubjectVisible(db, T.id, { userId: 'u', employeeId: null, level: 0, has: () => false }, nobody, 'Gone'))).rejects.toThrow('Gone');
    expect(await tx((db) => subjectVisible(db, T.id, { userId: 'u', employeeId: null, level: 100, has: () => true }, nobody))).toBe(false);
    expect(await tx((db) => hiddenSubjects(db, T.id, { userId: 'u', employeeId: null, level: 0, has: () => false }, []))).toEqual(new Set());
  });

  it('two leaves on one day add up, and days outside the window are left out', async () => {
    const emp = T.users.employee!.employeeId!;
    const [cl] = await ownerQuery<{ id: string }>(`INSERT INTO leave_types (tenant_id, code, name, paid, allow_half_day) VALUES ($1,'CLX','Casual',true,true) RETURNING id`, [
      T.id,
    ]);
    const [sl] = await ownerQuery<{ id: string }>(`INSERT INTO leave_types (tenant_id, code, name, paid, allow_half_day) VALUES ($1,'SLX','Sick',true,true) RETURNING id`, [T.id]);
    const add = (typeId: string, from: string, to: string, sh: string, eh: string) =>
      ownerQuery(
        `INSERT INTO leave_requests (tenant_id, employee_id, leave_type_id, leave_year, start_date, end_date, start_half, end_half, days, reason, status, requested_by)
      VALUES ($1,$2,$3,2040,$4,$5,$6,$7,1,'Fixture reason','approved',$8)`,
        [T.id, emp, typeId, from, to, sh, eh, T.users.employee!.id],
      );
    await add(cl!.id, '2040-03-01', '2040-03-05', 'full', 'first_half');
    await add(sl!.id, '2040-03-05', '2040-03-09', 'second_half', 'full');
    const inWindow = await tx((db) => approvedLeaveByDate(db, T.id, emp, '2040-03-03', '2040-03-06'));
    expect([...inWindow.keys()].sort()).toEqual(['2040-03-03', '2040-03-04', '2040-03-05', '2040-03-06']);
    expect(inWindow.get('2040-03-05')).toMatchObject({ fraction: 1, code: 'CLX+SLX' });
    expect(inWindow.get('2040-03-06')).toMatchObject({ fraction: 1, code: 'SLX' });
  });

  it('loans: what a run plans and takes', async () => {
    const emp = T.users.other!.employeeId!;
    const loan = async (amount: number, installment: number, first: string, skip: string[] = []) =>
      (
        await ownerQuery<{ id: string }>(
          `INSERT INTO employee_loans (tenant_id, employee_id, kind, amount, installments, installment_amount, first_period, skip_periods, status, purpose, created_by, disbursed_at)
      VALUES ($1,$2,'loan',$3,4,$4,$5,$6,'disbursed','Fixture loan',$7,now()) RETURNING id`,
          [T.id, emp, amount, installment, first, skip, T.users.payroll!.id],
        )
      )[0]!.id;
    const [run] = await ownerQuery<{ id: string }>(
      `INSERT INTO payroll_runs (tenant_id, legal_entity_id, period, kind, employee_id, created_by, status) VALUES ($1,$2,'2041-01','regular',NULL,$3,'draft') RETURNING id`,
      [T.id, T.legalEntityId, T.users.payroll!.id],
    );
    const running = await loan(4000, 1000, '2041-01');
    await loan(4000, 1000, '2041-05'); // not started
    await loan(4000, 1000, '2041-01', ['2041-01']); // deferred this month
    const paidOff = await loan(1000, 1000, '2041-01');
    await ownerQuery(`INSERT INTO loan_recoveries (tenant_id, loan_id, source, period, amount) VALUES ($1,$2,'repayment','2040-12',1000)`, [T.id, paidOff]);
    const planned = await tx((db) => plannedRecoveries(db, T.id, run!.id, emp, '2041-01', false));
    expect(planned.map((p) => p.loanId)).toEqual([running]);
    expect(planned[0]!.label).toContain('(1 of 4)');
    expect(planned[0]!.amount.toNumber()).toBe(1000);
    const fnf = await tx((db) => plannedRecoveries(db, T.id, run!.id, emp, '2041-01', true));
    expect(fnf.find((p) => p.loanId === running)?.label).toContain('balance');
    expect(fnf.find((p) => p.loanId === running)?.amount.toNumber()).toBe(4000);
    expect(fnf.find((p) => p.loanId === paidOff)).toBeUndefined();
    // Net pay runs out: the second is cut short, the third gets nothing and adds no line.
    const taken = await tx((db) =>
      applyRecoveries(
        db,
        T.id,
        run!.id,
        '2041-01',
        [
          { loanId: running, kind: 'loan', amount: new Decimal(1000), label: 'First', ref: running },
          { loanId: paidOff, kind: 'loan', amount: new Decimal(1000), label: 'Second', ref: paidOff },
          { loanId: running, kind: 'loan', amount: new Decimal(1000), label: 'Third', ref: running },
        ],
        1500,
      ).catch((e: unknown) => {
        throw e;
      }),
    );
    expect(taken.adjustments.map((a) => [a.code, a.amount])).toEqual([
      ['LOAN', 1000],
      ['LOAN2', 500],
    ]);
    expect(taken.warnings.length).toBe(2);
    await ownerQuery(`DELETE FROM loan_recoveries WHERE tenant_id=$1 AND payroll_run_id=$2`, [T.id, run!.id]);
    expect(await tx((db) => closeRepaid(db, T.id, [emp]))).toBe(1);
    expect((await ownerQuery<{ status: string }>(`SELECT status FROM employee_loans WHERE id=$1`, [paidOff]))[0]!.status).toBe('closed');
  });

  it('a held slip in a final run is not recovered yet; a repayment is', async () => {
    const emp = T.users.manager!.employeeId!;
    const [l] = await ownerQuery<{ id: string }>(
      `INSERT INTO employee_loans (tenant_id, employee_id, kind, amount, installments, installment_amount, first_period, status, purpose, created_by, disbursed_at)
      VALUES ($1,$2,'loan',3000,3,1000,'2042-01','disbursed','Fixture loan',$3,now()) RETURNING id`,
      [T.id, emp, T.users.payroll!.id],
    );
    const [run] = await ownerQuery<{ id: string }>(
      `INSERT INTO payroll_runs (tenant_id, legal_entity_id, period, kind, created_by, status) VALUES ($1,$2,'2042-01','regular',$3,'computed') RETURNING id`,
      [T.id, T.legalEntityId, T.users.payroll!.id],
    );
    await ownerQuery(
      `INSERT INTO payroll_items (tenant_id, run_id, employee_id, days_in_period, employed_days, lop_days, paid_days, data_enc, hold, calc_version) VALUES ($1,$2,$3,31,31,0,31,$4,true,1)`,
      [T.id, run!.id, emp, seal({ lines: [], gross: 1, deductions: 0, net: 1, employerCost: 1, warnings: [] })],
    );
    await ownerQuery(`INSERT INTO loan_recoveries (tenant_id, loan_id, source, payroll_run_id, period, amount) VALUES ($1,$2,'payroll',$3,'2042-01',1000)`, [T.id, l!.id, run!.id]);
    await ownerQuery(`UPDATE payroll_runs SET status='finalized', finalized_at=now() WHERE id=$1`, [run!.id]);
    await ownerQuery(`INSERT INTO loan_recoveries (tenant_id, loan_id, source, period, amount) VALUES ($1,$2,'repayment','2042-02',500)`, [T.id, l!.id]);
    const b = await tx((db) => balanceOf(db, T.id, l!.id));
    expect(b).toMatchObject({ recovered: '500.00', outstanding: '1500.00', inProgress: '1000.00' });
  });

  it('a recovery in a cancelled run counts for nothing', async () => {
    const emp = T.users.hr!.employeeId ?? T.users.manager!.employeeId!;
    const [l] = await ownerQuery<{ id: string; amount: string }>(
      `INSERT INTO employee_loans (tenant_id, employee_id, kind, amount, installments, installment_amount, first_period, status, purpose, created_by, disbursed_at)
      VALUES ($1,$2,'loan',3000,3,1000,'2045-01','disbursed','Fixture loan',$3,now()) RETURNING id, amount::text`,
      [T.id, emp, T.users.payroll!.id],
    );
    const [run] = await ownerQuery<{ id: string }>(
      `INSERT INTO payroll_runs (tenant_id, legal_entity_id, period, kind, created_by, status) VALUES ($1,$2,'2045-01','regular',$3,'cancelled') RETURNING id`,
      [T.id, T.legalEntityId, T.users.payroll!.id],
    );
    await ownerQuery(`INSERT INTO loan_recoveries (tenant_id, loan_id, source, payroll_run_id, period, amount) VALUES ($1,$2,'payroll',$3,'2045-01',1000)`, [T.id, l!.id, run!.id]);
    expect(await tx((db) => balanceOf(db, T.id, l!.id))).toMatchObject({ outstanding: '3000.00', recovered: '0.00', inProgress: '0.00' });
    expect((await tx((db) => outstandingOf(db, T.id, [l!]))).get(l!.id)).toBe('3000.00');
    // Closing with no list looks at the whole organization: this loan is not paid up, so it stays.
    await tx((db) => closeRepaid(db, T.id));
    expect((await ownerQuery<{ status: string }>(`SELECT status FROM employee_loans WHERE id=$1`, [l!.id]))[0]!.status).toBe('disbursed');
  });

  it('the policy lets a visible subject through, and names who is hidden', async () => {
    const emp = T.users.employee!.employeeId!;
    const low = { userId: 'u', employeeId: null, level: 0, has: () => true };
    const high = { ...low, level: 100 };
    await expect(tx((db) => assertSubjectVisible(db, T.id, high, emp))).resolves.toBeUndefined();
    expect(await tx((db) => hiddenSubjects(db, T.id, high, [emp]))).toEqual(new Set());
    expect(await tx((db) => hiddenSubjects(db, T.id, low, [emp]))).toEqual(new Set([emp]));
  });

  it('monthly accrual stops at the exit date', async () => {
    const emp = T.users.manager!.employeeId!;
    const [t] = await ownerQuery<{ id: string }>(
      `INSERT INTO leave_types (tenant_id, code, name, paid, accrual_method, annual_entitlement) VALUES ($1,'MTH','Monthly',true,'monthly',12) RETURNING id`,
      [T.id],
    );
    await ownerQuery(`UPDATE employees SET exit_date='2046-02-15', status='on_notice' WHERE id=$1`, [emp]);
    await tx((db) => runAccruals(db, T.id, 2046, 12, null));
    const rows = await ownerQuery<{ n: number }>(`SELECT count(*)::int AS n FROM leave_ledger WHERE tenant_id=$1 AND leave_type_id=$2 AND employee_id=$3`, [T.id, t!.id, emp]);
    expect(rows[0]!.n).toBeGreaterThan(0);
    expect(rows[0]!.n).toBeLessThan(12);
    await ownerQuery(`UPDATE employees SET exit_date=NULL, status='active' WHERE id=$1`, [emp]);
  });

  it('a negative net counts as held in run totals', async () => {
    const emp = T.users.it!.employeeId ?? T.users.hr!.employeeId;
    if (!emp) return;
    const [run] = await ownerQuery<{ id: string }>(
      `INSERT INTO payroll_runs (tenant_id, legal_entity_id, period, kind, created_by, status) VALUES ($1,$2,'2043-01','regular',$3,'computed') RETURNING id`,
      [T.id, T.legalEntityId, T.users.payroll!.id],
    );
    await ownerQuery(
      `INSERT INTO payroll_items (tenant_id, run_id, employee_id, days_in_period, employed_days, lop_days, paid_days, data_enc, hold, calc_version) VALUES ($1,$2,$3,31,31,0,31,$4,true,1)`,
      [T.id, run!.id, emp, seal({ lines: [], gross: 1, deductions: 5, net: -4, employerCost: 1, warnings: [] })],
    );
    const totals = await tx((db) => visibleRunTotals(db, T.id, { userId: 'u', employeeId: null, level: 100, has: () => true }, run!.id));
    expect(totals).toMatchObject({ held: 1, net: -4 });
  });

  it('accrual: a type for other employment types, and a credit made twice, add nothing', async () => {
    const emp = T.users.employee!.employeeId!;
    const [t] = await ownerQuery<{ id: string }>(
      `INSERT INTO leave_types (tenant_id, code, name, paid, accrual_method, annual_entitlement, applicable_employment_types) VALUES ($1,'ONLYC','Only contract',true,'annual',12,'{no_such_type}') RETURNING id`,
      [T.id],
    );
    expect(
      await tx(async (db) => {
        await runAccruals(db, T.id, 2044, 12, null);
        return (await db.query(`SELECT count(*)::int AS n FROM leave_ledger WHERE tenant_id=$1 AND leave_type_id=$2`, [T.id, t!.id])).rows[0]!.n;
      }),
    ).toBe(0);
    const entry = { empId: emp, typeId: t!.id, year: 2044, entryType: 'adjustment', days: new Decimal(1), reference: 'once', actorId: null };
    expect(await tx((db) => insertLedgerEntry(db, T.id, entry))).toBe(true);
    expect(await tx((db) => insertLedgerEntry(db, T.id, entry))).toBe(false);
  });
});

describe('reconciling the installation', () => {
  const fake = (rows: Record<string, { rows: unknown[]; rowCount: number }>) =>
    ({
      query: async (sql: string) => {
        for (const [k, v] of Object.entries(rows)) if (sql.includes(k)) return v;
        return { rows: [], rowCount: 0 };
      },
    }) as never;
  const env = {
    BRAND_NAME: 'X',
    BRAND_TIMEZONE: 'Asia/Kolkata',
    BRAND_DOMAIN: 'x.test',
    BRAND_EXTRA_DOMAINS: [],
    BRAND_LEGAL_NAME: undefined,
    COOKIE_SECURE: false,
    NODE_ENV: 'test',
  } as never;
  it('more than one organization stops it; none means not bootstrapped', async () => {
    await expect(reconcileInstallation(fake({ 'FROM tenants': { rows: [{ id: 'a' }, { id: 'b' }], rowCount: 2 } }), env)).rejects.toThrow(/exactly one/);
    expect(await reconcileInstallation(fake({ 'FROM tenants': { rows: [], rowCount: 0 } }), env)).toBeNull();
  });
  it('in production the certificate state is issued; locally it was not asked for', async () => {
    const seen: unknown[][] = [];
    const db = {
      query: async (sql: string, args: unknown[] = []) => {
        seen.push(args);
        return sql.includes('FROM tenants') ? { rows: [{ id: 'a' }], rowCount: 1 } : { rows: [], rowCount: 0 };
      },
    } as never;
    await reconcileInstallation(db, { ...(env as object), NODE_ENV: 'production' } as never);
    expect(seen.flat()).toContain('issued');
    seen.length = 0;
    await reconcileInstallation(db, env);
    expect(seen.flat()).toContain('not_requested');
  });

  it('a hostname of another organization is refused', async () => {
    await expect(
      reconcileInstallation(fake({ 'FROM tenants': { rows: [{ id: 'a' }], rowCount: 1 }, tenant_domains: { rows: [{ tenant_id: 'other' }], rowCount: 1 } }), env),
    ).rejects.toThrow(/belongs to another organization/);
  });
});
