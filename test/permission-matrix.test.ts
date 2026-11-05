import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { problem, Client, PASSWORD, flags, makeApp, ownerQuery, seal, testCipher, inApp } from './helpers.js';
import { LocalStore, newKey, setStore } from '../src/core/storage/index.js';
import { hashPassword } from '../src/core/crypto/index.js';
import { runSchedules } from '../src/modules/reports/service.js';
import { pdfText } from './pdf-text.js';

/**
 * The permission matrix: every mode, every role, every data level, by real requests against the app. The expectation is written out here
 * by hand from the requirements, not computed by the policy code, so a mistake in the policy shows up as a failure. Every subject has a
 * salary and bank number nobody else has, and each answer is searched for them: a denied read must not contain them in any form.
 */
type Mode = 'single' | 'single_hr' | 'multi';
interface Persona { key: string; roles: string[]; stored?: number; level: number; login?: boolean; payroll?: boolean; bank?: boolean; loans?: boolean; hrL3?: boolean; employeesRead?: boolean; auditRead?: boolean; accounting?: boolean; pay?: boolean; chain?: boolean; manage?: boolean; compensation?: boolean }

const OWNER: Pick<Persona, 'payroll' | 'bank' | 'loans' | 'hrL3' | 'employeesRead' | 'auditRead' | 'accounting' | 'pay' | 'chain' | 'manage' | 'compensation'> = { payroll: true, bank: true, loans: true, hrL3: true, employeesRead: true, auditRead: true, accounting: true, pay: true, chain: true, manage: true, compensation: true };
const PEOPLE: Record<Mode, Persona[]> = {
  single: [
    { key: 'owner', roles: ['owner', 'employee'], level: 100, ...OWNER },
    { key: 'employee', roles: ['employee'], level: 0 },
    { key: 'nologin', roles: [], level: 0, login: false },
  ],
  single_hr: [
    { key: 'owner', roles: ['owner', 'employee'], level: 100, ...OWNER },
    // HR handles people, not pay: no L4 at all in this mode, whatever the level.
    { key: 'hrA', roles: ['hr_admin', 'employee'], level: 40, hrL3: true, employeesRead: true },
    { key: 'hrB', roles: ['hr_executive', 'employee'], level: 30, hrL3: true, employeesRead: true },
    { key: 'employee', roles: ['employee'], level: 0 },
    { key: 'nologin', roles: [], level: 0, login: false },
  ],
  multi: [
    { key: 'owner', roles: ['owner', 'employee'], level: 100, payroll: true, bank: true, loans: true, hrL3: false, employeesRead: true, auditRead: true, chain: true },
    { key: 'super', roles: ['tenant_admin', 'employee'], level: 90, payroll: true, bank: true, loans: true, employeesRead: true, auditRead: true, chain: true },
    { key: 'seniorPayroll', roles: ['payroll_manager', 'employee'], stored: 85, level: 85, payroll: true, bank: true, loans: true, employeesRead: true, accounting: true, pay: true, manage: true },
    { key: 'it', roles: ['it_admin', 'employee'], level: 60 },
    // A misconfigured level cannot lift HR over an administrator, and a low one cannot put them under their floor.
    { key: 'hrCapped', roles: ['hr_admin', 'employee'], stored: 99, level: 59, payroll: true, bank: true, loans: true, hrL3: true, employeesRead: true, auditRead: true, compensation: true },
    { key: 'finance', roles: ['finance_manager', 'employee'], level: 50, payroll: true, loans: true, accounting: true, pay: true, compensation: true },
    { key: 'hrA', roles: ['hr_admin', 'employee'], stored: 1, level: 40, payroll: true, bank: true, loans: true, hrL3: true, employeesRead: true, auditRead: true, compensation: true },
    { key: 'hrB', roles: ['hr_admin', 'employee'], level: 40, payroll: true, bank: true, loans: true, hrL3: true, employeesRead: true, auditRead: true, compensation: true },
    { key: 'payroll', roles: ['payroll_manager', 'employee'], level: 40, payroll: true, bank: true, loans: true, employeesRead: true, accounting: true, pay: true, manage: true },
    { key: 'hrExec', roles: ['hr_executive', 'employee'], level: 30, hrL3: true, employeesRead: true },
    { key: 'auditor', roles: ['auditor', 'employee'], level: 30, payroll: true, loans: true, employeesRead: true, auditRead: true },
    { key: 'manager', roles: ['reporting_manager', 'employee'], level: 10 },
    { key: 'employee', roles: ['employee'], level: 0 },
    { key: 'peer', roles: ['employee'], level: 0 },
    { key: 'nologin', roles: [], level: 0, login: false },
  ],
};
const FLAGS = 'default,payroll,payroll.payslips,payroll.statutory,loans,salary_advance,reports.advanced,accounting_exports,expenses,recruitment,core.onboarding,core.offboarding';
const PERIOD = '2026-01';

interface Subject extends Persona { employeeId: string; userId: string | null; code: string; gross: number; figure: string; account: string; uan: string; itemId: string; loanId: string; docId: string; payDocId: string; phone: string }
interface Hiring { requisitionId: string; candidateId: string; applicationId: string; budget: string; expected: string; offer: string }
interface World { app: FastifyInstance; host: string; tenantId: string; runId: string; releasedRunId: string; subjects: Record<string, Subject>; clients: Record<string, Client>; root: string; hiring: Hiring }

async function build(mode: Mode, env: Record<string, string> = {}): Promise<World> {
  const root = await mkdtemp(path.join(tmpdir(), 'hrms-matrix-'));
  setStore(new LocalStore(root));
  const app = await makeApp({ ...flags(FLAGS), ORG_MANAGEMENT_MODE: mode, RATE_LIMIT_PER_MINUTE: '100000', ...env }, { storeOverride: true });
  const slug = 'm' + randomBytes(5).toString('hex'); const host = `${slug}.test`;
  const q = ownerQuery;
  const [t] = await q<{ id: string }>(`INSERT INTO tenants (slug, name) VALUES ($1,$1) RETURNING id`, [slug]);
  const tid = t!.id;
  await q(`INSERT INTO tenant_branding (tenant_id, display_name) VALUES ($1,'M')`, [tid]);
  await q(`INSERT INTO tenant_domains (tenant_id, hostname, verification_token, verification_status, verified_at, activation_status) VALUES ($1,$2,'x','verified',now(),'active')`, [tid, host]);
  const [le] = await q<{ id: string }>(`INSERT INTO legal_entities (tenant_id, name) VALUES ($1,'LE') RETURNING id`, [tid]);
  const [br] = await q<{ id: string }>(`INSERT INTO branches (tenant_id, legal_entity_id, code, name, state) VALUES ($1,$2,'HQ','HQ','Maharashtra') RETURNING id`, [tid, le!.id]);
  const [cat] = await q<{ id: string }>(`INSERT INTO document_categories (tenant_id, code, name, scope, employee_visible) VALUES ($1,'IDP','Identity','employee',true) RETURNING id`, [tid]);
  const [payCat] = await q<{ id: string }>(`INSERT INTO document_categories (tenant_id, code, name, scope, employee_visible, payroll_related) VALUES ($1,'TAX','Tax proof','employee',true,true) RETURNING id`, [tid]);
  const pw = await hashPassword(PASSWORD);
  const people = PEOPLE[mode];
  const subjects: Record<string, Subject> = {};
  let i = 0; let creator = '';
  for (const p of people) {
    i++;
    let userId: string | null = null;
    if (p.login !== false) {
      const [u] = await q<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, password_hash, salary_access_level) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [tid, `${p.key.toLowerCase()}@${host}`, p.key, pw, p.stored ?? 0]);
      userId = u!.id; creator ||= userId;
      for (const r of p.roles) await q(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,$3)`, [userId, tid, r]);
    }
    const code = `M${String(i).padStart(3, '0')}`;
    const phone = `+91 98${String(10000000 + i * 137)}`;
    const [e] = await q<{ id: string }>(`INSERT INTO employees (tenant_id, employee_code, first_name, last_name, legal_entity_id, branch_id, date_of_joining, user_id, phone) VALUES ($1,$2,'Emp',$3,$4,$5,'2024-01-01',$6,$7) RETURNING id`, [tid, code, p.key, le!.id, br!.id, userId, phone]);
    const gross = 70000 + i * 1111; const account = `90${String(1000000000 + i * 7919)}`;
    subjects[p.key] = { ...p, employeeId: e!.id, userId, code, gross, figure: String(gross), account, uan: String(100000000000 + i * 104729), itemId: '', loanId: '', docId: '', payDocId: '', phone };
  }
  const [run] = await q<{ id: string }>(`INSERT INTO payroll_runs (tenant_id, legal_entity_id, period, created_by, totals_enc) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [tid, le!.id, PERIOD, creator, seal({ employees: people.length, gross: 1, deductions: 0, net: 1, employerCost: 1, held: 0 })]);
  await q(`INSERT INTO pay_components (tenant_id, code, name, kind) VALUES ($1,'BASIC','Basic','earning')`, [tid]);
  for (const s of Object.values(subjects)) {
    await q(`INSERT INTO employee_salaries (tenant_id, employee_id, effective_from, amounts_enc, annual_ctc_enc, reason, status, created_by, approved_at) VALUES ($1,$2,'2025-01-01',$3,$4,'fixture','active',$5,now())`,
      [tid, s.employeeId, seal({ BASIC: s.gross }), seal(s.gross * 12), creator]);
    const [it] = await q<{ id: string }>(`INSERT INTO payroll_items (tenant_id, run_id, employee_id, days_in_period, employed_days, paid_days, data_enc, calc_version) VALUES ($1,$2,$3,31,31,31,$4,6) RETURNING id`,
      [tid, run!.id, s.employeeId, seal({ lines: [{ code: 'BASIC', name: 'Basic', kind: 'earning', amount: s.gross }, { code: 'PF_EE', name: 'PF', kind: 'deduction', amount: 0 }, { code: 'ESI_EE', name: 'ESI', kind: 'deduction', amount: 0 }], gross: s.gross, deductions: 0, net: s.gross, employerCost: s.gross, warnings: [] })]);
    s.itemId = it!.id;
    await q(`INSERT INTO employee_bank_accounts (employee_id, tenant_id, account_holder, account_number_enc, account_last4, ifsc) VALUES ($1,$2,'Holder',$3,$4,'HDFC0001234')`, [s.employeeId, tid, testCipher.encrypt(s.account), s.account.slice(-4)]);
    await q(`INSERT INTO employee_statutory (tenant_id, employee_id, uan) VALUES ($1,$2,$3)`, [tid, s.employeeId, s.uan]);
    const [l] = await q<{ id: string }>(`INSERT INTO employee_loans (tenant_id, employee_id, kind, amount, installments, installment_amount, first_period, purpose, status, created_by) VALUES ($1,$2,'loan',$3,1,$3,$4,'fixture purpose','disbursed',$5) RETURNING id`,
      [tid, s.employeeId, s.gross, PERIOD, creator]);
    s.loanId = l!.id;
    const key = newKey(tid, s.employeeId);
    await mkdir(path.dirname(path.join(root, key)), { recursive: true });
    await writeFile(path.join(root, key), `%PDF secret of ${s.key}`);
    const [d] = await q<{ id: string }>(`INSERT INTO documents (tenant_id, category_id, employee_id, title, file_name, content_type, size_bytes, sha256, storage_key, uploaded_by) VALUES ($1,$2,$3,'ID','id.pdf','application/pdf',20,$6,$4,$5) RETURNING id`,
      [tid, cat!.id, s.employeeId, key, creator, createHash('sha256').update(`%PDF secret of ${s.key}`).digest('hex')]);
    s.docId = d!.id;
    const payKey = newKey(tid, s.employeeId);
    await writeFile(path.join(root, payKey), `%PDF secret of ${s.key}`);
    const [pd] = await q<{ id: string }>(`INSERT INTO documents (tenant_id, category_id, employee_id, title, file_name, content_type, size_bytes, sha256, storage_key, uploaded_by) VALUES ($1,$2,$3,'Tax','tax.pdf','application/pdf',20,$6,$4,$5) RETURNING id`,
      [tid, payCat!.id, s.employeeId, payKey, creator, createHash('sha256').update(`%PDF secret of ${s.key}`).digest('hex')]);
    s.payDocId = pd!.id;
  }
  for (const s of Object.values(subjects)) {
    await q(`INSERT INTO separations (tenant_id, employee_id, kind, reason, notice_date, requested_lwd, notice_days_required, status, initiated_by) VALUES ($1,$2,'resignation','Fixture reason','2026-01-01','2026-01-31',30,'approved',$3)`, [tid, s.employeeId, creator]);
  }
  const [rel] = await q<{ id: string }>(`INSERT INTO payroll_runs (tenant_id, legal_entity_id, period, created_by, totals_enc) VALUES ($1,$2,'2025-12',$3,$4) RETURNING id`, [tid, le!.id, creator, seal({ employees: 2, gross: 1, deductions: 0, net: 1, employerCost: 1, held: 0 })]);
  for (const key of [people[0]!.key, people[people.length - 1]!.key]) {
    const s = subjects[key]!;
    await q(`INSERT INTO payroll_items (tenant_id, run_id, employee_id, days_in_period, employed_days, paid_days, data_enc, calc_version, hold_released_at) VALUES ($1,$2,$3,31,31,31,$4,6,now())`,
      [tid, rel!.id, s.employeeId, seal({ lines: [{ code: 'BASIC', name: 'Basic', kind: 'earning', amount: s.gross }], gross: s.gross, deductions: 0, net: s.gross, employerCost: s.gross, warnings: [] })]);
  }
  await q(`UPDATE payroll_runs SET status='finalized', computed_at=now(), finalized_at=now() WHERE id=$1`, [rel!.id]);
  const hiring = { budget: '7654321', expected: '6543217', offer: '5432176' };
  const [rq] = await q<{ id: string }>(`INSERT INTO job_requisitions (tenant_id, number, title, legal_entity_id, branch_id, employment_type, justification, budget_ctc_max, status, created_by) VALUES ($1,1,'Analyst',$2,$3,'permanent','Fixture need',$4,'approved',$5) RETURNING id`, [tid, le!.id, br!.id, hiring.budget, creator]);
  const [cd] = await q<{ id: string }>(`INSERT INTO candidates (tenant_id, first_name, source, expected_ctc, created_by, consent_at, consent_note, retain_until) VALUES ($1,'Cand','referral',$2,$3,now(),'Fixture','2030-01-01') RETURNING id`, [tid, hiring.expected, creator]);
  const [ap] = await q<{ id: string }>(`INSERT INTO job_applications (tenant_id, requisition_id, candidate_id, stage, created_by) VALUES ($1,$2,$3,'offer',$4) RETURNING id`, [tid, rq!.id, cd!.id, creator]);
  await q(`INSERT INTO job_offers (tenant_id, application_id, designation, legal_entity_id, branch_id, employment_type, annual_ctc, joining_date, created_by) VALUES ($1,$2,'Analyst',$3,$4,'permanent',$5,'2026-06-01',$6)`, [tid, ap!.id, le!.id, br!.id, hiring.offer, creator]);
  await q(`UPDATE payroll_runs SET status='paid', computed_at=now(), finalized_at=now(), paid_at=now() WHERE id=$1`, [run!.id]);
  const clients: Record<string, Client> = {};
  for (const p of people) if (p.login !== false) clients[p.key] = await Client.login(app, host, `${p.key.toLowerCase()}@${host}`);
  return { app, host, tenantId: tid, runId: run!.id, releasedRunId: rel!.id, subjects, clients, root, hiring: { requisitionId: rq!.id, candidateId: cd!.id, applicationId: ap!.id, ...hiring } };
}

const mayL4 = (v: Persona, s: Persona, perm: boolean | undefined) => v.key === s.key || (!!perm && v.level > s.level);
const pdfAmount = (n: number) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const leaks = (body: string, s: Subject) => body.includes(s.figure) || body.includes(s.account) || body.includes(s.uan);

for (const mode of ['single', 'single_hr', 'multi'] as const) {
  describe(`permission matrix: ${mode}`, () => {
    let w: World;
    beforeAll(async () => { w = await build(mode); }, 120000);
    afterAll(async () => { await w.app.close(); setStore(null); await rm(w.root, { recursive: true, force: true }); });
    const viewers = PEOPLE[mode].filter((p) => p.login !== false);
    const everyone = PEOPLE[mode];

    /** One L4 path per viewer against every subject: full figure when allowed, and no trace of it when not. */
    const L4_PATHS: { name: string; perm: (v: Persona) => boolean | undefined; self?: boolean; url: (s: Subject) => string }[] = [
      { name: 'L4 salary API', perm: (v) => v.payroll, url: (s) => `/api/v1/payroll/employees/${s.employeeId}/salaries?reveal=1` },
      { name: 'L4 payslip API', perm: (v) => v.payroll, url: (s) => `/api/v1/payroll/payslips/${s.itemId}?reveal=1` },
      { name: 'L4 bank account API', perm: (v) => v.bank, url: (s) => `/api/v1/employees/${s.employeeId}/bank-account?reveal=1` },
      { name: 'L4 statutory API', perm: (v) => v.payroll, url: (s) => `/api/v1/payroll/employees/${s.employeeId}/statutory?reveal=1` },
      { name: 'L4 loan API', perm: (v) => v.loans, url: (s) => `/api/v1/loans/requests/${s.loanId}?reveal=1` },
    ];
    for (const p of L4_PATHS) {
      it.each(viewers.map((v) => [v.key, v] as const))(`${p.name} as %s`, async (_k, v) => {
        for (const sp of everyone) {
          const s = w.subjects[sp.key]!;
          const r = await w.clients[v.key]!.get(p.url(s));
          const allowed = mayL4(v, sp, p.perm(v));
          const label = `${mode}: ${v.key} -> ${sp.key} ${p.name}`;
          if (allowed) {
            expect(r.statusCode, `${label}: ${r.body}`).toBe(200);
            expect(r.json().masked, label).toBeUndefined();
          } else {
            expect([403, 404], `${label}: ${r.statusCode}`).toContain(r.statusCode);
            expect(leaks(r.body, s), `${label} leaked`).toBe(false);
          }
        }
      });
    }

    // The file answers exactly as the JSON route with reveal does, and shows the figure it was allowed to. Its body is searched as text.
    it.each(viewers.map((v) => [v.key, v] as const))('L4 payslip PDF as %s', async (_k, v) => {
      for (const sp of everyone) {
        const s = w.subjects[sp.key]!;
        const r = await w.clients[v.key]!.get(`/api/v1/payroll/payslips/${s.itemId}/payslip.pdf`);
        const label = `${mode}: ${v.key} -> ${sp.key} payslip PDF`;
        if (mayL4(v, sp, v.payroll)) {
          expect(r.statusCode, `${label}: ${r.body.slice(0, 200)}`).toBe(200);
          expect(r.headers['content-disposition']).toBe(`attachment; filename="payslip-${PERIOD}.pdf"`);
          const text = await pdfText(r.rawPayload);
          expect(text, label).toContain(pdfAmount(s.gross));
          expect(text, label).not.toContain(s.account);
        } else {
          expect(r.statusCode, `${label}: ${r.statusCode}`).toBe(404);
          expect(leaks(r.body, s), `${label} leaked`).toBe(false);
        }
      }
    });

    it.each(viewers.map((v) => [v.key, v] as const))('L4 report PDF exports leave out who is above, and say so, as %s', async (_k, v) => {
      const c = w.clients[v.key]!;
      const r = await c.get(`/api/v1/reports/payroll_cost/export.pdf?from=${PERIOD}&to=${PERIOD}`);
      if (!v.payroll) { expect(r.statusCode, v.key).toBe(403); return; }
      expect(r.statusCode, v.key).toBe(200);
      const visible = everyone.filter((sp) => mayL4(v, sp, true));
      const hidden = everyone.length - visible.length;
      expect(r.headers['x-excluded-subjects']).toBe(String(hidden));
      const text = await pdfText(r.rawPayload);
      const sum = visible.reduce((t, sp) => t + w.subjects[sp.key]!.gross, 0);
      expect(text.includes(pdfAmount(sum)), v.key).toBe(!(hidden && visible.length < 3));
      const all = everyone.reduce((t, sp) => t + w.subjects[sp.key]!.gross, 0);
      if (hidden) expect(text.includes(pdfAmount(all)), `${v.key} total of everyone`).toBe(false);
    });

    // Letters are HR's, above the person. The experience letter is also the person's own. A figure on a letter needs L4 on top.
    it.each(viewers.map((v) => [v.key, v] as const))('L3 letters as %s', async (_k, v) => {
      for (const sp of everyone) {
        const s = w.subjects[sp.key]!;
        const label = `${mode}: ${v.key} -> ${sp.key}`;
        const above = !!v.hrL3 && v.key !== sp.key && v.level > sp.level;
        const appointment = await w.clients[v.key]!.get(`/api/v1/lifecycle/employees/${s.employeeId}/letters/appointment.pdf?includePay=1`);
        if (!v.hrL3) expect(appointment.statusCode, `${label} appointment`).toBe(403);
        else expect(appointment.statusCode, `${label} appointment`).toBe(above ? 200 : 404);
        if (appointment.statusCode === 200) {
          const paid = !!v.payroll && v.level > sp.level;
          expect(appointment.headers['x-pay-included'], `${label} salary`).toBe(paid ? '1' : '0');
          expect((await pdfText(appointment.rawPayload)).includes(pdfAmount(s.gross * 12)), `${label} figure`).toBe(paid);
        } else expect(leaks(appointment.body, s), label).toBe(false);
        const experience = await w.clients[v.key]!.get(`/api/v1/lifecycle/employees/${s.employeeId}/letters/experience.pdf`);
        expect(experience.statusCode, `${label} experience`).toBe(above || v.key === sp.key ? 200 : 404);
        if (experience.statusCode === 200) expect(await pdfText(experience.rawPayload), label).not.toContain('Fixture reason');
      }
    });

    it.each(viewers.map((v) => [v.key, v] as const))('L4 fields are masked without reveal, even for the person themselves, as %s', async (_k, v) => {
      const s = w.subjects[v.key]!;
      for (const url of [`/api/v1/payroll/employees/${s.employeeId}/salaries`, `/api/v1/payroll/payslips/${s.itemId}`, `/api/v1/employees/${s.employeeId}/bank-account`, `/api/v1/payroll/employees/${s.employeeId}/statutory`, `/api/v1/loans/requests/${s.loanId}`]) {
        const r = await w.clients[v.key]!.get(url);
        expect(r.statusCode, `${url}: ${r.body}`).toBe(200);
        expect(leaks(r.body, s), `${url} leaked without reveal`).toBe(false);
        const json = r.json();
        const row = json.items ? json.items[0] : json;
        expect(row.masked, url).toBe(true);
        expect(Array.isArray(row.maskedFields), url).toBe(true);
        for (const f of row.maskedFields as string[]) expect(row[f], `${url} ${f}`).toBeNull();
      }
    });

    it.each(viewers.map((v) => [v.key, v] as const))('L4 run detail and bulk reveal shows only who is below, as %s', async (_k, v) => {
      const r = await w.clients[v.key]!.get(`/api/v1/payroll/runs/${w.runId}?reveal=1`);
      if (!v.payroll) { expect(r.statusCode).toBe(403); return; }
      expect(r.statusCode, r.body).toBe(200);
      const items = r.json().items as { employee_id: string; gross: string }[];
      let hidden = 0;
      for (const sp of everyone) {
        const s = w.subjects[sp.key]!;
        const item = items.find((i) => i.employee_id === s.employeeId);
        if (mayL4(v, sp, true)) expect(Number(item?.gross), `${v.key} -> ${sp.key}`).toBe(s.gross);
        else { hidden++; expect(item, `${v.key} -> ${sp.key}`).toBeUndefined(); expect(leaks(r.body, s), `${v.key} -> ${sp.key} leaked`).toBe(false); }
      }
      expect(r.json().excluded).toBe(hidden);
      const expected = everyone.filter((sp) => mayL4(v, sp, true)).reduce((t, sp) => t + w.subjects[sp.key]!.gross, 0);
      expect(r.json().totals.gross).toBe(expected);
    });

    it.each(viewers.map((v) => [v.key, v] as const))('L4 register CSV and XLSX exports leave out who is above, and say so, as %s', async (_k, v) => {
      for (const ext of ['csv', 'xlsx']) {
        const r = await w.clients[v.key]!.get(`/api/v1/payroll/runs/${w.runId}/register.${ext}`);
        if (!v.payroll) { expect(r.statusCode).toBe(403); continue; }
        expect(r.statusCode, r.body).toBe(200);
        const hidden = everyone.filter((sp) => !mayL4(v, sp, true));
        expect(r.headers['x-excluded-subjects']).toBe(String(hidden.length));
        if (ext === 'csv') for (const sp of everyone) expect(r.body.includes(w.subjects[sp.key]!.code), `${v.key} -> ${sp.key}`).toBe(mayL4(v, sp, true));
      }
    });

    it.each(viewers.map((v) => [v.key, v] as const))('L4 bank, PF and ESI files are whole or refused, as %s', async (_k, v) => {
      for (const file of ['bank', 'pf', 'esi']) {
        const r = await w.clients[v.key]!.get(`/api/v1/payroll/runs/${w.runId}/${file}.csv`);
        if (!v.payroll) { expect(r.statusCode).toBe(403); continue; }
        const whole = everyone.every((sp) => mayL4(v, sp, true));
        if (whole) {
          expect(r.statusCode, `${file}: ${r.body}`).toBe(200);
          for (const sp of everyone) expect(r.body.includes(w.subjects[sp.key]!.code)).toBe(true);
        } else {
          expect(r.statusCode, `${v.key} ${file}: ${r.body}`).toBe(403);
          expect(problem(r).code).toBe('requires_higher_level');
          expect(problem(r).hiddenSubjects).toBe(everyone.filter((sp) => !mayL4(v, sp, true)).length);
          for (const sp of everyone) expect(leaks(r.body, w.subjects[sp.key]!)).toBe(false);
        }
      }
    });

    // The file for pay released after a hold covers only the people released: a later run, with the highest person and the lowest.
    it.each(viewers.map((v) => [v.key, v] as const))('L4 bank-released file is whole or refused, as %s', async (_k, v) => {
      const top = everyone[0]!; const bottom = everyone[everyone.length - 1]!;
      const r = await w.clients[v.key]!.get(`/api/v1/payroll/runs/${w.releasedRunId}/bank-released.csv`);
      if (!v.payroll) { expect(r.statusCode).toBe(403); return; }
      const whole = mayL4(v, top, true) && mayL4(v, bottom, true);
      expect(r.statusCode, `${v.key}: ${r.body}`).toBe(whole ? 200 : 403);
      if (whole) {
        for (const sp of everyone) {
          const s = w.subjects[sp.key]!;
          if (sp !== top && sp !== bottom) expect(r.body.includes(s.code), sp.key).toBe(false);
          else { expect(r.body.includes(s.code), sp.key).toBe(true); expect(r.body.includes(s.account), `${v.key} account of ${sp.key}`).toBe(!!v.bank); }
        }
      } else {
        expect(problem(r).code).toBe('requires_higher_level');
        for (const sp of everyone) expect(leaks(r.body, w.subjects[sp.key]!)).toBe(false);
      }
    });

    it.each(viewers.map((v) => [v.key, v] as const))('L4 F&F suggestions: subject out of reach is 404, masked until revealed, as %s', async (_k, v) => {
      for (const sp of everyone) {
        const s = w.subjects[sp.key]!;
        const url = `/api/v1/payroll/fnf-suggestions/${s.employeeId}`;
        const [masked, shown] = [await w.clients[v.key]!.get(url), await w.clients[v.key]!.get(`${url}?reveal=1`)];
        const label = `${v.key} -> ${sp.key}`;
        if (!v.manage) { expect(masked.statusCode, label).toBe(403); expect(shown.statusCode, label).toBe(403); continue; }
        const allowed = mayL4(v, sp, true);
        expect(shown.statusCode, `${label}: ${shown.body}`).toBe(allowed ? 200 : 404);
        expect(masked.statusCode, label).toBe(allowed ? 200 : 404);
        expect(leaks(masked.body, s), `${label} masked`).toBe(false);
        expect(shown.body.includes(s.figure), `${label} revealed`).toBe(allowed);
        if (allowed) { expect(masked.json().masked).toBe(true); expect(masked.json().salary).toBeNull(); }
      }
    });

    it.each(viewers.map((v) => [v.key, v] as const))('L4 accounting sources show totals of who is below, masked until revealed, as %s', async (_k, v) => {
      const c = w.clients[v.key]!;
      const r = await c.get('/api/v1/accounting/sources?reveal=1');
      if (!v.accounting) { expect(r.statusCode, v.key).toBe(403); return; }
      expect(r.statusCode, r.body).toBe(200);
      const visible = everyone.filter((sp) => mayL4(v, sp, true));
      const run = (r.json().runs as { id: string; totals: { gross: number }; excluded: number }[]).find((x) => x.id === w.runId)!;
      expect(run.excluded).toBe(everyone.length - visible.length);
      expect(run.totals.gross).toBe(visible.reduce((t, sp) => t + w.subjects[sp.key]!.gross, 0));
      for (const sp of everyone.filter((x) => !visible.includes(x))) expect(leaks(r.body, w.subjects[sp.key]!), `${v.key} -> ${sp.key}`).toBe(false);
      const masked = (await c.get('/api/v1/accounting/sources')).json().runs.find((x: { id: string }) => x.id === w.runId);
      expect(masked.totals).toBeNull();
      expect(masked.maskedFields).toEqual(['totals']);
    });

    it.each(viewers.map((v) => [v.key, v] as const))('L4 department overview adds up who is below, by level, in the report and its export, as %s', async (_k, v) => {
      const c = w.clients[v.key]!;
      const q = 'from=2026-01-01&to=2026-01-31';
      const r = await c.get(`/api/v1/reports/department_overview?${q}&reveal=1`);
      const file = await c.get(`/api/v1/reports/department_overview/export.csv?${q}`);
      if (!v.employeesRead) { expect(r.statusCode, v.key).toBe(403); expect(file.statusCode, v.key).toBe(403); return; }
      expect(r.statusCode, r.body).toBe(200);
      const row = (r.json().rows as Record<string, unknown>[])[0]!;
      for (const sp of everyone) expect(leaks(file.body, w.subjects[sp.key]!) && !mayL4(v, sp, true), `${v.key} export shows ${sp.key}`).toBe(false);
      if (!v.payroll) { expect('payroll_gross' in row, v.key).toBe(false); expect(file.body.includes('Payroll gross')).toBe(false); return; }
      const visible = everyone.filter((sp) => mayL4(v, sp, true));
      const hidden = everyone.length - visible.length;
      expect(r.json().excluded).toBe(hidden);
      expect(file.headers['x-excluded-subjects']).toBe(String(hidden));
      const sum = visible.reduce((t, sp) => t + w.subjects[sp.key]!.gross, 0);
      if (hidden && visible.length < 3) { expect(row.payroll_gross, v.key).toBeNull(); expect(file.body.includes(String(sum)), v.key).toBe(false); }
      else { expect(Number(row.payroll_gross), v.key).toBe(sum); expect(file.body.includes(String(sum)), v.key).toBe(true); }
      const masked = await c.get(`/api/v1/reports/department_overview?${q}`);
      expect((masked.json().rows as Record<string, unknown>[])[0]!.payroll_gross).toBeNull();
      expect(masked.body.includes(String(sum))).toBe(false);
    });

    it.each(viewers.map((v) => [v.key, v] as const))('L4 recruitment figures: the compensation permission, then masked until revealed, as %s', async (_k, v) => {
      const c = w.clients[v.key]!; const h = w.hiring;
      const paths: [string, string][] = [['/recruitment/requisitions', h.budget], [`/recruitment/requisitions/${h.requisitionId}`, h.budget], ['/recruitment/candidates', h.expected], [`/recruitment/candidates/${h.candidateId}`, h.expected], [`/recruitment/applications/${h.applicationId}`, h.offer]];
      for (const [path, figure] of paths) {
        const masked = await c.get(`/api/v1${path}`);
        expect(masked.body.includes(figure), `${v.key} ${path} without reveal`).toBe(false);
        const shown = await c.get(`/api/v1${path}?reveal=1`);
        // A reader with the compensation permission must really get an answer here, or this test proves nothing.
        if (mode === 'multi' && v.key === 'hrA') expect(shown.statusCode, path).toBe(200);
        if (shown.statusCode !== 200) { expect(shown.body.includes(figure)).toBe(false); continue; }
        // The list of candidates never carries a figure, whoever asks.
        const carries = !!v.compensation && path !== '/recruitment/candidates';
        expect(shown.body.includes(figure), `${v.key} ${path} with reveal`).toBe(carries);
      }
    });

    it.each(viewers.map((v) => [v.key, v] as const))('L4 payroll cost report adds up only who is below, as %s', async (_k, v) => {
      const r = await w.clients[v.key]!.get(`/api/v1/reports/payroll_cost?from=${PERIOD}&to=${PERIOD}&reveal=1`);
      if (!v.payroll) { expect(r.statusCode).toBe(403); return; }
      expect(r.statusCode, r.body).toBe(200);
      const visible = everyone.filter((sp) => mayL4(v, sp, true));
      const hidden = everyone.length - visible.length;
      expect(r.json().excluded).toBe(hidden);
      // A small group with someone hidden gets no amounts at all.
      const expected = hidden && visible.length < 3 ? 0 : visible.reduce((t, sp) => t + w.subjects[sp.key]!.gross, 0);
      expect(Number(r.json().totals?.gross ?? 0), v.key).toBe(expected);
      if (hidden) expect(r.json().notes.join(' ')).toContain('above your salary level');
      const masked = await w.clients[v.key]!.get(`/api/v1/reports/payroll_cost?from=${PERIOD}&to=${PERIOD}`);
      expect(masked.json().totals?.gross ?? null).toBeNull();
    });

    it.each(viewers.map((v) => [v.key, v] as const))('L4 journal is whole or refused, as %s', async (_k, v) => {
      const r = await w.clients[v.key]!.get(`/api/v1/accounting/payroll-runs/${w.runId}/journal`);
      if (!v.accounting) { expect(r.statusCode).toBe(403); return; }
      expect(r.statusCode, r.body).toBe(everyone.every((sp) => mayL4(v, sp, true)) ? 200 : 403);
    });

    it.each(viewers.map((v) => [v.key, v] as const))('L4 never reaches search, dashboards, notifications, audit views or the employee list, as %s', async (_k, v) => {
      const c = w.clients[v.key]!;
      for (const url of ['/api/v1/employees?pageSize=100', '/api/v1/dashboard', '/api/v1/notifications', '/api/v1/approvals/inbox', '/api/v1/tenant/audit?pageSize=100']) {
        const r = await c.get(url);
        for (const sp of everyone) expect(leaks(r.body, w.subjects[sp.key]!), `${v.key} ${url} shows ${sp.key}`).toBe(false);
      }
      for (const sp of everyone) {
        const s = w.subjects[sp.key]!;
        for (const term of [s.figure, s.account, s.uan]) expect((await c.get(`/api/v1/employees?search=${term}`)).json().items ?? [], `search by ${term}`).toEqual([]);
      }
    });

    it.each(viewers.map((v) => [v.key, v] as const))('L3 phone, date of birth, personal profile and document files: self and HR above them, as %s', async (_k, v) => {
      for (const sp of everyone) {
        const s = w.subjects[sp.key]!;
        const allowedL3 = v.key === sp.key || (!!v.hrL3 && v.level > sp.level);
        const label = `${v.key} -> ${sp.key}`;
        const e = await w.clients[v.key]!.get(`/api/v1/employees/${s.employeeId}`);
        expect(e.statusCode, label).toBe(200);
        expect(e.body.includes(s.phone), `${label} phone`).toBe(allowedL3);
        if (!allowedL3 && e.json().view === 'full') expect(e.json().masked, label).toBe(true);
        const prof = await w.clients[v.key]!.get(`/api/v1/employees/${s.employeeId}/profile`);
        expect(prof.statusCode === 200, `${label} profile ${prof.statusCode}`).toBe(v.key === sp.key || (!!v.employeesRead && !!v.hrL3 && v.level > sp.level));
      }
    });

    it.each(viewers.map((v) => [v.key, v] as const))('L3 direct file URL of someone else’s document, as %s', async (_k, v) => {
      for (const sp of everyone) {
        const s = w.subjects[sp.key]!;
        // Self and HR above them. Payroll and auditors are neither: they read payroll categories only, by the same level rule (D43).
        const r = await w.clients[v.key]!.get(`/api/v1/documents/${s.docId}/download`);
        const allowed = v.key === sp.key || (!!v.hrL3 && v.level > sp.level);
        expect(r.statusCode === 200, `${v.key} -> ${sp.key}: ${r.statusCode}`).toBe(allowed);
        if (!allowed) expect(r.body.includes('secret')).toBe(false);
        const tax = await w.clients[v.key]!.get(`/api/v1/documents/${s.payDocId}/download`);
        const payDocs = v.hrL3 || ['payroll', 'seniorPayroll', 'auditor'].includes(v.key);
        expect(tax.statusCode === 200, `tax: ${v.key} -> ${sp.key}: ${tax.statusCode}`).toBe(v.key === sp.key || (!!payDocs && v.level > sp.level));
        if (v.key !== sp.key && ['payroll', 'auditor'].includes(v.key)) expect((await w.clients[v.key]!.get(`/api/v1/documents?employeeId=${s.employeeId}`)).json().items.some((d: { id: string }) => d.id === s.docId)).toBe(false);
      }
    });

    it.each(viewers.map((v) => [v.key, v] as const))('L2 and L1: everyone sees the directory; only full readers see joining date, as %s', async (_k, v) => {
      for (const sp of everyone) {
        const s = w.subjects[sp.key]!;
        const r = await w.clients[v.key]!.get(`/api/v1/employees/${s.employeeId}`);
        expect(r.statusCode).toBe(200);
        expect(r.json().employee_code).toBe(s.code);
        const full = v.key === sp.key || !!v.employeesRead;
        expect(r.json().view, `${v.key} -> ${sp.key}`).toBe(full ? 'full' : 'directory');
        expect('date_of_joining' in r.json(), `${v.key} -> ${sp.key}`).toBe(full);
      }
    });

    it.each(viewers.map((v) => [v.key, v] as const))('audit chain viewer is for the top only, as %s', async (_k, v) => {
      for (const url of ['/api/v1/tenant/audit/chain', '/api/v1/tenant/audit/chain/verify']) {
        const r = await w.clients[v.key]!.get(url);
        expect(r.statusCode, `${v.key} ${url}`).toBe(v.chain ? 200 : 403);
      }
    });
  });
}

describe('permission matrix: named negatives', () => {
  let w: World;
  beforeAll(async () => { w = await build('multi'); }, 120000);
  afterAll(async () => { await w.app.close(); setStore(null); await rm(w.root, { recursive: true, force: true }); });

  it("HR A cannot fetch HR B's payslip via API, export, search or direct file URL", async () => {
    const hrA = w.clients.hrA!; const b = w.subjects.hrB!;
    expect((await hrA.get(`/api/v1/payroll/payslips/${b.itemId}?reveal=1`)).statusCode).toBe(404);
    const reg = await hrA.get(`/api/v1/payroll/runs/${w.runId}/register.csv`);
    expect(reg.statusCode).toBe(200);
    expect(reg.body.includes(b.code)).toBe(false);
    expect(reg.body.includes(b.figure)).toBe(false);
    expect((await hrA.get(`/api/v1/payroll/runs/${w.runId}/bank.csv`)).statusCode).toBe(403);
    expect((await hrA.get(`/api/v1/employees?search=${b.figure}`)).json().items).toEqual([]);
    expect((await hrA.get(`/api/v1/documents/${b.docId}/download`)).statusCode).toBe(404);
    expect((await hrA.get(`/api/v1/payroll/employees/${b.employeeId}/salaries?reveal=1`)).statusCode).toBe(404);
  });

  it('HR never sees an administrator or the owner, even with a level set too high', async () => {
    for (const target of ['it', 'super', 'owner']) {
      expect((await w.clients.hrCapped!.get(`/api/v1/payroll/employees/${w.subjects[target]!.employeeId}/salaries?reveal=1`)).statusCode, target).toBe(404);
    }
  });

  it('a senior payroll person sees HR and not a Super-admin', async () => {
    const c = w.clients.seniorPayroll!;
    expect((await c.get(`/api/v1/payroll/employees/${w.subjects.hrA!.employeeId}/salaries?reveal=1`)).statusCode).toBe(200);
    expect((await c.get(`/api/v1/payroll/employees/${w.subjects.super!.employeeId}/salaries?reveal=1`)).statusCode).toBe(404);
  });

  it('L2: the manager chain sees joining date and location of a report, and nothing personal', async () => {
    const s = w.subjects;
    await ownerQuery(`UPDATE employees SET reporting_manager_id=$1 WHERE id=$2`, [s.manager!.employeeId, s.peer!.employeeId]);
    const r = await w.clients.manager!.get(`/api/v1/employees/${s.peer!.employeeId}`);
    expect(r.json().view).toBe('team');
    expect(r.json().date_of_joining).toBeTruthy();
    expect(r.json().branch_name).toBeTruthy();
    expect(r.body.includes(s.peer!.phone)).toBe(false);
    // Upward it does not work, and a colleague sees only the directory.
    expect((await w.clients.peer!.get(`/api/v1/employees/${s.manager!.employeeId}`)).json().view).toBe('directory');
    const dir = (await w.clients.employee!.get(`/api/v1/employees/${s.peer!.employeeId}`)).json();
    expect(dir.view).toBe('directory');
    expect('branch_name' in dir).toBe(false);
    await ownerQuery(`UPDATE employees SET reporting_manager_id=NULL WHERE id=$1`, [s.peer!.employeeId]);
  });

  it('nobody changes someone above them through a write path', async () => {
    const c = w.clients.hrA!; const up = w.subjects.super!;
    expect((await c.put(`/api/v1/employees/${up.employeeId}/bank-account`, { accountHolder: 'Attacker', accountNumber: '123456789012', ifsc: 'HDFC0001234' })).statusCode).toBe(404);
    const pay = w.clients.payroll!;
    expect((await pay.post(`/api/v1/payroll/employees/${up.employeeId}/salaries`, { effectiveFrom: '2030-01-01', amounts: { BASIC: 1 }, reason: 'attack' })).statusCode).toBe(404);
    expect((await pay.put(`/api/v1/payroll/employees/${up.employeeId}/statutory`, { uan: '123456789012' })).statusCode).toBe(404);
  });

  it('salary levels: not your own, not at or above you, not someone at or above you, and each change audited', async () => {
    const it_ = w.clients.it!; const s = w.subjects;
    expect((await it_.put(`/api/v1/tenant/users/${s.it!.userId}/salary-level`, { level: 50 })).statusCode).toBe(403);
    expect((await it_.put(`/api/v1/tenant/users/${s.employee!.userId}/salary-level`, { level: 60 })).statusCode).toBe(403);
    expect((await it_.put(`/api/v1/tenant/users/${s.super!.userId}/salary-level`, { level: 5 })).statusCode).toBe(403);
    const ok = await it_.put(`/api/v1/tenant/users/${s.peer!.userId}/salary-level`, { level: 5 });
    expect(ok.statusCode, ok.body).toBe(200);
    const [row] = await ownerQuery<{ change_metadata: { from: number; to: number } }>(`SELECT change_metadata FROM audit_logs WHERE tenant_id=$1 AND action='user.salary_level_changed' AND target_id=$2`, [w.tenantId, s.peer!.userId]);
    expect(row!.change_metadata).toMatchObject({ from: 0, to: 5 });
    // A level change ends that person's sessions. The employee can no longer be read by a level-5 peer's level, and the peer has no L4 permission anyway.
    expect((await w.clients.peer!.get('/api/v1/auth/me')).statusCode).toBe(401);
    w.clients.peer = await Client.login(w.app, w.host, `peer@${w.host}`);
    expect((await w.clients.peer!.get(`/api/v1/payroll/employees/${s.employee!.employeeId}/salaries?reveal=1`)).statusCode).toBe(403);
    // A role whose floor is at or above you cannot be granted, nor can you raise your own.
    expect((await it_.patch(`/api/v1/tenant/users/${s.peer!.userId}`, { roles: ['owner', 'employee'] })).statusCode).toBe(403);
    expect((await w.clients.super!.patch(`/api/v1/tenant/users/${s.super!.userId}`, { roles: ['owner', 'tenant_admin', 'employee'] })).statusCode).toBe(403);
  });

  it('each reveal writes who, whose record, which fields, when, IP and device', async () => {
    const c = w.clients.seniorPayroll!; const s = w.subjects.employee!;
    const r = await c.req('GET', `/api/v1/payroll/employees/${s.employeeId}/salaries?reveal=1`, undefined, { 'user-agent': 'matrix-agent/1' });
    expect(r.statusCode).toBe(200);
    const rows = await ownerQuery<{ actor_id: string; target_id: string; change_metadata: { fields: string[] }; ip: string; user_agent: string; created_at: Date }>(
      `SELECT actor_id, target_id, change_metadata, ip, user_agent, created_at FROM audit_logs WHERE tenant_id=$1 AND action='l4.reveal' AND target_id=$2 AND user_agent='matrix-agent/1'`, [w.tenantId, s.employeeId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_id).toBe(w.subjects.seniorPayroll!.userId);
    expect(rows[0]!.change_metadata.fields).toEqual(['amounts', 'annual_ctc']);
    expect(rows[0]!.ip).toBeTruthy();
    // A masked read has no figures, so it is not an L4 read.
    const before = (await ownerQuery(`SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='l4.reveal'`, [w.tenantId])).length;
    await c.get(`/api/v1/payroll/employees/${s.employeeId}/salaries`);
    expect((await ownerQuery(`SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND action='l4.reveal'`, [w.tenantId])).length).toBe(before);
  });

  it('bulk reveal of a run is audited per subject', async () => {
    const c = w.clients.seniorPayroll!;
    const r = await c.req('GET', `/api/v1/payroll/runs/${w.runId}?reveal=1`, undefined, { 'user-agent': 'bulk-agent/1' });
    const rows = await ownerQuery<{ target_id: string }>(`SELECT target_id FROM audit_logs WHERE tenant_id=$1 AND action='l4.reveal' AND user_agent='bulk-agent/1'`, [w.tenantId]);
    expect(rows.map((x) => x.target_id).sort()).toEqual((r.json().items as { employee_id: string }[]).map((i) => i.employee_id).sort());
  });

  describe('every read of an aggregate says whose records went into it', () => {
    /** Exactly the people below seniorPayroll, plus themselves: the requirement is who, whose record, for every L4 read. */
    const expected = () => PEOPLE.multi.filter((p) => p.level < 85 || p.key === 'seniorPayroll').map((p) => w.subjects[p.key]!.employeeId).sort();
    const targets = async (agent: string, action: string) => (await ownerQuery<{ target_id: string; target_type: string }>(`SELECT target_id, target_type FROM audit_logs WHERE tenant_id=$1 AND action=$2 AND user_agent=$3`, [w.tenantId, action, agent]));
    const q = `from=${PERIOD}&to=${PERIOD}`;
    const cases: [string, string, string][] = [
      ['payroll cost reveal', `/api/v1/reports/payroll_cost?${q}&reveal=1`, 'l4.reveal'],
      ['payroll cost export', `/api/v1/reports/payroll_cost/export.csv?${q}`, 'l4.export'],
      ['department overview reveal', `/api/v1/reports/department_overview?from=${PERIOD}-01&to=${PERIOD}-28&reveal=1`, 'l4.reveal'],
      ['department overview export', `/api/v1/reports/department_overview/export.xlsx?from=${PERIOD}-01&to=${PERIOD}-28`, 'l4.export'],
    ];
    it.each(cases)('%s writes one row per subject', async (name, url, action) => {
      const agent = `agg-${name.replace(/ /g, '-')}`;
      const r = await w.clients.seniorPayroll!.req('GET', url, undefined, { 'user-agent': agent });
      expect(r.statusCode, r.body).toBe(200);
      const rows = await targets(agent, action);
      expect(rows.map((x) => x.target_id).sort()).toEqual(expected());
      expect(new Set(rows.map((x) => x.target_type))).toEqual(new Set(['employee']));
      expect(r.body.includes('"subjects"')).toBe(false);
    });

    it('run lists and accounting sources name each person once, across runs', async () => {
      for (const url of ['/api/v1/payroll/runs?reveal=1', '/api/v1/accounting/sources?reveal=1']) {
        const agent = `agg-${url.length}`;
        expect((await w.clients.seniorPayroll!.req('GET', url, undefined, { 'user-agent': agent })).statusCode).toBe(200);
        const rows = await targets(agent, 'l4.reveal');
        expect(rows.map((x) => x.target_id).sort(), url).toEqual(expected());
      }
    });

    it('a masked aggregate carries no figure and writes no row', async () => {
      const agent = 'agg-masked';
      await w.clients.seniorPayroll!.req('GET', `/api/v1/reports/payroll_cost?${q}`, undefined, { 'user-agent': agent });
      await w.clients.seniorPayroll!.req('GET', '/api/v1/payroll/runs', undefined, { 'user-agent': agent });
      expect(await targets(agent, 'l4.reveal')).toEqual([]);
    });

    it('a group withheld for being small names nobody: nothing of theirs was read', async () => {
      // A department holding one person below the auditor and one above: its amounts are withheld.
      const agent = 'agg-withheld';
      const s = w.subjects;
      const [dep] = await ownerQuery<{ id: string }>(`INSERT INTO departments (tenant_id, code, name) VALUES ($1,'TINY','Tiny') RETURNING id`, [w.tenantId]);
      await ownerQuery(`UPDATE employees SET department_id=$1 WHERE id = ANY($2)`, [dep!.id, [s.employee!.employeeId, s.owner!.employeeId]]);
      try {
        const r = await w.clients.auditor!.req('GET', `/api/v1/reports/payroll_cost?${q}&groupBy=department&reveal=1`, undefined, { 'user-agent': agent });
        expect(r.statusCode, r.body).toBe(200);
        expect(r.body.includes(s.employee!.figure)).toBe(false);
        const rows = (await targets(agent, 'l4.reveal')).map((x) => x.target_id);
        expect(rows).not.toContain(s.employee!.employeeId);
        expect(rows).toContain(s.auditor!.employeeId);
      } finally { await ownerQuery(`UPDATE employees SET department_id=NULL WHERE tenant_id=$1`, [w.tenantId]); }
    });

    it('the journal names each person, and a refused one writes no read', async () => {
      const agent = 'agg-journal';
      expect((await w.clients.seniorPayroll!.req('GET', `/api/v1/accounting/payroll-runs/${w.runId}/journal`, undefined, { 'user-agent': agent })).statusCode).toBe(403);
      expect(await targets(agent, 'l4.read')).toEqual([]);
      // Someone above the whole run with the accounting permission: the owner of a single-person organization.
      const single = await build('single');
      try {
        const r = await single.clients.owner!.req('GET', `/api/v1/accounting/payroll-runs/${single.runId}/journal`, undefined, { 'user-agent': agent });
        expect(r.statusCode, r.body).toBe(200);
        const rows = await ownerQuery<{ target_id: string }>(`SELECT target_id FROM audit_logs WHERE tenant_id=$1 AND action='l4.read' AND user_agent=$2`, [single.tenantId, agent]);
        expect(rows.map((x) => x.target_id).sort()).toEqual(Object.values(single.subjects).map((x) => x.employeeId).sort());
      } finally { await single.app.close(); setStore(new LocalStore(w.root)); await rm(single.root, { recursive: true, force: true }); }
    }, 60000);

    it('opening or exporting a scheduled copy names the people in it', async () => {
      const s = w.subjects;
      const [saved] = await ownerQuery<{ id: string }>(`INSERT INTO saved_reports (tenant_id, owner_id, report_key, name, params) VALUES ($1,$2,'payroll_cost','Cost audit',$3) RETURNING id`, [w.tenantId, s.seniorPayroll!.userId, JSON.stringify({ from: PERIOD, to: PERIOD })]);
      await ownerQuery(`INSERT INTO report_schedules (tenant_id, saved_report_id, frequency, recipient_ids, next_run_on, created_by) VALUES ($1,$2,'daily',$3,'2020-01-01',$4)`, [w.tenantId, saved!.id, [s.seniorPayroll!.userId], s.seniorPayroll!.userId]);
      const { withTenant } = await import('../src/db/tx.js');
      await inApp(w.app, () => withTenant(w.app.deps.pool, w.tenantId, (db) => runSchedules(db, w.tenantId, '2026-03-01')));
      const [snap] = await ownerQuery<{ id: string }>(`SELECT id FROM report_snapshots WHERE tenant_id=$1 AND name='Cost audit'`, [w.tenantId]);
      const c = w.clients.seniorPayroll!;
      await c.req('GET', `/api/v1/reports/snapshots/${snap!.id}`, undefined, { 'user-agent': 'snap-read' });
      expect((await targets('snap-read', 'l4.read')).map((x) => x.target_id).sort()).toEqual(expected());
      await c.req('GET', `/api/v1/reports/snapshots/${snap!.id}/export.csv`, undefined, { 'user-agent': 'snap-export' });
      expect((await targets('snap-export', 'l4.export')).map((x) => x.target_id).sort()).toEqual(expected());
    });
  });

  it('the reimbursement bank file is whole or refused too', async () => {
    const s = w.subjects;
    const [batch] = await ownerQuery<{ id: string }>(`INSERT INTO reimbursement_batches (tenant_id, status, total, claim_count, prepared_by, approved_by, approved_at) VALUES ($1,'approved',10,1,$2,$3,now()) RETURNING id`, [w.tenantId, s.finance!.userId, s.seniorPayroll!.userId]);
    await ownerQuery(`INSERT INTO expense_claims (tenant_id, employee_id, title, purpose, status, total, created_by, approved_at, batch_id) VALUES ($1,$2,'Trip claim','Purpose here','approved',10,$3,now(),$4)`, [w.tenantId, s.super!.employeeId, s.super!.userId, batch!.id]);
    const low = await w.clients.finance!.get(`/api/v1/expenses/batches/${batch!.id}/export.csv`);
    expect(low.statusCode, low.body).toBe(403);
    expect(problem(low).code).toBe('requires_higher_level');
    expect(low.body.includes(s.super!.account)).toBe(false);
  });

  it('a scheduled report is stored at the level of each recipient, with no rows beyond it', async () => {
    const s = w.subjects;
    const [saved] = await ownerQuery<{ id: string }>(`INSERT INTO saved_reports (tenant_id, owner_id, report_key, name, params) VALUES ($1,$2,'payroll_cost','Cost',$3) RETURNING id`, [w.tenantId, s.seniorPayroll!.userId, JSON.stringify({ from: PERIOD, to: PERIOD })]);
    await ownerQuery(`INSERT INTO report_schedules (tenant_id, saved_report_id, frequency, recipient_ids, next_run_on, created_by) VALUES ($1,$2,'daily',$3,'2020-01-01',$4)`, [w.tenantId, saved!.id, [s.payroll!.userId], s.seniorPayroll!.userId]);
    const { withTenant } = await import('../src/db/tx.js');
    await inApp(w.app, () => withTenant(w.app.deps.pool, w.tenantId, (db) => runSchedules(db, w.tenantId, '2026-02-01')));
    const list = await w.clients.payroll!.get('/api/v1/reports/snapshots');
    const snap = (list.json().items as { id: string }[])[0]!;
    const body = await w.clients.payroll!.get(`/api/v1/reports/snapshots/${snap.id}`);
    expect(body.statusCode, body.body).toBe(200);
    const mine = PEOPLE.multi.filter((p) => p.level < 40 || p.key === 'payroll');
    expect(Number(body.json().totals.gross)).toBe(mine.reduce((t, p) => t + s[p.key]!.gross, 0));
    const stored = await ownerQuery<{ id: string; recipient_ids: string[]; viewer_level: number; data_enc: string }>(`SELECT id, recipient_ids, viewer_level, data_enc FROM report_snapshots WHERE tenant_id=$1 AND name='Cost'`, [w.tenantId]);
    expect(stored).toHaveLength(2);
    for (const x of stored) { expect(x.recipient_ids).toHaveLength(1); expect(x.data_enc.startsWith('v2.')).toBe(true); }
    // The higher copy is not the lower reader's to open.
    const other = stored.find((x) => x.viewer_level === 85)!;
    expect(other.recipient_ids[0]).toBe(s.seniorPayroll!.userId);
    // Exports of a snapshot: the reader's own copy at their level, nobody else's, and not after their level has dropped.
    const sum = String(mine.reduce((t, p) => t + s[p.key]!.gross, 0));
    for (const format of ['csv', 'xlsx']) {
      const own = await w.clients.payroll!.get(`/api/v1/reports/snapshots/${snap.id}/export.${format}`);
      expect(own.statusCode, own.body).toBe(200);
      if (format === 'csv') { expect(own.body.includes(sum)).toBe(true); for (const p of PEOPLE.multi.filter((x) => x.level >= 40 && x.key !== 'payroll')) expect(leaks(own.body, s[p.key]!)).toBe(false); }
      expect((await w.clients.payroll!.get(`/api/v1/reports/snapshots/${other.id}/export.${format}`)).statusCode).toBe(404);
      expect((await w.clients.super!.get(`/api/v1/reports/snapshots/${snap.id}/export.${format}`)).statusCode).toBe(404);
      expect((await w.clients.employee!.get(`/api/v1/reports/snapshots/${other.id}/export.${format}`)).statusCode).toBe(404);
      expect((await w.clients.seniorPayroll!.get(`/api/v1/reports/snapshots/${other.id}/export.${format}`)).statusCode).toBe(200);
    }
    await ownerQuery(`UPDATE users SET salary_access_level=0 WHERE id=$1`, [s.seniorPayroll!.userId]);
    const dropped = await Client.login(w.app, w.host, `seniorpayroll@${w.host}`);
    expect((await dropped.get(`/api/v1/reports/snapshots/${other.id}/export.csv`)).statusCode).toBe(404);
    await ownerQuery(`UPDATE users SET salary_access_level=85 WHERE id=$1`, [s.seniorPayroll!.userId]);
  });
});

describe('permission matrix: flags and settings', () => {
  it('payroll off: pay routes do not exist, nothing breaks, and an employee record still reads', async () => {
    const w = await build('multi', flags('default'));
    try {
      expect((await w.clients.owner!.get(`/api/v1/payroll/runs`)).statusCode).toBe(404);
      expect((await w.clients.owner!.get(`/api/v1/payroll/employees/${w.subjects.employee!.employeeId}/salaries?reveal=1`)).statusCode).toBe(404);
      expect((await w.clients.owner!.get(`/api/v1/reports/payroll_cost?reveal=1`)).statusCode).toBe(404);
      expect((await w.clients.owner!.get(`/api/v1/loans/requests?reveal=1`)).statusCode).toBe(404);
      for (const format of ['csv', 'xlsx']) expect((await w.clients.owner!.get(`/api/v1/reports/snapshots/${w.runId}/export.${format}`)).statusCode, format).toBe(404);
      expect((await w.clients.owner!.get(`/api/v1/employees/${w.subjects.employee!.employeeId}`)).statusCode).toBe(200);
      const b = await w.clients.super!.get(`/api/v1/employees/${w.subjects.employee!.employeeId}/bank-account?reveal=1`);
      expect(b.statusCode, b.body).toBe(200);
      const settings = await w.clients.super!.get('/api/v1/tenant/settings');
      expect(settings.body.includes('security.manager_team_salaries')).toBe(false);
      expect(settings.body.includes('security.aadhaar_collection')).toBe(false);
    } finally { await w.app.close(); setStore(null); await rm(w.root, { recursive: true, force: true }); }
  }, 120000);

  it('managers: no team salaries by default; on with the setting, capped below their level', async () => {
    const w = await build('multi');
    try {
      const s = w.subjects;
      await ownerQuery(`UPDATE employees SET reporting_manager_id=$1 WHERE id = ANY($2)`, [s.manager!.employeeId, [s.employee!.employeeId, s.hrExec!.employeeId]]);
      const url = (id: string) => `/api/v1/payroll/employees/${id}/salaries?reveal=1`;
      expect((await w.clients.manager!.get(url(s.employee!.employeeId))).statusCode).toBe(403);
      const on = await w.clients.super!.put('/api/v1/tenant/settings/security.manager_team_salaries', { value: true });
      expect(on.statusCode, on.body).toBe(200);
      expect((await w.clients.manager!.get(url(s.employee!.employeeId))).statusCode).toBe(200);
      // A report above the manager's own level stays out of reach.
      expect((await w.clients.manager!.get(url(s.hrExec!.employeeId))).statusCode).toBe(404);
      expect((await w.clients.manager!.get(url(s.peer!.employeeId))).statusCode).toBe(403);
    } finally { await w.app.close(); setStore(null); await rm(w.root, { recursive: true, force: true }); }
  }, 120000);

  it('Aadhaar is refused until the setting is on, encrypted, and never comes back whole', async () => {
    const w = await build('multi');
    try {
      const s = w.subjects.employee!; const pay = w.clients.seniorPayroll!;
      const body = { aadhaar: '234567890123' };
      expect((await pay.put(`/api/v1/payroll/employees/${s.employeeId}/statutory`, body)).statusCode).toBe(409);
      expect((await w.clients.super!.put('/api/v1/tenant/settings/security.aadhaar_collection', { value: true })).statusCode).toBe(200);
      expect((await pay.put(`/api/v1/payroll/employees/${s.employeeId}/statutory`, body)).statusCode).toBe(200);
      const [row] = await ownerQuery<{ aadhaar_enc: string; aadhaar_last4: string }>(`SELECT aadhaar_enc, aadhaar_last4 FROM employee_statutory WHERE employee_id=$1`, [s.employeeId]);
      expect(row!.aadhaar_enc.includes('234567890123')).toBe(false);
      expect(testCipher.decrypt(row!.aadhaar_enc)).toBe('234567890123');
      expect(row!.aadhaar_last4).toBe('0123');
      const masked = await pay.get(`/api/v1/payroll/employees/${s.employeeId}/statutory`);
      expect(masked.json().aadhaar).toBeNull();
      expect(masked.json().maskedFields).toContain('aadhaar');
      const revealed = await pay.get(`/api/v1/payroll/employees/${s.employeeId}/statutory?reveal=1`);
      expect(revealed.json().aadhaar).toBe('XXXXXXXX0123');
      expect(revealed.body.includes('234567890123')).toBe(false);
    } finally { await w.app.close(); setStore(null); await rm(w.root, { recursive: true, force: true }); }
  }, 120000);
});
