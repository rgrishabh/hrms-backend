import pg from 'pg';
import { resolveFeatures } from '../core/features/registry.js';
import { currentFeatures } from '../core/features/state.js';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataCipher, hashPassword, setDataCipher, type FieldCipher } from '../core/crypto/index.js';
import { loadFieldCipherFromProcess } from '../core/crypto/keys.js';
import { assignableRoles } from '../core/auth/permissions.js';
import { currentMode, withMode, type ManagementMode } from '../core/policy/mode.js';
import { pgSsl } from './ssl.js';
// Same type parsing as the app (DATE and NUMERIC as strings): the attendance engine compares dates as text,
// so without it every demo day was calculated without its shift (no late, early-exit or overtime minutes).
import './pool.js';
import { recalculateRange } from '../modules/attendance/service.js';
import { countDays, nonWorkingDates } from '../modules/leave/service.js';
import { contentHash } from '../modules/policies/routes.js';
import type { Db } from './tx.js';

/**
 * DEV/DEMO data generator: a realistic, entirely SYNTHETIC 60-person testing laboratory for an
 * already bootstrapped installation (dev, demos, training). Guards:
 *   - runs only with DEMO_DATA_ALLOWED=true (set on the dev "demo" one-off service only);
 *   - refuses when the organization already has employees that are not demo employees (DM-…);
 *   - idempotent: does nothing when demo employees exist.
 * Prints the demo logins and a random password to STDOUT (redirect to a protected file); progress to STDERR.
 * No statutory payroll rule is created: those must be entered from official sources and verified.
 */
const say = (m: string) => { if (!process.env.VITEST) process.stderr.write(`[demo] ${m}\n`); };

// Deterministic PRNG so every run produces the same organization.
const SEED = 20261104;
let seed = SEED;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

const FIRST_M = ['Aditya', 'Rohit', 'Vikram', 'Karan', 'Arjun', 'Suresh', 'Rahul', 'Amit', 'Sandeep', 'Nikhil', 'Pranav', 'Siddharth', 'Manoj', 'Ganesh', 'Imran', 'Harpreet', 'Abhishek', 'Kiran', 'Varun', 'Deepak', 'Mahesh', 'Rajesh', 'Tejas', 'Omkar', 'Faisal'];
const FIRST_F = ['Ananya', 'Sneha', 'Priya', 'Meera', 'Pooja', 'Kavya', 'Neha', 'Shruti', 'Aishwarya', 'Divya', 'Ritu', 'Swati', 'Anjali', 'Fatima', 'Lakshmi', 'Gauri', 'Madhuri', 'Rashmi', 'Simran', 'Tanvi', 'Bhavana', 'Nandini', 'Sana', 'Isha', 'Revathi'];
const LAST = ['Iyer', 'Kulkarni', 'Patil', 'Mehta', 'Nair', 'Rao', 'Shah', 'Deshmukh', 'Joshi', 'Yadav', 'Reddy', 'Sharma', 'Gupta', 'Menon', 'Pillai', 'Jadhav', 'Chavan', 'Pawar', 'Bhat', 'Kamath', 'Shetty', 'Khan', 'Singh', 'Banerjee', 'Das', 'Mishra', 'Agarwal', 'Gokhale', 'Naik', 'Sawant'];
const BRANCHES = [{ code: 'PUN', name: 'Pune Central Laboratory', city: 'Pune', state: 'Maharashtra' }, { code: 'NMB', name: 'Navi Mumbai Laboratory', city: 'Navi Mumbai', state: 'Maharashtra' },
  { code: 'BLR', name: 'Bengaluru Laboratory', city: 'Bengaluru', state: 'Karnataka' }] as const;
const DEPTS = [
  { code: 'WATER', name: 'Water & Wastewater', roles: ['Chemist', 'Senior Chemist', 'Junior Chemist', 'Lab Technician'], n: 9 },
  { code: 'AIR', name: 'Ambient Air & Stack Emission', roles: ['Environmental Engineer', 'Senior Chemist', 'Field Technician'], n: 6 },
  { code: 'SOIL', name: 'Soil & Solid Waste', roles: ['Chemist', 'Lab Technician'], n: 5 },
  { code: 'FOOD', name: 'Food & Agricultural Products', roles: ['Food Analyst', 'Senior Chemist', 'Lab Technician'], n: 6 },
  { code: 'MICRO', name: 'Microbiology', roles: ['Microbiologist', 'Senior Microbiologist', 'Lab Technician'], n: 5 },
  { code: 'INST', name: 'Instrumentation (ICP / GC-MS / HPLC)', roles: ['Instrument Analyst', 'Instrument Engineer'], n: 4 },
  { code: 'FIELD', name: 'Sample Collection', roles: ['Field Sampler', 'Senior Field Sampler', 'Driver cum Sampler'], n: 6 },
  { code: 'QA', name: 'Quality Assurance', roles: ['QA Officer', 'Document Controller'], n: 3 },
  { code: 'HR', name: 'Human Resources & Admin', roles: ['HR Executive', 'Admin Executive'], n: 3 },
  { code: 'FIN', name: 'Finance & Accounts', roles: ['Accountant', 'Payroll Executive'], n: 2 },
  { code: 'IT', name: 'IT & LIMS', roles: ['IT Support Engineer', 'LIMS Administrator'], n: 2 },
] as const;
// Named personas: the demo logins (role keys from the permission catalogue).
const PERSONAS = [
  { key: 'director', first: 'Suresh', last: 'Menon', dept: 'QA', designation: 'Laboratory Director', roles: ['department_head', 'reporting_manager', 'hiring_approver', 'employee'], grade: 'L7' },
  { key: 'hr.head', first: 'Ananya', last: 'Iyer', dept: 'HR', designation: 'HR Manager', roles: ['hr_admin', 'employee'], grade: 'L5' },
  { key: 'hr.exec', first: 'Rohit', last: 'Kulkarni', dept: 'HR', designation: 'HR Executive', roles: ['hr_executive', 'employee'], grade: 'L2' },
  { key: 'payroll', first: 'Sneha', last: 'Patil', dept: 'FIN', designation: 'Payroll Manager', roles: ['payroll_manager', 'employee'], grade: 'L4' },
  { key: 'finance', first: 'Vikram', last: 'Mehta', dept: 'FIN', designation: 'Finance Manager', roles: ['finance_manager', 'employee'], grade: 'L5' },
  { key: 'lab.manager', first: 'Meera', last: 'Nair', dept: 'WATER', designation: 'Laboratory Manager — Water', roles: ['laboratory_manager', 'reporting_manager', 'employee'], grade: 'L5' },
  { key: 'quality', first: 'Arjun', last: 'Rao', dept: 'QA', designation: 'Quality Manager', roles: ['quality_manager', 'employee'], grade: 'L5' },
  { key: 'it', first: 'Karan', last: 'Shah', dept: 'IT', designation: 'IT Manager', roles: ['it_admin', 'employee'], grade: 'L4' },
  { key: 'analyst', first: 'Aditya', last: 'Joshi', dept: 'WATER', designation: 'Chemist', roles: ['employee'], grade: 'L2' },
  { key: 'sampler', first: 'Pooja', last: 'Yadav', dept: 'FIELD', designation: 'Field Sampler', roles: ['employee'], grade: 'L1' },
] as const;
const BASIC_BY_GRADE: Record<string, [number, number]> = { L1: [14000, 17000], L2: [18000, 24000], L3: [25000, 32000], L4: [34000, 45000], L5: [48000, 65000], L7: [90000, 120000] };

/** A persona's roles in this mode: what exists there, and Employee for the rest. The same people, so the three datasets line up. */
export const demoRoles = (roles: readonly string[], mode: ManagementMode) => {
  const allowed = assignableRoles(mode);
  const kept = roles.filter((r) => allowed.includes(r));
  return kept.includes('employee') ? kept : [...kept, 'employee'];
};

export async function generateDemo(c: pg.Client | pg.PoolClient, opts: { password: string; today: string; tenantId?: string; features?: ReadonlySet<string>; mode?: ManagementMode; cipher?: FieldCipher }) {
  const db = c as unknown as Db;
  // Every run from the same start, so a mode can be seeded again and come out the same.
  seed = SEED;
  const mode = opts.mode ?? currentMode();
  const cipher = opts.cipher ?? dataCipher();
  // A module that is off gets no demo data, just as it has no routes.
  const features = opts.features ?? currentFeatures();
  const on = (...keys: string[]) => keys.some((k) => features.has(k));
  const q = <T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, p: unknown[] = []) => c.query<T>(sql, p);
  await q('BEGIN');
  await q(`SELECT set_config('app.platform_bypass', 'on', true)`);
  // tenantId: tests only (the test database holds many organizations); an installation has exactly one.
  const tenants = (await q<{ id: string; name: string }>('SELECT id, name FROM tenants WHERE $1::uuid IS NULL OR id=$1', [opts.tenantId ?? null])).rows;
  if (tenants.length !== 1) { await q('ROLLBACK'); throw new Error('Bootstrap the installation first (exactly one organization expected)'); }
  const tid = tenants[0]!.id;
  const real = Number((await q<{ n: string }>(`SELECT count(*) AS n FROM employees WHERE tenant_id=$1 AND employee_code NOT LIKE 'DM-%'`, [tid])).rows[0]!.n);
  if (real > 0) { await q('ROLLBACK'); throw new Error(`Refusing: the organization already has ${real} non-demo employee(s). Demo data is only for empty dev installations.`); }
  if ((await q(`SELECT 1 FROM employees WHERE tenant_id=$1 AND employee_code LIKE 'DM-%' LIMIT 1`, [tid])).rowCount) { await q('ROLLBACK'); say('demo data already present — nothing to do'); return null; }
  const host = (await q<{ hostname: string }>(`SELECT hostname FROM tenant_domains WHERE tenant_id=$1 ORDER BY created_at LIMIT 1`, [tid])).rows[0]?.hostname;
  const domain = host && host.includes('.') ? host : 'example.test'; // logins need a valid email domain (not "localhost")
  const adminId = (await q<{ id: string }>(`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id AND r.role_key='tenant_admin' WHERE u.tenant_id=$1 ORDER BY u.created_at LIMIT 1`, [tid])).rows[0]?.id;
  if (!adminId) throw new Error('No administrator: run bootstrap first');
  // The smaller modes have an Owner: the bootstrap administrator. It stays when the organization moves up.
  if (mode !== 'multi') await q(`INSERT INTO user_roles (user_id, tenant_id, role_key) SELECT $1,$2,'owner' WHERE NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id=$1 AND role_key='owner')`, [adminId, tid]);
  const today = opts.today;
  const pw = await hashPassword(opts.password);

  // ---- organization
  let le = (await q<{ id: string }>('SELECT id FROM legal_entities WHERE tenant_id=$1 ORDER BY created_at LIMIT 1', [tid])).rows[0]?.id;
  if (!le) le = (await q<{ id: string }>(`INSERT INTO legal_entities (tenant_id, name, state_code) VALUES ($1,$2,'27') RETURNING id`, [tid, `${tenants[0]!.name} Pvt Ltd (demo)`])).rows[0]!.id;
  const branch: Record<string, string> = {};
  for (const b of BRANCHES) branch[b.code] = (await q<{ id: string }>(`INSERT INTO branches (tenant_id, legal_entity_id, code, name, state, city) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (tenant_id, code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [tid, le, b.code, b.name, b.state, b.city])).rows[0]!.id;
  const dept: Record<string, string> = {};
  for (const d of DEPTS) dept[d.code] = (await q<{ id: string }>(`INSERT INTO departments (tenant_id, code, name) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [tid, d.code, d.name])).rows[0]!.id;
  const shift = (await q<{ id: string }>(`INSERT INTO shifts (tenant_id, code, name, start_time, end_time, break_minutes, grace_minutes, early_exit_grace_minutes, half_day_min_minutes, full_day_min_minutes, overtime_after_minutes)
    VALUES ($1,'GEN','General 09:30–18:00','09:30','18:00',30,10,10,240,450,540) ON CONFLICT (tenant_id, code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [tid])).rows[0]!.id;
  const year = Number(today.slice(0, 4));
  if (on('holidays')) for (const y of [year, year + 1]) for (const [d, n] of [['01-26', 'Republic Day'], ['08-15', 'Independence Day'], ['10-02', 'Gandhi Jayanti']])
    await q(`INSERT INTO holidays (tenant_id, holiday_date, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tid, `${y}-${d}`, n]);
  say('organization: 3 branches, 11 departments, general shift, national holidays');

  // ---- employees (personas first, then staff)
  type Emp = { id: string; code: string; first: string; last: string; dept: string; grade: string; userId: string | null; joined: string; branch: string };
  const emps: Emp[] = [];
  let n = 0;
  const mkEmp = async (first: string, last: string, deptCode: string, designation: string, grade: string, manager: string | null, branchCode: string, joined: string, type = 'permanent') => {
    n++;
    const code = `DM-${String(n).padStart(4, '0')}`;
    const email = `${first}.${last}${n > PERSONAS.length ? n : ''}@${domain}`.toLowerCase().replace(/[^a-z0-9.@-]/g, '');
    const id = (await q<{ id: string }>(`INSERT INTO employees (tenant_id, employee_code, first_name, last_name, work_email, phone, legal_entity_id, branch_id, department_id, designation, grade,
        employment_type, reporting_manager_id, date_of_joining, probation_end_date, confirmation_date, date_of_birth)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      [tid, code, first, last, email, `+91 9${int(100000000, 999999999)}`, le, branch[branchCode], dept[deptCode], designation, grade, type, manager, joined,
        type === 'probation' ? addDays(joined, 180) : null, type === 'probation' ? null : addDays(joined, 180), addDays(joined, -int(22, 40) * 365)])).rows[0]!.id;
    await q(`INSERT INTO shift_assignments (tenant_id, employee_id, shift_id, effective_from) VALUES ($1,$2,$3,$4)`, [tid, id, shift, joined]);
    const e = { id, code, first, last, dept: deptCode, grade, userId: null, joined, branch: branchCode };
    emps.push(e);
    return e;
  };
  const personas: Record<string, Emp> = {};
  for (const p of PERSONAS) {
    const mgr = p.key === 'director' ? null : p.key === 'analyst' ? personas['lab.manager']!.id : personas.director?.id ?? null;
    personas[p.key] = await mkEmp(p.first, p.last, p.dept, p.designation, p.grade, mgr, p.key === 'sampler' ? 'NMB' : 'PUN', addDays(today, -int(400, 2500)));
  }
  // department heads (except where a persona already leads)
  const heads: Record<string, string> = { WATER: personas['lab.manager']!.id, QA: personas.quality!.id, HR: personas['hr.head']!.id, FIN: personas.finance!.id, IT: personas.it!.id };
  for (const d of DEPTS) if (!heads[d.code]) {
    const female = rnd() < 0.45;
    heads[d.code] = (await mkEmp(female ? pick(FIRST_F) : pick(FIRST_M), pick(LAST), d.code, `Head — ${d.name}`, 'L5', personas.director!.id, pick(['PUN', 'NMB', 'BLR']), addDays(today, -int(900, 3000)))).id;
  }
  for (const d of DEPTS) for (let i = 0; i < d.n && emps.length < 62; i++) {
    const female = rnd() < 0.45; const grade = pick(['L1', 'L2', 'L2', 'L3', 'L3', 'L4']);
    const recent = rnd() < 0.12;
    await mkEmp(female ? pick(FIRST_F) : pick(FIRST_M), pick(LAST), d.code, pick(d.roles), grade, heads[d.code]!, pick(['PUN', 'PUN', 'NMB', 'BLR']),
      recent ? addDays(today, -int(20, 150)) : addDays(today, -int(200, 3200)), recent ? 'probation' : 'permanent');
  }
  // one joiner next month (pre-joining) for the onboarding demo
  const joiner = await mkEmp('Isha', 'Kamath', 'MICRO', 'Microbiologist', 'L2', heads.MICRO!, 'BLR', addDays(today, 18), 'probation');
  await q(`UPDATE employees SET status='pre_joining' WHERE id=$1`, [joiner.id]);
  // demo bank accounts (synthetic, encrypted at rest would need the app key: skip numbers, keep IFSC-less placeholders out)
  say(`employees: ${emps.length} (incl. ${PERSONAS.length} demo logins, 1 pre-joining)`);

  // ---- logins for personas
  for (const p of PERSONAS) {
    const e = personas[p.key]!;
    const email = `${p.key}@${domain}`;
    const u = (await q<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash, must_change_password) VALUES ($1,$2,$3,$4,false) RETURNING id`,
      [tid, email, `${p.first} ${p.last}`, pw])).rows[0]!.id;
    for (const r of demoRoles(p.roles, mode)) await q(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,$3)`, [u, tid, r]);
    await q(`UPDATE employees SET user_id=$2 WHERE id=$1`, [e.id, u]);
    e.userId = u;
  }
  const uid = (k: string) => personas[k]!.userId!;

  // ---- leave plan (recorded after the leave types exist): a few people took casual or sick leave in the last weeks
  const leavePlan: { e: Emp; start: string; end: string; code: 'CL' | 'SL' }[] = [];
  const onLeave = new Set<string>();
  const personaIds = new Set(Object.values(personas).map((p) => p.id));
  for (const e of [personas.analyst!, ...emps.filter((x) => !personaIds.has(x.id) && x.id !== joiner.id && x.joined < addDays(today, -60))]) {
    if (e !== personas.analyst && rnd() > 0.3) continue;
    const start = addDays(today, -int(3, 26)); const end = addDays(start, rnd() < 0.7 ? 0 : 1);
    if (start < `${year}-01-01`) continue;
    leavePlan.push({ e, start, end, code: rnd() < 0.6 ? 'CL' : 'SL' });
    for (let d = start; d <= end; d = addDays(d, 1)) onLeave.add(`${e.id}:${d}`);
  }

  const dutyPlan: { e: Emp; start: string; end: string; site: [string, string | null, string]; reported: boolean }[] = [];
  const onDuty = new Set<string>();
  // ---- field duty: sample collection staff spend days at client sites (no office punches there). Approved, as the approval
  if (on('field_duty')) {
    // writes it; attendance then shows those days as on duty. The sampler has a two-day trip, a visit not yet reported on, and is out today.
    const SITES: [string, string | null, string][] = [
      ['Chakan MIDC — STP outlet', 'Kiran Auto Components Pvt Ltd', 'field_sampling'], ['Taloja MIDC — ETP', 'Shreeji Dyes & Intermediates', 'field_sampling'],
      ['Hinjewadi Phase 2 — DG stacks', 'Megapolis IT Park', 'field_sampling'], ['Ranjangaon — borewells', 'Ranjangaon Industrial Association', 'field_sampling'],
      ['Vashi — client office', 'Navi Mumbai Municipal Corporation', 'client_visit'], ['Pirangut — ambient air stations', null, 'field_sampling'],
    ];
    const isSunday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() === 0;
    const freeDay = (e: Emp, d: string) => !isSunday(d) && !onLeave.has(`${e.id}:${d}`) && !onDuty.has(`${e.id}:${d}`) && d >= e.joined;
    const planDuty = (e: Emp, start: string, end: string, site: [string, string | null, string], reported = true) => {
      for (let d = start; d <= end; d = addDays(d, 1)) if (!freeDay(e, d)) return;
      dutyPlan.push({ e, start, end, site, reported });
      for (let d = start; d <= end; d = addDays(d, 1)) onDuty.add(`${e.id}:${d}`);
    };
    {
      const s = personas.sampler!;
      // Working days only: back from `k` days ago (forward for the next one), so the plan holds whatever weekday today is.
      const back = (k: number, len = 1) => { let d = addDays(today, -k); while ([...Array(len).keys()].some((i) => isSunday(addDays(d, i)))) d = addDays(d, -1); return d; };
      let next = today; while (isSunday(next)) next = addDays(next, 1);
      const trip = back(12, 2);
      planDuty(s, trip, addDays(trip, 1), SITES[0]!);
      planDuty(s, back(5), back(5), SITES[4]!, false);
      planDuty(s, next, next, SITES[1]!, false);
      for (const [i, e] of emps.filter((x) => x.dept === 'FIELD' && !personaIds.has(x.id)).entries()) {
        for (let k = 27 - i; k >= 2; k -= 6 + (i % 3)) planDuty(e, addDays(today, -k), addDays(today, -k + (k % 4 === 0 ? 1 : 0)), SITES[(i + k) % SITES.length]!);
      }
    }
  }

  // ---- attendance: last 30 days of punches, calculated by the engine (overtime recorded for the GEN shift after 9 h)
  if (on('attendance')) {
    for (const [k, v] of [['attendance.overtime_enabled', true], ['overtime.comp_off_leave_type', 'COMP']] as const)
      await q(`INSERT INTO tenant_settings (tenant_id, setting_key, setting_value, updated_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [tid, k, JSON.stringify(v), adminId]);
    // Late evenings: laboratory and field staff now and then (instrument batches, late sample arrivals); the analyst has a few,
    // two of them long (an overnight digestion), so there is overtime to claim as pay or compensatory off.
    const ANALYST_LATE: Record<number, number> = { 2: 200, 3: 320, 4: 320, 5: 190, 7: 210, 9: 330, 10: 330 };
    const lateMinutes = (e: { id: string; dept: string; code: string }, d: string) => {
      if (e.id === personas.analyst!.id) return ANALYST_LATE[Math.round((Date.parse(today) - Date.parse(d)) / 86_400_000)] ?? 0;
      if (!['WATER', 'FIELD', 'FOOD', 'AIR'].includes(e.dept)) return 0;
      return (Number(d.slice(8)) + Number(e.code.slice(3))) % 11 === 0 ? 150 + (Number(e.code.slice(3)) % 4) * 20 : 0;
    };
    for (const p of dutyPlan) {
      const [place, client, purpose] = p.site;
      await q(`INSERT INTO field_duty_requests (tenant_id, employee_id, start_date, end_date, purpose, place, client_name, reference, reason, status, outcome, outcome_note, reported_at, created_by, decided_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'approved',$10,$11,$12,$13,now())`,
        [tid, p.e.id, p.start, p.end, purpose, place, client, `WO-${p.start.replace(/-/g, '').slice(2)}-${p.e.code.slice(3)}`,
         purpose === 'client_visit' ? 'Discuss the monitoring schedule and hand over test reports' : 'Grab and composite samples as per the work order; chain of custody to the lab',
         p.reported ? 'completed' : null, p.reported ? 'Samples collected and handed over to sample receipt' : null, p.reported ? new Date() : null, p.e.userId ?? uid('hr.head')]);
    }
    say(`field duty: ${dutyPlan.length} approved requests for sample collection staff`);
    const from = addDays(today, -30); const to = addDays(today, -1);
    let punches = 0;
    for (const e of emps) {
      if (e.joined > to || e.id === joiner.id) continue;
      for (let d = from > e.joined ? from : e.joined; d <= to; d = addDays(d, 1)) {
        if (new Date(`${d}T00:00:00Z`).getUTCDay() === 0) continue; // Sunday weekly off
        if (onLeave.has(`${e.id}:${d}`) || onDuty.has(`${e.id}:${d}`)) continue;
        const extra = lateMinutes(e, d);
        const r0 = rnd(); const r = extra ? 0.5 : r0; // a late evening is a full day with both punches
        if (r < 0.035) continue; // absent
        const late = rnd() < 0.15 ? int(12, 55) : int(-20, 8);
        const inT = new Date(`${d}T04:00:00Z`); inT.setUTCMinutes(inT.getUTCMinutes() + late);           // 09:30 IST ± …
        const outT = new Date(`${d}T12:30:00Z`); outT.setUTCMinutes(outT.getUTCMinutes() + int(-25, 70)); // 18:00 IST ± …
        if (r < 0.06) outT.setUTCHours(outT.getUTCHours() - 4);                                            // half day
        else outT.setUTCMinutes(outT.getUTCMinutes() + extra);                                             // late evening
        await q(`INSERT INTO attendance_events (tenant_id, employee_id, source, source_ref, event_time, direction) VALUES ($1,$2,'web',$3,$4,'in')`, [tid, e.id, `demo-${e.code}-${d}-in`, inT.toISOString()]);
        punches++;
        if (r < 0.075 && r >= 0.06) continue; // missing out punch
        await q(`INSERT INTO attendance_events (tenant_id, employee_id, source, source_ref, event_time, direction) VALUES ($1,$2,'web',$3,$4,'out')`, [tid, e.id, `demo-${e.code}-${d}-out`, outT.toISOString()]);
        punches++;
      }
      await recalculateRange(db, tid, e.id, from > e.joined ? from : e.joined, to);
    }
    say(`attendance: ${punches} punches over 30 days, calculated`);
  }

  // ---- leave types + accruals
  let typeId: Record<string, string> = {};
  if (on('leave')) {
    if (!(await q('SELECT 1 FROM leave_types WHERE tenant_id=$1', [tid])).rowCount) {
      for (const [code, name, paid, half, bal, accrual, ent, carry, notice] of [['CL', 'Casual Leave', true, true, true, 'annual', 8, 0, 0], ['SL', 'Sick Leave', true, true, true, 'annual', 8, 0, 0],
        ['EL', 'Earned Leave', true, false, true, 'monthly', 18, 30, 7], ['LWP', 'Leave Without Pay', false, true, false, 'none', 0, 0, 0]] as const)
        await q(`INSERT INTO leave_types (tenant_id, code, name, paid, allow_half_day, requires_balance, accrual_method, annual_entitlement, carry_forward_max, count_non_working_days, min_notice_days)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10)`, [tid, code, name, paid, half, bal, accrual, ent, carry, notice]);
      const { runAccruals } = await import('../modules/leave/jobs.js');
      for (let m = 1; m <= Number(today.slice(5, 7)); m++) await runAccruals(db as never, tid, year, m, null);
    }
    await q(`INSERT INTO leave_types (tenant_id, code, name, description, paid, allow_half_day, requires_balance, accrual_method, annual_entitlement, carry_forward_max, count_non_working_days, min_notice_days)
      VALUES ($1,'COMP','Compensatory Off','Earned by approved overtime taken as time off',true,true,true,'none',0,0,false,0) ON CONFLICT (tenant_id, code) DO NOTHING`, [tid]);
    say('leave: CL/SL/EL/LWP with accruals to date, COMP earned from overtime (example policy — set your own)');
    // approved leave history, written as the approval flow writes it: request, ledger debit, attendance recalculated (on_leave)
    typeId = Object.fromEntries((await q<{ code: string; id: string }>('SELECT code, id FROM leave_types WHERE tenant_id=$1', [tid])).rows.map((r) => [r.code, r.id]));
    let leaveDays = 0; let leaveRequests = 0;
    for (const l of leavePlan) {
      const branch = (await q<{ branch_id: string }>('SELECT branch_id FROM employees WHERE id=$1', [l.e.id])).rows[0]!.branch_id;
      const days = countDays(l.start, l.end, 'full', 'full', await nonWorkingDates(db, tid, branch, l.start, l.end), false).days.toNumber();
      if (!(days > 0)) continue;
      const rid = (await q<{ id: string }>(`INSERT INTO leave_requests (tenant_id, employee_id, leave_type_id, leave_year, start_date, end_date, days, reason, status, requested_by, created_at, decided_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'approved',$9,$5::date - 3,$5::date - 2) RETURNING id`,
        [tid, l.e.id, typeId[l.code], year, l.start, l.end, days, l.code === 'CL' ? 'Personal work at home' : 'Fever, advised rest', uid('hr.head')])).rows[0]!.id;
      await q(`INSERT INTO leave_ledger (tenant_id, employee_id, leave_type_id, leave_year, entry_type, days, request_id, reference, note, created_by)
        VALUES ($1,$2,$3,$4,'consumption',$5,$6,$7,$8,$9)`, [tid, l.e.id, typeId[l.code], year, -days, rid, `request:${rid}:consume`, `Leave ${l.start} to ${l.end}`, uid('hr.head')]);
      await recalculateRange(db, tid, l.e.id, l.start, l.end);
      leaveDays += days; leaveRequests++;
    }
    say(`leave history: ${leaveRequests} approved requests, ${leaveDays} days`);
  }

  // ---- overtime: one approved compensatory off (the analyst's long evening 9–10 days ago), credited as approval writes it.
  if (on('comp_off')) {
    // Overtime PAY needs the organization's own rate in Settings → Attendance policy; the demo does not set it.
    {
      const a = personas.analyst!;
      const day = (await q<{ overtime_minutes: number; work_date: string }>(`SELECT overtime_minutes, work_date::text FROM attendance_daily WHERE tenant_id=$1 AND employee_id=$2
        AND work_date IN ($3,$4) AND overtime_minutes >= 240 ORDER BY work_date LIMIT 1`, [tid, a.id, addDays(today, -10), addDays(today, -9)])).rows[0];
      const wd = day?.work_date;
      if (day && wd) {
        const days = day.overtime_minutes >= 480 ? 1 : 0.5;
        const cid = (await q<{ id: string }>(`INSERT INTO overtime_claims (tenant_id, employee_id, work_date, minutes, recorded_minutes, payout, reason, status, comp_off_days, created_by, decided_at)
          VALUES ($1,$2,$3,$4,$4,'comp_off','Overnight digestion for the heavy-metals batch (client deadline)','approved',$5,$6, now()) RETURNING id`, [tid, a.id, wd, day.overtime_minutes, days, uid('analyst')])).rows[0]!.id;
        await q(`INSERT INTO leave_ledger (tenant_id, employee_id, leave_type_id, leave_year, entry_type, days, reference, note, created_by)
          VALUES ($1,$2,$3,$4,'adjustment',$5,$6,$7,$8)`, [tid, a.id, typeId.COMP, year, days, `overtime:${cid}:credit`, `Compensatory off for overtime on ${wd}`, uid('hr.head')]);
        say(`overtime: analyst's compensatory off approved (${days} day); other late evenings left to claim`);
      }
    }
  }

  // ---- expenses
  if (on('expenses')) {
    const cat: Record<string, string> = {};
    for (const [code, name, receipt, max, gst] of [['LOCAL_TRAVEL', 'Local travel', false, 2000, false], ['SAMPLING_TRAVEL', 'Sample collection travel', true, null, true], ['ACCOMMODATION', 'Accommodation', true, null, true],
      ['MEALS', 'Meals', true, 1500, false], ['PPE', 'PPE & consumables', true, 5000, true]] as const)
      cat[code] = (await q<{ id: string }>(`INSERT INTO expense_categories (tenant_id, code, name, requires_receipt, max_amount, gst_applicable) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (tenant_id, code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [tid, code, name, receipt, max, gst])).rows[0]!.id;
    for (const [k, title, items] of [['sampler', 'STP sampling trip — Chakan MIDC', [['LOCAL_TRAVEL', 640, 'Auto + bus to Chakan'], ['MEALS', 320, 'Lunch at site']]],
      ['analyst', 'Training at NABL assessor workshop', [['LOCAL_TRAVEL', 480, 'Cab to venue']]]] as const) {
      const cid = (await q<{ id: string }>(`INSERT INTO expense_claims (tenant_id, employee_id, title, purpose, created_by) VALUES ($1,$2,$3,'Demo claim — business travel',$4) RETURNING id`, [tid, personas[k]!.id, title, uid(k)])).rows[0]!.id;
      for (const [c2, amt, desc] of items) await q(`INSERT INTO expense_items (tenant_id, claim_id, category_id, expense_date, amount, description) VALUES ($1,$2,$3,$4,$5,$6)`, [tid, cid, cat[c2], addDays(today, -int(2, 10)), amt, desc]);
      await q(`UPDATE expense_claims SET total=(SELECT sum(amount) FROM expense_items WHERE claim_id=$1) WHERE id=$1`, [cid]);
    }
    // Allowances: illustrative policy rates entered by finance (each organization sets its own; none ship with HRMS).
    for (const [code, name, calc] of [['DAILY_ALLOWANCE', 'Daily allowance (per diem)', 'per_diem'], ['OWN_VEHICLE', 'Own vehicle (mileage)', 'mileage']] as const)
      cat[code] = (await q<{ id: string }>(`INSERT INTO expense_categories (tenant_id, code, name, requires_receipt, calc) VALUES ($1,$2,$3,false,$4) RETURNING id`, [tid, code, name, calc])).rows[0]!.id;
    const rateFrom = addDays(today, -60);
    for (const [kind, tier, grade, vehicle, rate] of [['per_diem', 'METRO', null, null, 1200], ['per_diem', 'OTHER', null, null, 800], ['per_diem', 'METRO', 'L5', null, 1800],
      ['per_diem', 'OTHER', 'L5', null, 1200], ['mileage', null, null, 'car', 9], ['mileage', null, null, 'two_wheeler', 4]] as const)
      await q(`INSERT INTO allowance_rates (tenant_id, kind, tier, grade, vehicle, rate, effective_from, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'Demo policy rate',$8)`,
        [tid, kind, tier, grade, vehicle, rate, rateFrom, adminId]);
    say('expenses: 7 categories (incl. per diem and mileage), 6 allowance rates, 2 draft claims');
  }

  // ---- travel: the analyst went to Mumbai for the NABL assessor workshop with an advance (the draft claim above is that
  if (on('travel')) {
    // trip's, so the advance is set off when it is approved); the sampler has a sampling trip next week awaiting the advance.
    {
      const a = personas.analyst!; const s = personas.sampler!;
      let w = addDays(today, -14); while (new Date(`${w}T00:00:00Z`).getUTCDay() === 0) w = addDays(w, -1);
      const past = (await q<{ id: string }>(`INSERT INTO travel_requests (tenant_id, employee_id, purpose, trip_type, origin, destination, start_date, end_date, travel_mode, accommodation,
          estimate_travel, estimate_meals, estimate_local, advance_requested, mark_on_duty, status, decided_at, advance_paid_amount, advance_paid_at, advance_paid_by, advance_reference, completed_at, created_by)
        VALUES ($1,$2,'NABL assessor workshop on ISO/IEC 17025:2017','domestic','Pune','Mumbai — NABL regional office',$3,$3,'rail',false,1200,600,800,1500,false,'completed',now(),1500,now(),$4,'NEFT-DEMO-ADV-01',now(),$5) RETURNING id`,
        [tid, a.id, w, uid('finance'), uid('analyst')])).rows[0]!.id;
      await q(`UPDATE expense_claims SET travel_request_id=$2 WHERE tenant_id=$1 AND employee_id=$3 AND title='Training at NABL assessor workshop'`, [tid, past, a.id]);
      let n = addDays(today, 7); while ([n, addDays(n, 1)].some((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 0)) n = addDays(n, 1);
      const next = (await q<{ id: string }>(`INSERT INTO travel_requests (tenant_id, employee_id, purpose, trip_type, origin, destination, start_date, end_date, travel_mode, accommodation, project,
          estimate_travel, estimate_stay, estimate_meals, advance_requested, status, decided_at, created_by)
        VALUES ($1,$2,'Quarterly stack and ambient air monitoring for the client plant','domestic','Navi Mumbai','Aurangabad — Waluj MIDC',$3,$4,'road',true,'WO-AUR-0412',
          2800,3200,1200,5000,'approved',now(),$5) RETURNING id`, [tid, s.id, n, addDays(n, 1), uid('sampler')])).rows[0]!.id;
      await q(`INSERT INTO field_duty_requests (tenant_id, employee_id, start_date, end_date, purpose, place, reference, reason, status, created_by, decided_at, travel_request_id)
        VALUES ($1,$2,$3,$4,'official_work','Aurangabad — Waluj MIDC','Travel','Quarterly stack and ambient air monitoring for the client plant','approved',$5,now(),$6)`, [tid, s.id, n, addDays(n, 1), uid('sampler'), next]);
      say('travel: a completed trip with its advance (claim in draft), an approved trip awaiting its advance');
    }
  }

  // ---- advances and loans: the analyst's salary advance (paid; recovered from this month's payroll) and the IT manager's loan
  if (on('loans', 'salary_advance')) {
    {
      const month = today.slice(0, 7);
      const [y, m] = month.split('-').map(Number) as [number, number];
      const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
      for (const [k, kind, amount, n, first, purpose] of [['analyst', 'salary_advance', 15000, 3, month, 'Advance for my sister\'s wedding expenses'],
        ['it', 'loan', 60000, 12, prev, 'Two-wheeler purchase for commuting to the Bhosari site']] as const) {
        const inst = Math.ceil(amount / n);
        const lid = (await q<{ id: string }>(`INSERT INTO employee_loans (tenant_id, employee_id, kind, amount, installments, installment_amount, first_period, purpose, status, decided_at, disbursed_at, disbursed_by, disbursement_reference, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'disbursed',now(),now(),$9,$10,$11) RETURNING id`, [tid, personas[k]!.id, kind, amount, n, inst, first, purpose, uid('payroll'), `NEFT-DEMO-${k.toUpperCase()}`, uid(k)])).rows[0]!.id;
        // The loan started last month; that instalment was repaid directly (the demo has no payroll runs).
        if (first === prev) await q(`INSERT INTO loan_recoveries (tenant_id, loan_id, source, amount, reference, recorded_by) VALUES ($1,$2,'repayment',$3,'Cash receipt (demo)',$4)`, [tid, lid, inst, uid('payroll')]);
      }
      say('advances and loans: a salary advance and a loan, both paid out and being recovered');
    }
  }

  // ---- personal details: most people have filled in contacts, addresses, education and nominees; a few have not yet
  // (Reports → Missing personal details). The analyst has no PF nominee yet: adding one goes to HR for approval.
  {
    const HOME = [['Kolhapur', 'Maharashtra', '416003'], ['Nagpur', 'Maharashtra', '440010'], ['Mysuru', 'Karnataka', '570009'], ['Indore', 'Madhya Pradesh', '452001'],
      ['Kochi', 'Kerala', '682016'], ['Lucknow', 'Uttar Pradesh', '226010'], ['Nashik', 'Maharashtra', '422005'], ['Hubballi', 'Karnataka', '580020']] as const;
    const PIN: Record<string, string> = { PUN: '411045', NMB: '400703', BLR: '560037' };
    const LEVEL_BY_DEPT: Record<string, [string, string, string]> = {
      WATER: ['postgraduate', 'M.Sc. Analytical Chemistry', 'Savitribai Phule Pune University'], AIR: ['graduate', 'B.E. Environmental Engineering', 'Visvesvaraya Technological University'],
      SOIL: ['postgraduate', 'M.Sc. Agricultural Chemistry', 'Mahatma Phule Krishi Vidyapeeth'], FOOD: ['postgraduate', 'M.Sc. Food Technology', 'University of Mumbai'],
      MICRO: ['postgraduate', 'M.Sc. Microbiology', 'Bangalore University'], INST: ['graduate', 'B.Tech. Instrumentation', 'University of Mumbai'],
      FIELD: ['diploma', 'Diploma in Chemical Technology', 'MSBTE'], QA: ['postgraduate', 'M.Sc. Chemistry', 'Savitribai Phule Pune University'],
      HR: ['postgraduate', 'MBA (Human Resources)', 'Symbiosis International University'], FIN: ['graduate', 'B.Com.', 'University of Mumbai'], IT: ['graduate', 'B.E. Computer Engineering', 'Savitribai Phule Pune University'],
    };
    let done = 0;
    for (const e of emps) {
      if (e.id === joiner.id || (!personaIds.has(e.id) && rnd() < 0.12)) continue;
      const b = BRANCHES.find((x) => x.code === e.branch)!;
      const spouse = `${pick([...FIRST_F, ...FIRST_M])} ${e.last}`;
      await q(`INSERT INTO employee_emergency_contacts (tenant_id, employee_id, position, name, relationship, phone) VALUES ($1,$2,1,$3,$4,$5),($1,$2,2,$6,'Parent',$7)`,
        [tid, e.id, spouse, pick(['Spouse', 'Sibling']), `+91 9${int(100000000, 999999999)}`, `${pick(FIRST_M)} ${e.last}`, `+91 9${int(100000000, 999999999)}`]);
      const [hc, hs, hp] = pick(HOME);
      await q(`INSERT INTO employee_addresses (tenant_id, employee_id, kind, line1, line2, city, state, postal_code) VALUES ($1,$2,'current',$3,$4,$5,$6,$7),($1,$2,'permanent',$8,NULL,$9,$10,$11)`,
        [tid, e.id, `Flat ${int(1, 12)}0${int(1, 4)}, ${pick(['Sai', 'Shree', 'Green', 'Lake', 'Palm'])} ${pick(['Residency', 'Heights', 'Apartments', 'Enclave'])}`, pick(['Main Road', 'Station Road', 'Link Road']),
          b.city, b.state, PIN[e.branch], `${int(2, 180)}, ${pick(['Shivaji', 'Gandhi', 'Nehru', 'Tilak'])} Nagar`, hc, hs, hp]);
      const [level, qual, uni] = LEVEL_BY_DEPT[e.dept]!;
      await q(`INSERT INTO employee_education (tenant_id, employee_id, level, qualification, institution, university, year_of_passing, score) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tid, e.id, level, qual, `${pick(['Fergusson', 'Ruia', 'St. Joseph\'s', 'Modern', 'Wadia'])} College`, uni, Number(e.joined.slice(0, 4)) - int(1, 4), `${int(62, 84)}%`]);
      if (e !== personas.analyst) await q(`INSERT INTO employee_nominees (tenant_id, employee_id, purpose, name, relationship, share_percent) VALUES ($1,$2,'pf',$3,'Spouse',100),($1,$2,'gratuity',$3,'Spouse',100)`, [tid, e.id, spouse]);
      done++;
    }
    say(`personal details: ${done} of ${emps.length} employees complete`);
  }

  // ---- approvals: the water laboratory manager is away this week, so the quality manager approves for her;
  // requests left with one person for 3 days also go to that person's manager (or HR).
  await q(`INSERT INTO tenant_settings (tenant_id, setting_key, setting_value, updated_by) VALUES ($1,'approvals.escalate_after_days','3',$2) ON CONFLICT DO NOTHING`, [tid, adminId]);
  await q(`INSERT INTO approval_delegations (tenant_id, delegator_id, delegate_id, starts_on, ends_on, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$2)`,
    [tid, uid('lab.manager'), uid('quality'), today, addDays(today, 4), 'At the NABL assessor training in Bengaluru']);
  say('approvals: lab manager away, quality manager covering; escalation after 3 days');

  // ---- rosters: from next Monday the instrument room runs two shifts on a 14-day rotation (5 mornings, 2 off,
  if (on('shifts')) {
    // 5 evenings, 2 off), with two crews half a cycle apart so both shifts are always covered. Past attendance is unchanged.
    {
      const mk = async (code: string, name: string, start: string, end: string) => (await q<{ id: string }>(`INSERT INTO shifts (tenant_id, code, name, start_time, end_time,
        break_minutes, grace_minutes, early_exit_grace_minutes, half_day_min_minutes, full_day_min_minutes) VALUES ($1,$2,$3,$4,$5,30,10,10,240,420) RETURNING id`, [tid, code, name, start, end])).rows[0]!.id;
      const morning = await mk('MORN', 'Instrument room — morning', '06:00', '14:00');
      const evening = await mk('EVE', 'Instrument room — evening', '14:00', '22:00');
      const days = [...Array(5).fill(morning), null, null, ...Array(5).fill(evening), null, null];
      const pid = (await q<{ id: string }>(`INSERT INTO roster_patterns (tenant_id, code, name, days, created_by) VALUES ($1,'INST-2S','Instrument room 2-shift (14 days)',$2,$3) RETURNING id`,
        [tid, days, adminId])).rows[0]!.id;
      const wd = new Date(`${today}T00:00:00Z`).getUTCDay();
      const monday = addDays(today, ((8 - wd) % 7) || 7);
      const crew = emps.filter((x) => x.dept === 'INST' && !personaIds.has(x.id)).slice(0, 6);
      for (const [i, e] of crew.entries()) {
        await q(`INSERT INTO roster_assignments (tenant_id, employee_id, pattern_id, effective_from, start_day, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
          [tid, e.id, pid, monday, i % 2 === 0 ? 0 : 7, adminId]);
      }
      say(`rosters: ${crew.length} instrument-room staff on INST-2S from ${monday}`);
    }
  }

  // ---- training & competency
  if (on('training')) {
    const course: Record<string, string> = {};
    for (const [code, name, kind, months] of [['INDUCTION', 'Laboratory induction', 'induction', null], ['CHEM-SAFETY', 'Chemical safety & spill response', 'safety', 12], ['QMS', 'ISO/IEC 17025 awareness', 'quality', 24],
      ['PH-METER', 'pH meter operation & calibration', 'instrument', null], ['ICP-OES', 'ICP-OES operation', 'instrument', null], ['STACK-SAFETY', 'Stack sampling safety (work at height)', 'safety', 12],
      ['MICRO-ASEPTIC', 'Aseptic technique', 'method', 24]] as const)
      course[code] = (await q<{ id: string }>(`INSERT INTO training_courses (tenant_id, code, name, kind, validity_months) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [tid, code, name, kind, months])).rows[0]!.id;
    const method: Record<string, string> = {};
    for (const [code, name, std, disc, matrix, req] of [['WAT-PH', 'pH — electrometric', 'IS 3025 (Part 11)', 'Chemical', 'Water', ['INDUCTION', 'CHEM-SAFETY', 'PH-METER']],
      ['WAT-METALS', 'Heavy metals by ICP-OES', 'APHA 3120 B', 'Chemical', 'Water', ['INDUCTION', 'CHEM-SAFETY', 'ICP-OES']], ['AIR-PM10', 'PM10 — gravimetric', 'IS 5182 (Part 23)', 'Chemical', 'Ambient air', ['INDUCTION', 'STACK-SAFETY']],
      ['MIC-COLIFORM', 'Total coliforms — MPN', 'IS 1622', 'Biological', 'Water', ['INDUCTION', 'MICRO-ASEPTIC']]] as const) {
      const id = (await q<{ id: string }>(`INSERT INTO lab_methods (tenant_id, code, name, standard_ref, discipline, matrix) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, code) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
        [tid, code, name, `${std} (as cited by the lab — demo)`, disc, matrix])).rows[0]!.id;
      method[code] = id;
      for (const r of req) await q(`INSERT INTO lab_method_requirements (tenant_id, method_id, course_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tid, id, course[r]]);
    }
    let records = 0; let auths = 0;
    const techDepts = ['WATER', 'AIR', 'SOIL', 'FOOD', 'MICRO', 'INST', 'FIELD'];
    for (const e of emps.filter((x) => techDepts.includes(x.dept) && x.id !== joiner.id)) {
      const courses = ['INDUCTION', 'CHEM-SAFETY', 'QMS', ...(e.dept === 'WATER' ? ['PH-METER', 'ICP-OES'] : e.dept === 'AIR' || e.dept === 'FIELD' ? ['STACK-SAFETY'] : e.dept === 'MICRO' ? ['MICRO-ASEPTIC'] : [])];
      for (const c2 of courses) {
        if (rnd() < 0.08) continue;
        const done = addDays(today, -int(20, 380));
        await q(`INSERT INTO training_records (tenant_id, employee_id, course_id, completed_on, expires_on, result, trainer, hours, recorded_by)
          SELECT $1,$2,$3,$4::date, CASE WHEN validity_months IS NULL THEN NULL ELSE ($4::date + make_interval(months => validity_months))::date END, 'passed', $5, $6, $7 FROM training_courses WHERE id=$3`,
          [tid, e.id, course[c2], done, pick(['QA team', 'Dr. Arjun Rao', 'Vendor application specialist', 'EHS officer']), pick([2, 3, 4, 8]), uid('hr.exec')]);
        records++;
      }
      const m = e.dept === 'WATER' ? 'WAT-PH' : e.dept === 'MICRO' ? 'MIC-COLIFORM' : e.dept === 'AIR' ? 'AIR-PM10' : null;
      if (m && rnd() < 0.7) {
        const sid = (await q<{ id: string }>(`INSERT INTO competency_assessments (tenant_id, employee_id, method_id, activity, approach, assessed_on, result, evidence, assessor_id)
          VALUES ($1,$2,$3,'perform',$4,$5,'competent',$6,$7) RETURNING id`, [tid, e.id, method[m], pick(['replicate', 'proficiency_test', 'witnessed']), addDays(today, -int(30, 160)),
          'Demo evidence: replicate analysis within method precision limits', uid('lab.manager')])).rows[0]!.id;
        const aid = (await q<{ id: string }>(`INSERT INTO lab_authorizations (tenant_id, employee_id, method_id, activity, status, assessment_id, requested_by, authorized_by, authorized_at, valid_from, review_due)
          VALUES ($1,$2,$3,'perform','authorized',$4,$5,$6,now(),$7,$8) RETURNING id`, [tid, e.id, method[m], sid, uid('lab.manager'), uid('quality'), addDays(today, -int(10, 120)), addDays(today, int(15, 300))])).rows[0]!.id;
        await q(`INSERT INTO lab_authorization_events (tenant_id, authorization_id, action, actor_id) VALUES ($1,$2,'requested',$3), ($1,$2,'authorized',$4)`, [tid, aid, uid('lab.manager'), uid('quality')]);
        auths++;
      }
    }
    say(`competency: 7 courses, 4 methods, ${records} training records, ${auths} technical authorizations`);
  }

  // ---- policies (drafted by HR exec, published by HR head)
  if (on('core.policies')) {
    for (const [code, title, category, body] of [['COC', 'Code of conduct', 'code_of_conduct', 'Demo policy text.\n\n1. Act with integrity and impartiality.\n2. Never alter or fabricate test data.\n3. Declare conflicts of interest.\n4. Protect client confidentiality.'],
      ['POSH', 'Prevention of sexual harassment policy', 'posh', 'Demo policy text.\n\nThe organization has an Internal Committee. Complaints can be filed in HRMS under Grievances & POSH and are seen only by the Committee.'],
      ['EHS', 'Laboratory health & safety rules', 'safety', 'Demo policy text.\n\nWear lab coat, goggles and gloves in all laboratory areas. Know your nearest eyewash, safety shower and spill kit.']] as const) {
      const pid = (await q<{ id: string }>(`INSERT INTO policies (tenant_id, code, title, category, owner, created_by) VALUES ($1,$2,$3,$4,'HR',$5) RETURNING id`, [tid, code, title, category, uid('hr.exec')])).rows[0]!.id;
      const vid = (await q<{ id: string }>(`INSERT INTO policy_versions (tenant_id, policy_id, version_no, status, change_summary, body, content_sha256, effective_from, created_by, published_by, published_at)
        VALUES ($1,$2,1,'published','Initial issue',$3,$4,$5,$6,$7, now() - interval '20 days') RETURNING id`, [tid, pid, body, contentHash(body, null), addDays(today, -20), uid('hr.exec'), uid('hr.head')])).rows[0]!.id;
      for (const e of emps) if (e.userId && rnd() < 0.7)
        await q(`INSERT INTO policy_acknowledgements (tenant_id, version_id, employee_id, user_id, content_sha256) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [tid, vid, e.id, e.userId, contentHash(body, null)]);
    }
    say('policies: 3 published (code of conduct, POSH, EHS)');
  }

  // ---- recruitment
  if (on('recruitment')) {
    const reqs: string[] = [];
    for (const [i, [title, d, des, pos]] of ([['Senior Chemist — Water lab', 'WATER', 'Senior Chemist', 2], ['Microbiologist', 'MICRO', 'Microbiologist', 1], ['Field Sampler — Navi Mumbai', 'FIELD', 'Field Sampler', 2]] as const).entries())
      reqs.push((await q<{ id: string }>(`INSERT INTO job_requisitions (tenant_id, number, title, legal_entity_id, branch_id, department_id, designation, employment_type, positions, justification, budget_ctc_max, hiring_manager_id, status, created_by, approved_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'permanent',$8,'Demo: new client contracts need additional capacity',$9,$10,'approved',$11, now() - interval '12 days') RETURNING id`,
        [tid, i + 1, title, le, branch[d === 'FIELD' ? 'NMB' : 'PUN'], dept[d], des, pos, d === 'FIELD' ? 300000 : 650000, heads[d], uid('lab.manager')])).rows[0]!.id);
    const stages = ['applied', 'applied', 'screening', 'screening', 'interview', 'interview', 'offer', 'rejected'];
    for (let i = 0; i < 10; i++) {
      const female = rnd() < 0.5; const first = female ? pick(FIRST_F) : pick(FIRST_M); const last = pick(LAST);
      const cid = (await q<{ id: string }>(`INSERT INTO candidates (tenant_id, first_name, last_name, email, phone, source, current_company, current_designation, experience_months, notice_days, qualification, location,
          consent_at, consent_note, retain_until, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now(), 'Demo data — synthetic candidate', $13, $14) RETURNING id`,
        [tid, first, last, `${first}.${last}.${i}@mail.example`.toLowerCase(), `+91 8${int(100000000, 999999999)}`, pick(['job_portal', 'referral', 'campus', 'agency']),
          pick(['Envirocare Labs', 'AquaTest Analytics', 'GreenEarth Testing', 'Precision Analytical']), pick(['Chemist', 'Analyst', 'Microbiologist', 'Technician']), int(6, 96), pick([15, 30, 60, 90]),
          pick(['M.Sc. Chemistry', 'M.Sc. Microbiology', 'B.Sc. Chemistry', 'B.Tech Environmental Engg.']), pick(['Pune', 'Mumbai', 'Bengaluru', 'Nashik']), addDays(today, 365), uid('hr.exec')])).rows[0]!.id;
      const st = stages[i % stages.length]!;
      const ap = (await q<{ id: string }>(`INSERT INTO job_applications (tenant_id, requisition_id, candidate_id, stage, rejection_reason, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [tid, reqs[i % reqs.length], cid, st, st === 'rejected' ? 'Experience below the requirement for NABL-scope methods' : null, uid('hr.exec')])).rows[0]!.id;
      await q(`INSERT INTO job_application_events (tenant_id, application_id, from_stage, to_stage, actor_id) VALUES ($1,$2,NULL,'applied',$3)`, [tid, ap, uid('hr.exec')]);
    }
    say('recruitment: 3 approved requisitions, 10 candidates across the pipeline');
  }

  // ---- lifecycle templates + onboarding for the joiner
  if (on('core.onboarding')) {
    const tpl = async (kind: string, name: string, tasks: [string, string, number][]) => {
      const id = (await q<{ id: string }>(`INSERT INTO checklist_templates (tenant_id, kind, name, is_default) VALUES ($1,$2,$3,true) RETURNING id`, [tid, kind, name])).rows[0]!.id;
      for (const [i, [title, owner, off]] of tasks.entries()) await q(`INSERT INTO checklist_template_tasks (tenant_id, template_id, position, title, owner, offset_days) VALUES ($1,$2,$3,$4,$5,$6)`, [tid, id, i, title, owner, off]);
      return id;
    };
    const onb = await tpl('onboarding', 'Laboratory joiner', [['Collect ID, address proof and education certificates', 'hr', -5], ['Create HRMS, email and LIMS accounts', 'it', -2], ['Issue lab coat, goggles and ID badge', 'admin', 0],
      ['Laboratory safety induction', 'manager', 0], ['Read the quality manual and sign the code of conduct', 'employee', 3], ['Bank and PF details for payroll', 'finance', 5]]);
    await tpl('offboarding', 'Standard exit', [['Handover of open test reports and samples', 'employee', -3], ['Return lab coat, badge, keys and instruments', 'manager', 0], ['Disable LIMS and email access', 'it', 0],
      ['Recover advances; settle expense claims', 'finance', 2], ['Experience letter and relieving letter', 'hr', 7]]);
    const cl = (await q<{ id: string }>(`INSERT INTO checklists (tenant_id, kind, employee_id, template_id, anchor_date) VALUES ($1,'onboarding',$2,$3,$4) RETURNING id`, [tid, joiner.id, onb, joiner.joined])).rows[0]!.id;
    await q(`INSERT INTO checklist_tasks (tenant_id, checklist_id, position, title, owner, due_date) SELECT $1,$2,position,title,owner,$3::date + offset_days FROM checklist_template_tasks WHERE template_id=$4`, [tid, cl, joiner.joined, onb]);
    say('lifecycle: onboarding + exit templates, onboarding started for the upcoming joiner');
  }

  // ---- payroll components + salaries (no statutory rules: enter and verify your own)
  if (on('payroll')) {
    for (const [code, name, kind, calc, base, pf, pos] of [['BASIC', 'Basic', 'earning', 'fixed', [], true, 1], ['HRA', 'House rent allowance', 'earning', 'percent', ['BASIC'], false, 2],
      ['CONV', 'Conveyance allowance', 'earning', 'fixed', [], false, 3], ['SPECIAL', 'Special allowance', 'earning', 'fixed', [], false, 4]] as const)
      await q(`INSERT INTO pay_components (tenant_id, code, name, kind, calc, base_codes, pf_wage, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id, code) DO NOTHING`, [tid, code, name, kind, calc, base, pf, pos]);
    for (const e of emps) {
      const [lo, hi] = BASIC_BY_GRADE[e.grade] ?? [18000, 24000];
      const basic = Math.round(int(lo, hi) / 100) * 100;
      await q(`INSERT INTO employee_salaries (tenant_id, employee_id, effective_from, amounts_enc, reason, status, created_by, approved_at) VALUES ($1,$2,$3,$4,'Demo salary','active',$5, now())`,
        [tid, e.id, e.joined < `${year}-04-01` ? `${year}-04-01` : e.joined, cipher.encrypt(JSON.stringify({ BASIC: basic, HRA: 40, CONV: 1600, SPECIAL: Math.round(basic * 0.35 / 100) * 100 })), uid('payroll')]);
    }
    say('payroll: 4 components and salaries for everyone (statutory rules NOT created)');
  }

  // ---- assets
  if (on('assets')) {
    const holders = emps.filter((e) => e.id !== joiner.id);
    let assets = 0;
    const mkAsset = async (tag: string, name: string, category: string, serial: string, cal: string | null, holder: Emp | null) => {
      const id = (await q<{ id: string }>(`INSERT INTO assets (tenant_id, tag, name, category, serial_number, branch_id, status, purchase_date, calibration_due) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [tid, tag, name, category, serial, branch.PUN, holder ? 'assigned' : 'available', addDays(today, -int(200, 1500)), cal])).rows[0]!.id;
      if (holder) await q(`INSERT INTO asset_assignments (tenant_id, asset_id, employee_id, issued_at, issued_by, condition_out, acknowledged_at) VALUES ($1,$2,$3,$4,$5,'Good', CASE WHEN $6 THEN now() END)`,
        [tid, id, holder.id, addDays(today, -int(10, 300)), uid('it'), rnd() < 0.8]);
      assets++;
    };
    for (let i = 1; i <= 4; i++) await mkAsset(`INS-PH-${String(i).padStart(2, '0')}`, 'pH meter (bench)', 'lab_instrument', `PHB-${int(1000, 9999)}`, addDays(today, [-3, 6, 25, 120][i - 1]!), null);
    await mkAsset('INS-ICP-01', 'ICP-OES spectrometer', 'lab_instrument', `ICP-${int(10000, 99999)}`, addDays(today, 40), null);
    await mkAsset('INS-BAL-01', 'Analytical balance 0.1 mg', 'lab_instrument', `BAL-${int(1000, 9999)}`, addDays(today, 12), null);
    for (let i = 1; i <= 12; i++) await mkAsset(`IT-LAP-${String(i).padStart(3, '0')}`, pick(['Dell Latitude 5440', 'Lenovo ThinkPad E14', 'HP ProBook 440']), 'it', `SN${int(100000, 999999)}`, null, holders[int(0, holders.length - 1)]!);
    for (let i = 1; i <= 6; i++) await mkAsset(`PPE-HH-${String(i).padStart(3, '0')}`, 'Safety helmet + harness (stack sampling)', 'ppe', `HH-${int(100, 999)}`, null, holders.filter((e) => e.dept === 'AIR' || e.dept === 'FIELD')[i % 6] ?? null);
    say(`assets: ${assets} (instruments with calibration dates, laptops, PPE)`);
  }

  // ---- performance cycle with goals
  if (on('performance')) {
    const cyc = (await q<{ id: string }>(`INSERT INTO review_cycles (tenant_id, name, period_start, period_end, status, created_by) VALUES ($1,$2,$3,$4,'active',$5) RETURNING id`,
      [tid, `FY ${year}-${String(year + 1).slice(2)}`, `${year}-04-01`, `${year + 1}-03-31`, uid('hr.head')])).rows[0]!.id;
    await q(`INSERT INTO performance_reviews (tenant_id, cycle_id, employee_id, reviewer_id) SELECT $1,$2,id,reporting_manager_id FROM employees WHERE tenant_id=$1 AND status='active'`, [tid, cyc]);
    for (const e of emps.filter((x) => x.dept === 'WATER')) {
      await q(`INSERT INTO goals (tenant_id, cycle_id, employee_id, title, measure, weight, status, progress, created_by) VALUES
        ($1,$2,$3,'Report turnaround within 3 working days for 95% of samples','LIMS TAT report',50,'agreed',$4,$5),
        ($1,$2,$3,'Zero data-integrity findings in internal audit','Internal audit report',30,'agreed',$6,$5),
        ($1,$2,$3,'Authorization on one additional method','Authorization register',20,'proposed',0,$5)`, [tid, cyc, e.id, int(30, 80), uid('lab.manager'), int(40, 100)]);
    }
    say('performance: active cycle with reviews for all staff, goals for the water lab');
  }

  // ---- POSH Internal Committee (no cases)
  if (on('posh')) {
    await q(`INSERT INTO posh_committee_members (tenant_id, user_id, role, added_by) VALUES ($1,$2,'presiding_officer',$4), ($1,$3,'member',$4) ON CONFLICT DO NOTHING`, [tid, uid('hr.head'), uid('quality'), adminId]);
    await q(`INSERT INTO posh_external_members (tenant_id, name, organization, since) VALUES ($1,'Adv. Kavita Deshpande (demo)','Stree Adhar Kendra (demo NGO)',$2)`, [tid, `${year}-01-01`]);
    say('POSH: Internal Committee (presiding officer Ananya Iyer, member Arjun Rao, external member)');
  }

  await q('COMMIT');
  return { domain, logins: PERSONAS.map((p) => ({ login: `${p.key}@${domain}`, name: `${p.first} ${p.last}`, role: p.designation })) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  (async () => {
    if (process.env.DEMO_DATA_ALLOWED !== 'true') throw new Error('Refusing: set DEMO_DATA_ALLOWED=true (dev/demo installations only)');
    const url = process.env.DATABASE_MIGRATION_URL;
    if (!url) throw new Error('DATABASE_MIGRATION_URL is required');
    const c = new pg.Client({ connectionString: url, ssl: pgSsl() });
    await c.connect();
    try {
      const tz = process.env.BRAND_TIMEZONE ?? 'Asia/Kolkata';
      const flags = resolveFeatures(process.env);
      if (flags.problems.length) throw new Error(flags.problems.join('; '));
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const password = `Demo-${randomBytes(9).toString('base64url')}`;
      const cipher = await loadFieldCipherFromProcess();
      setDataCipher(cipher);
      const mode = (['single', 'single_hr', 'multi'] as const).find((m) => m === process.env.ORG_MANAGEMENT_MODE) ?? 'multi';
      const r = await withMode(mode, () => generateDemo(c, { password, today, features: flags.features, mode, cipher }));
      if (!r) return;
      process.stdout.write(`HRMS demo logins (synthetic data) — https://${process.env.BRAND_DOMAIN ?? r.domain}\nPassword for all demo logins: ${password}\n` +
        `Privileged roles must set up two-factor authentication at first sign-in.\n\n${r.logins.map((l) => `${l.login.padEnd(36)} ${l.name.padEnd(18)} ${l.role}`).join('\n')}\n`);
      say('done');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { await c.end(); }
  })().catch((e) => { process.stderr.write(`[demo] FAILED: ${(e as Error).message}\n`); process.exit(1); });
}
