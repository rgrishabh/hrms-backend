import type pg from 'pg';
import type { FieldCipher } from '../core/crypto/index.js';
import { gstinCheckDigit } from '../core/settings/india.js';
import type { ManagementMode } from '../core/policy/mode.js';

/**
 * Deterministic factories: the same seed and anchor date give the same organization, byte for byte, on any machine. Nothing global and no clock: dates count from the
 * `today` the caller passes. Everything is invented: no real company, no real person, and registration numbers that have the right format and belong to nobody.
 * Plain data first (`organizationFactory`), so a test can look at it without a database; `insertOrganization` writes it.
 */
export interface Rng {
  next(): number;
  int(lo: number, hi: number): number;
  pick<T>(a: readonly T[]): T;
  digits(n: number): string;
  letters(n: number): string;
}

/** mulberry32: small, fast, and the same everywhere. */
export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(a: readonly T[]) => a[Math.floor(next() * a.length)]!;
  return {
    next,
    int,
    pick,
    digits: (n) => Array.from({ length: n }, () => String(int(0, 9))).join(''),
    letters: (n) => Array.from({ length: n }, () => String.fromCharCode(65 + int(0, 25))).join(''),
  };
}

const FIRST = [
  'Aarav',
  'Ishaan',
  'Kabir',
  'Reyansh',
  'Vivaan',
  'Advait',
  'Dhruv',
  'Hriday',
  'Lakshay',
  'Nivaan',
  'Ojas',
  'Parth',
  'Rudra',
  'Shaurya',
  'Tanay',
  'Yash',
  'Aanya',
  'Diya',
  'Ira',
  'Kiara',
  'Myra',
  'Navya',
  'Pari',
  'Riya',
  'Saanvi',
  'Tara',
  'Vanya',
  'Zoya',
  'Anvi',
  'Charvi',
  'Eshani',
  'Gauri',
];
const LAST = [
  'Acharekar',
  'Balsekar',
  'Chitnavis',
  'Dhavalikar',
  'Edavalath',
  'Fadnavis',
  'Gadgilkar',
  'Hattangadi',
  'Inamdar',
  'Jhaveri',
  'Kanetkar',
  'Lokhande',
  'Mahajani',
  'Nadkarni',
  'Oak',
  'Paranjape',
  'Rajadhyaksha',
  'Sabnis',
  'Tendolkar',
  'Umbarje',
  'Vaidya',
  'Wagle',
  'Yennemadi',
  'Zantye',
];
const BRANCHES = [
  { code: 'NTH', name: 'North Campus', city: 'Sahyadri Nagar', state: 'Maharashtra' },
  { code: 'STH', name: 'South Campus', city: 'Tungabhadra Puram', state: 'Karnataka' },
] as const;
const DEPARTMENTS = [
  { code: 'OPS', name: 'Operations', share: 30, titles: ['Operations Associate', 'Senior Operations Associate', 'Shift Coordinator'] },
  { code: 'LAB', name: 'Laboratory', share: 25, titles: ['Analyst', 'Senior Analyst', 'Lab Technician'] },
  { code: 'FLD', name: 'Field Services', share: 15, titles: ['Field Executive', 'Senior Field Executive'] },
  { code: 'QUA', name: 'Quality', share: 10, titles: ['Quality Officer', 'Document Controller'] },
  { code: 'PPL', name: 'People', share: 7, titles: ['People Partner', 'People Executive'] },
  { code: 'FIN', name: 'Finance', share: 7, titles: ['Accountant', 'Payroll Executive'] },
  { code: 'TEC', name: 'Technology', share: 6, titles: ['Systems Engineer', 'Support Engineer'] },
] as const;
const GRADES = [
  { code: 'G1', name: 'Grade 1', basic: [15000, 19000] },
  { code: 'G2', name: 'Grade 2', basic: [20000, 28000] },
  { code: 'G3', name: 'Grade 3', basic: [29000, 40000] },
  { code: 'G4', name: 'Grade 4', basic: [42000, 60000] },
  { code: 'G5', name: 'Grade 5', basic: [65000, 95000] },
] as const;

export interface FactoryCompany {
  legalName: string;
  gstin: string;
  pan: string;
  tan: string;
  cin: string;
  registeredAddress: string;
  pfRegistration: string;
  esiRegistration: string;
  ptRegistration: string;
  bankAccountHolder: string;
  bankName: string;
  bankIfsc: string;
  bankAccountNumber: string;
  signatoryName: string;
  signatoryDesignation: string;
}

/** An invented company. State code 27, so the GSTIN and CIN agree; the IFSC uses a bank code no bank has. */
export function companyFactory(rng: Rng): FactoryCompany {
  const pan = `${rng.letters(3)}C${rng.letters(1)}${rng.digits(4)}${rng.letters(1)}`;
  const first14 = `27${pan}1Z`;
  const legalName = `${rng.pick(['Verdantis', 'Solvanta', 'Kalpavar', 'Meridora'])} ${rng.pick(['Analytical', 'Testing', 'Assurance'])} Labs Pvt Ltd (demo)`;
  return {
    legalName,
    pan,
    gstin: `${first14}${gstinCheckDigit(first14)}`,
    tan: `${rng.letters(4)}${rng.digits(5)}${rng.letters(1)}`,
    cin: `U74999MH${rng.int(2005, 2022)}PTC${rng.digits(6)}`,
    registeredAddress: `${rng.int(1, 90)} Fictional Industrial Estate, Sahyadri Nagar, Maharashtra`,
    pfRegistration: `MH/DEMO/${rng.digits(7)}/000`,
    esiRegistration: rng.digits(17),
    ptRegistration: `PT-27-${rng.digits(6)}`,
    bankAccountHolder: legalName,
    bankName: 'Demo Bank (fictional)',
    bankIfsc: `ZZZZ0${rng.digits(6)}`,
    bankAccountNumber: rng.digits(14),
    signatoryName: `${rng.pick(FIRST)} ${rng.pick(LAST)}`,
    signatoryDesignation: 'Director',
  };
}

export interface FactoryPerson {
  firstName: string;
  lastName: string;
  phone: string;
  dateOfBirth: string;
}
export function personFactory(rng: Rng, today: string): FactoryPerson {
  return { firstName: rng.pick(FIRST), lastName: rng.pick(LAST), phone: `+91 9${rng.digits(9)}`, dateOfBirth: addDays(today, -rng.int(22, 58) * 365 - rng.int(0, 364)) };
}

export interface FactoryEmployee extends FactoryPerson {
  code: string;
  email: string;
  department: string;
  branch: string;
  designation: string;
  grade: string;
  managerCode: string | null;
  dateOfJoining: string;
  employmentType: 'permanent' | 'probation' | 'contract';
  basic: number;
  status: 'active' | 'exited';
  exitDate: string | null;
  /** System roles in this mode: an empty list is an employee with no login. */
  roles: readonly string[];
}

export interface OrganizationSpec {
  seed: number;
  mode: ManagementMode;
  headcount: number;
  today: string;
  domain?: string;
}
export interface FactoryOrganization {
  seed: number;
  mode: ManagementMode;
  company: FactoryCompany;
  branches: typeof BRANCHES;
  departments: { code: string; name: string }[];
  grades: { code: string; name: string }[];
  designations: { code: string; name: string }[];
  employees: FactoryEmployee[];
}

export const addDays = (s: string, n: number) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Who holds what, in each mode. The same people in all three, so that moving up a mode needs no data migration. */
const ROLE_PLAN: Readonly<Record<ManagementMode, readonly (readonly string[])[]>> = {
  single: [['owner', 'employee'], ['employee'], ['employee']],
  single_hr: [['owner', 'employee'], ['hr_admin', 'employee'], ['hr_executive', 'employee'], ['employee'], ['employee']],
  multi: [
    ['tenant_admin', 'employee'],
    ['hr_admin', 'employee'],
    ['hr_executive', 'employee'],
    ['payroll_manager', 'employee'],
    ['finance_manager', 'employee'],
    ['it_admin', 'employee'],
    ['reporting_manager', 'employee'],
    ['auditor', 'employee'],
    ['employee'],
    ['employee'],
  ],
};
const LEADER_DEPTS = ['OPS', 'PPL', 'PPL', 'FIN', 'FIN', 'TEC', 'LAB', 'QUA', 'LAB', 'FLD'];

/**
 * An organization of exactly `headcount`: one top person, department heads who report to them, and everyone else under a head. People, grades and dates do not depend on the mode; only who
 * holds which role does, and who has a login.
 */
export function organizationFactory(spec: OrganizationSpec): FactoryOrganization {
  const rng = createRng(spec.seed);
  const company = companyFactory(rng);
  const domain = spec.domain ?? 'demo.example.test';
  if (spec.headcount < DEPARTMENTS.length + 1) throw new Error(`An organization needs at least ${DEPARTMENTS.length + 1} people`);
  const employees: FactoryEmployee[] = [];
  const seenEmails = new Set<string>();
  const make = (department: string, designation: string, grade: string, managerCode: string | null, leaderIndex: number | null): FactoryEmployee => {
    const n = employees.length + 1;
    const person = personFactory(rng, spec.today);
    const code = `FX-${String(n).padStart(4, '0')}`;
    let email = `${person.firstName}.${person.lastName}@${domain}`.toLowerCase();
    if (seenEmails.has(email)) email = `${person.firstName}.${person.lastName}.${n}@${domain}`.toLowerCase();
    seenEmails.add(email);
    const [lo, hi] = GRADES.find((g) => g.code === grade)!.basic;
    const recent = rng.next() < 0.12;
    const leaver = rng.next() < 0.03 && leaderIndex === null;
    const joined = addDays(spec.today, recent ? -rng.int(20, 150) : -rng.int(200, 3000));
    const e: FactoryEmployee = {
      ...person,
      code,
      email,
      department,
      branch: rng.pick(['NTH', 'NTH', 'STH']),
      designation,
      grade,
      managerCode,
      dateOfJoining: joined,
      employmentType: recent ? 'probation' : rng.next() < 0.05 ? 'contract' : 'permanent',
      basic: Math.round(rng.int(lo, hi) / 100) * 100,
      status: leaver ? 'exited' : 'active',
      exitDate: leaver ? addDays(spec.today, -rng.int(5, 19)) : null,
      roles: leaderIndex === null ? [] : (ROLE_PLAN[spec.mode][leaderIndex] ?? []),
    };
    employees.push(e);
    return e;
  };
  // Logins first, in the order of the largest plan: the same ten people in every mode, whichever of them hold a role in this one.
  const top = make('OPS', 'Managing Director', 'G5', null, 0);
  const heads = new Map<string, string>();
  for (let i = 1; i < 10; i++) {
    const dept = LEADER_DEPTS[i]!;
    const e = make(
      dept,
      heads.has(dept) ? rng.pick(DEPARTMENTS.find((d) => d.code === dept)!.titles) : `Head of ${DEPARTMENTS.find((d) => d.code === dept)!.name}`,
      heads.has(dept) ? 'G3' : 'G4',
      heads.get(dept) ?? top.code,
      i,
    );
    if (!heads.has(dept)) heads.set(dept, e.code);
  }
  for (const d of DEPARTMENTS) if (!heads.has(d.code) && d.code !== 'OPS') heads.set(d.code, make(d.code, `Head of ${d.name}`, 'G4', top.code, null).code);
  if (!heads.has('OPS')) heads.set('OPS', top.code);
  const planned = DEPARTMENTS.flatMap((d) => Array.from({ length: Math.round((d.share / 100) * spec.headcount) }, () => d));
  for (let i = 0; employees.length < spec.headcount; i++) {
    const d = planned[i % Math.max(planned.length, 1)] ?? DEPARTMENTS[0];
    make(d.code, rng.pick(d.titles), rng.pick(['G1', 'G1', 'G2', 'G2', 'G2', 'G3']), heads.get(d.code)!, null);
  }
  const uniqueTitles = [...new Set(employees.map((e) => e.designation))].sort();
  return {
    seed: spec.seed,
    mode: spec.mode,
    company,
    branches: BRANCHES,
    departments: DEPARTMENTS.map((d) => ({ code: d.code, name: d.name })),
    grades: GRADES.map((g) => ({ code: g.code, name: g.name })),
    designations: uniqueTitles.map((name, i) => ({ code: `D${String(i + 1).padStart(3, '0')}`, name })),
    employees,
  };
}

/** Writes an organization for a tenant, on a client already allowed past row security. Returns employee ids by code. No module data: that follows the flags, in demo.ts. */
export async function insertOrganization(
  c: pg.Client | pg.PoolClient,
  tenantId: string,
  org: FactoryOrganization,
  opts: { passwordHash: string; cipher: FieldCipher; payroll?: boolean },
): Promise<Map<string, string>> {
  const le = (
    await c.query<{ id: string }>(`INSERT INTO legal_entities (tenant_id, name, gstin, cin, state_code) VALUES ($1,$2,$3,$4,'27') RETURNING id`, [
      tenantId,
      org.company.legalName,
      org.company.gstin,
      org.company.cin,
    ])
  ).rows[0]!.id;
  const branch = new Map<string, string>();
  for (const b of org.branches)
    branch.set(
      b.code,
      (
        await c.query<{ id: string }>(`INSERT INTO branches (tenant_id, legal_entity_id, code, name, state, city) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [
          tenantId,
          le,
          b.code,
          b.name,
          b.state,
          b.city,
        ])
      ).rows[0]!.id,
    );
  const dept = new Map<string, string>();
  for (const d of org.departments)
    dept.set(d.code, (await c.query<{ id: string }>(`INSERT INTO departments (tenant_id, code, name) VALUES ($1,$2,$3) RETURNING id`, [tenantId, d.code, d.name])).rows[0]!.id);
  await insertMasters(c, tenantId, org.grades, org.designations);
  await insertCompanyProfile(c, tenantId, org.company, opts.cipher, !!opts.payroll);
  const ids = new Map<string, string>();
  for (const e of org.employees) {
    const id = (
      await c.query<{ id: string }>(
        `INSERT INTO employees (tenant_id, employee_code, first_name, last_name, work_email, phone, date_of_birth, legal_entity_id, branch_id, department_id, designation, grade, employment_type, status, date_of_joining, exit_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [
          tenantId,
          e.code,
          e.firstName,
          e.lastName,
          e.email,
          e.phone,
          e.dateOfBirth,
          le,
          branch.get(e.branch),
          dept.get(e.department),
          e.designation,
          e.grade,
          e.employmentType,
          e.status,
          e.dateOfJoining,
          e.exitDate,
        ],
      )
    ).rows[0]!.id;
    ids.set(e.code, id);
    if (e.roles.length) {
      const u = (
        await c.query<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash, must_change_password) VALUES ($1,$2,$3,$4,false) RETURNING id`, [
          tenantId,
          e.email,
          `${e.firstName} ${e.lastName}`,
          opts.passwordHash,
        ])
      ).rows[0]!.id;
      for (const r of e.roles) await c.query(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,$3)`, [u, tenantId, r]);
      await c.query(`UPDATE employees SET user_id=$2 WHERE id=$1`, [id, u]);
    }
  }
  for (const e of org.employees) if (e.managerCode) await c.query(`UPDATE employees SET reporting_manager_id=$2 WHERE id=$1`, [ids.get(e.code), ids.get(e.managerCode)]);
  return ids;
}

export async function insertMasters(
  c: pg.Client | pg.PoolClient,
  tenantId: string,
  grades: readonly { code: string; name: string }[],
  designations: readonly { code: string; name: string }[],
) {
  for (const g of grades) await c.query(`INSERT INTO grades (tenant_id, code, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tenantId, g.code, g.name]);
  for (const d of designations) await c.query(`INSERT INTO designations (tenant_id, code, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tenantId, d.code, d.name]);
}

/** Bank and registration details only where payroll is on: an off module gets no data. */
export async function insertCompanyProfile(c: pg.Client | pg.PoolClient, tenantId: string, co: FactoryCompany, cipher: FieldCipher, payroll: boolean) {
  await c.query(
    `INSERT INTO company_profile (tenant_id, legal_name, gstin, pan_enc, pan_last4, tan, cin, registered_address, signatory_name, signatory_designation, pf_registration, esi_registration, pt_registration, bank_account_holder, bank_name, bank_ifsc, bank_account_enc, bank_account_last4)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT (tenant_id) DO NOTHING`,
    [
      tenantId,
      co.legalName,
      co.gstin,
      cipher.encrypt(co.pan),
      co.pan.slice(-4),
      co.tan,
      co.cin,
      co.registeredAddress,
      co.signatoryName,
      co.signatoryDesignation,
      ...(payroll
        ? [
            co.pfRegistration,
            co.esiRegistration,
            co.ptRegistration,
            co.bankAccountHolder,
            co.bankName,
            co.bankIfsc,
            cipher.encrypt(co.bankAccountNumber),
            co.bankAccountNumber.slice(-4),
          ]
        : [null, null, null, null, null, null, null, null]),
    ],
  );
}
