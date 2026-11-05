import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Client, createTenant, flags, inApp, makeApp, ownerQuery, problem, seal, testCipher, unseal, type TenantFixture } from './helpers.js';
import { TINY_PNG } from './images.js';
import { CLASSIFICATION } from '../src/core/policy/classification.js';
import { EXEMPT_TABLES, PERSON_COLUMNS, PERSONAL_TABLES } from '../src/modules/data-rights/map.js';
import { retentionEnd } from '../src/modules/data-rights/service.js';
import { JOB_MAP, jobActive } from '../src/core/jobs/registry.js';
import { runQueued, tick } from '../src/core/jobs/scheduler.js';
import { isExportRoute } from '../src/core/http/limits.js';
import { getStore, LocalStore, newKey, setStore } from '../src/core/storage/index.js';

const FLAGS = 'default,payroll,payroll.payslips,payroll.statutory,loans,expenses,recruitment,core.offboarding,grievance,posh,performance';
const quiet = { info: () => undefined, error: () => undefined };
const today = new Date().toISOString().slice(0, 10);
const PHONE = '+91 90000 12345';
const ACCOUNT = '112233445566';
const PAN = 'ABCPE1234F';
const AADHAAR = '123412341234';

let app: FastifyInstance;
let root: string;

/** A person with something in every kind of place, exited on `exit`. */
async function person(T: TenantFixture, key: 'employee' | 'other', exit: string | null = '2026-01-31', opts: { document?: boolean } = {}) {
  const u = T.users[key]!;
  const id = u.employeeId!;
  await ownerQuery(
    `UPDATE employees SET date_of_joining='2015-01-01', phone=$2, date_of_birth='1990-05-05', work_email=$3, designation='Chemist', grade='L2', status=$4, exit_date=$5 WHERE id=$1`,
    [id, PHONE, `${key}.person@${T.host}`, exit ? 'exited' : 'active', exit],
  );
  await ownerQuery(`INSERT INTO employee_addresses (tenant_id, employee_id, kind, line1, city, state, postal_code) VALUES ($1,$2,'current','Flat Secret 9','Pune','MH','411001')`, [
    T.id,
    id,
  ]);
  await ownerQuery(
    `INSERT INTO employee_emergency_contacts (tenant_id, employee_id, position, name, relationship, phone) VALUES ($1,$2,1,'Kin Secretname','Spouse','+91 90000 99999')`,
    [T.id, id],
  );
  await ownerQuery(`INSERT INTO employee_nominees (tenant_id, employee_id, purpose, name, relationship, share_percent) VALUES ($1,$2,'pf','Nominee Secretname','Spouse',100)`, [
    T.id,
    id,
  ]);
  await ownerQuery(
    `INSERT INTO employee_statutory (tenant_id, employee_id, uan, pan_enc, pan_last4, aadhaar_enc, aadhaar_last4) VALUES ($1,$2,'100200300400',$3,'234F',$4,'1234')`,
    [T.id, id, testCipher.encrypt(PAN), testCipher.encrypt(AADHAAR)],
  );
  await ownerQuery(
    `INSERT INTO employee_bank_accounts (employee_id, tenant_id, account_holder, account_number_enc, account_last4, ifsc, updated_by) VALUES ($1,$2,'Holder',$3,'5566','ZZZZ0000001',$4)`,
    [id, T.id, testCipher.encrypt(ACCOUNT), u.id],
  );
  await ownerQuery(
    `INSERT INTO employee_salaries (tenant_id, employee_id, effective_from, amounts_enc, reason, status, created_by, approved_at) VALUES ($1,$2,'2025-04-01',$3,'x','active',$4,now())`,
    [T.id, id, seal({ BASIC: 987654 }), u.id],
  );
  const [run] = await ownerQuery<{ id: string }>(`INSERT INTO payroll_runs (tenant_id, legal_entity_id, period, status, created_by) VALUES ($1,$2,$3,'draft',$4) RETURNING id`, [
    T.id,
    T.legalEntityId,
    `2026-0${key === 'employee' ? 1 : 2}`,
    u.id,
  ]);
  await ownerQuery(
    `INSERT INTO payroll_items (tenant_id, run_id, employee_id, days_in_period, employed_days, lop_days, paid_days, calc_version, data_enc) VALUES ($1,$2,$3,31,31,0,31,1,$4)`,
    [T.id, run!.id, id, seal({ net: 876543, gross: 900000, deductions: 0, lines: [], warnings: [] })],
  );
  await ownerQuery(`UPDATE payroll_runs SET status='paid' WHERE id=$1`, [run!.id]);
  await ownerQuery(`INSERT INTO notifications (tenant_id, user_id, kind, title, body) VALUES ($1,$2,'x','Secret notification','b')`, [T.id, u.id]);
  await ownerQuery(`INSERT INTO email_outbox (tenant_id, to_user_id, to_email, subject, text_body, html_body, kind) VALUES ($1,$2,$3,'Subject','Body','<p>x</p>','x')`, [
    T.id,
    u.id,
    u.email,
  ]);
  await ownerQuery(
    `INSERT INTO attendance_events (tenant_id, employee_id, source, source_ref, event_time, direction, latitude, longitude) VALUES ($1,$2,'web',$3,'2026-01-05T04:00:00Z','in',18.5,73.8)`,
    [T.id, id, `r-${id}`],
  );
  await ownerQuery(`INSERT INTO cases (tenant_id, kind, number, category, complainant_id, description_enc, status) VALUES ($1,'grievance',$2,'other',$3,$4,'open')`, [
    T.id,
    key === 'employee' ? 1 : 2,
    id,
    testCipher.encrypt('Secret complaint text'),
  ]);
  await ownerQuery(`UPDATE cases SET status='closed', closed_at='2026-01-20T00:00:00Z' WHERE tenant_id=$1 AND complainant_id=$2`, [T.id, id]);
  if (opts.document !== false) {
    const [cat] = await ownerQuery<{ id: string }>(
      `INSERT INTO document_categories (tenant_id, code, name, scope, employee_visible) VALUES ($1,$2,'Identity','employee',true) ON CONFLICT (tenant_id, code) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
      [T.id, 'IDP'],
    );
    const [pay] = await ownerQuery<{ id: string }>(
      `INSERT INTO document_categories (tenant_id, code, name, scope, employee_visible, payroll_related) VALUES ($1,$2,'Tax','employee',true,true) ON CONFLICT (tenant_id, code) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
      [T.id, 'TAX'],
    );
    const keys: Record<string, string> = {};
    for (const [name, c] of [
      ['identity', cat!.id],
      ['tax', pay!.id],
    ] as const) {
      const k = newKey(T.id, id);
      await getStore()!.put(k, Buffer.from('file'), 'application/pdf');
      await ownerQuery(
        `INSERT INTO documents (tenant_id, category_id, employee_id, title, file_name, content_type, size_bytes, sha256, storage_key, uploaded_by) VALUES ($1,$2,$3,$4,$5,'application/pdf',4,repeat('a',64),$6,$7)`,
        [T.id, c, id, `${name} Secretdoc`, `${name}.pdf`, k, u.id],
      );
      keys[name] = k;
    }
    return { id, keys };
  }
  return { id, keys: {} as Record<string, string> };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hrms-rights-'));
  setStore(new LocalStore(root));
  app = await makeApp({ ...flags(FLAGS), RATE_LIMIT_PER_MINUTE: '100000' }, { storeOverride: true });
});
afterAll(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

describe('the map of personal data', () => {
  it("every table with a person's id in it is mapped or exempt, with a reason", () => {
    const mapped = new Set(PERSONAL_TABLES.map((t) => t.table));
    const missing = Object.entries(CLASSIFICATION)
      .filter(([table, cols]) => PERSON_COLUMNS.some((c) => c in cols) && !mapped.has(table) && !EXEMPT_TABLES[table])
      .map(([t]) => t);
    expect(missing).toEqual([]);
  });

  it('every column it scrubs exists and the runtime role may change it', async () => {
    for (const t of PERSONAL_TABLES)
      for (const c of t.scrub ?? []) {
        const [r] = await ownerQuery<{ ok: boolean }>(`SELECT has_column_privilege('hrms_app', $1, $2, 'UPDATE') AS ok`, [t.table, c]);
        expect(r!.ok, `${t.table}.${c}`).toBe(true);
      }
    for (const t of PERSONAL_TABLES.filter((x) => x.erase === 'delete')) {
      const [r] = await ownerQuery<{ ok: boolean }>(`SELECT has_table_privilege('hrms_app', $1, 'DELETE') AS ok`, [t.table]);
      expect(r!.ok, t.table).toBe(true);
    }
  });

  it('a retention end is the end of a financial year', () => {
    expect(retentionEnd('2026-01-31', 8)).toBe('2034-03-31');
    expect(retentionEnd('2026-04-01', 8)).toBe('2035-03-31');
  });

  it('the export route counts as an export for the rate limit', () => {
    expect(isExportRoute('GET', '/api/v1/tenant/data-rights/employees/:id/export')).toBe(true);
  });
});

describe('export', () => {
  let T: TenantFixture;
  let id: string;
  beforeAll(async () => {
    T = await createTenant();
    ({ id } = await person(T, 'employee', null, { document: true }));
  });
  const url = (x: string, q = '') => `/api/v1/tenant/data-rights/employees/${x}/export${q}`;
  const section = (b: { sections: { key: string }[] }, k: string) =>
    b.sections.find((s) => s.key === k) as unknown as { rows: Record<string, unknown>[]; total: number; maskedColumns?: string[]; withheld?: boolean; nextOffset: number | null };

  it('the person gets all of it, sealed values opened, secrets never, audited', async () => {
    const c = await Client.login(app, T.host, T.users.employee!.email);
    const r = await c.get(url(id));
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.complete).toBe(true);
    expect(section(b, 'profile').rows[0]).toMatchObject({ phone: PHONE, date_of_birth: '1990-05-05' });
    expect(section(b, 'addresses').rows[0]).toMatchObject({ line1: 'Flat Secret 9' });
    expect(section(b, 'salaries').rows[0]!.amounts).toEqual({ BASIC: 987654 });
    expect(section(b, 'payslips').rows[0]!.data).toMatchObject({ net: 876543 });
    expect(section(b, 'cases_raised').rows[0]!.description).toBe('Secret complaint text');
    expect(section(b, 'statutory').rows[0]).toMatchObject({ pan_last4: '234F', aadhaar_last4: '1234', uan: '100200300400' });
    expect(section(b, 'documents').rows.map((d) => d.file_name)).toEqual(expect.arrayContaining(['identity.pdf', 'tax.pdf']));
    for (const s of [PAN, AADHAAR, ACCOUNT, 'password_hash', 'token_hash', 'storage_key', 'mfa_secret', 'v2.']) expect(r.body, s).not.toContain(s);
    const logs = await ownerQuery<{ action: string; change_metadata: { fields?: string[]; self?: boolean } }>(
      `SELECT action, change_metadata FROM audit_logs WHERE tenant_id=$1 AND target_id=$2 AND action IN ('data_rights.exported','l4.export')`,
      [T.id, id],
    );
    expect(logs.find((l) => l.action === 'data_rights.exported')!.change_metadata.self).toBe(true);
    expect(logs.find((l) => l.action === 'l4.export')!.change_metadata.fields).toEqual(expect.arrayContaining(['employee_salaries.amounts', 'payroll_items.data']));
  });

  it('includes what a module that is off still holds', async () => {
    const off = await makeApp({ ...flags('attendance,attendance.web,shifts,holidays,attendance.regularization') }, { storeOverride: true });
    const c = await Client.login(off, T.host, T.users.employee!.email);
    const b = (await c.get(url(id))).json();
    expect(section(b, 'salaries').rows).toHaveLength(1);
    expect(section(b, 'cases_raised').rows).toHaveLength(1);
    await off.close();
  });

  it('nobody else without standing: a peer or a manager gets 404', async () => {
    const peer = await Client.login(app, T.host, T.users.other!.email);
    expect((await peer.get(url(id))).statusCode).toBe(404);
    const mgr = await Client.login(app, T.host, T.users.manager!.email);
    expect((await mgr.get(url(id))).statusCode).toBe(404);
    const payroll = await Client.login(app, T.host, T.users.payroll!.email);
    expect((await payroll.get(url(id))).statusCode).toBe(404); // L4 reader but not HR: the whole person is not theirs
  });

  it('HR above them gets it; cases raised stay with the person, with no count', async () => {
    const hr = await Client.login(app, T.host, T.users.hr!.email);
    const r = await hr.get(url(id));
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(section(b, 'salaries').rows[0]!.amounts).toEqual({ BASIC: 987654 });
    expect(section(b, 'cases_raised')).toMatchObject({ rows: [], total: 0, withheld: true });
    expect(r.body).not.toContain('Secret complaint text');
    expect((await ownerQuery(`SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND target_id=$2 AND action='l4.export' AND actor_id=$3`, [T.id, id, T.users.hr!.id])).length).toBe(1);
  });

  it('HR without an L4 permission gets L3 and no L4', async () => {
    await ownerQuery(`UPDATE user_roles SET role_key='hr_executive' WHERE tenant_id=$1 AND user_id=$2 AND role_key='hr_admin'`, [T.id, T.users.hr!.id]);
    const hr = await Client.login(app, T.host, T.users.hr!.email);
    const r = await hr.get(url(id));
    const b = r.json();
    expect(b.l4Included).toBe(false);
    expect(section(b, 'addresses').rows).toHaveLength(1);
    expect(section(b, 'salaries').rows[0]!.amounts).toBeUndefined();
    expect(section(b, 'salaries').maskedColumns).toEqual(expect.arrayContaining(['amounts_enc']));
    for (const s of ['987654', '876543', '234F', '5566']) expect(r.body, s).not.toContain(s);
    await ownerQuery(`UPDATE user_roles SET role_key='hr_admin' WHERE tenant_id=$1 AND user_id=$2 AND role_key='hr_executive'`, [T.id, T.users.hr!.id]);
  });

  it('pages a large section', async () => {
    for (let i = 0; i < 7; i++)
      await ownerQuery(`INSERT INTO attendance_events (tenant_id, employee_id, source, source_ref, event_time, direction) VALUES ($1,$2,'web',$3,$4,'in')`, [
        T.id,
        id,
        `p-${i}`,
        `2026-02-0${i + 1}T04:00:00Z`,
      ]);
    const c = await Client.login(app, T.host, T.users.employee!.email);
    const first = (await c.get(url(id, '?limit=3'))).json();
    expect(first.complete).toBe(false);
    expect(section(first, 'attendance_punches')).toMatchObject({ total: 8, nextOffset: 3 });
    const seen = new Set<unknown>();
    let offset: number | null = 0;
    while (offset !== null) {
      const page: { sections: { rows: { id: string }[]; nextOffset: number | null }[] } = (await c.get(url(id, `?section=attendance_punches&limit=3&offset=${offset}`))).json();
      expect(page.sections).toHaveLength(1);
      for (const row of page.sections[0]!.rows) seen.add(row.id);
      offset = page.sections[0]!.nextOffset;
    }
    expect(seen.size).toBe(8);
    expect((await c.get(url(id, '?section=nothing'))).statusCode).toBe(400);
  });
});

describe('erasure', () => {
  const base = '/api/v1/tenant/data-rights/erasure-requests';

  it('an active employee is refused, with the reason, and nothing changes', async () => {
    const T = await createTenant();
    const { id } = await person(T, 'employee', null, { document: false });
    const hr = await Client.login(app, T.host, T.users.hr!.email);
    const r = await hr.post(base, { subjectType: 'employee', subjectId: id });
    expect(r.statusCode).toBe(409);
    expect(problem(r)).toMatchObject({ code: 'erasure_refused', detail: expect.stringMatching(/still employed/) });
    const self = await Client.login(app, T.host, T.users.employee!.email);
    expect((await self.post(base, { subjectType: 'employee', subjectId: id })).statusCode).toBe(409);
    expect((await ownerQuery(`SELECT phone FROM employees WHERE id=$1`, [id]))[0]).toEqual({ phone: PHONE });
  });

  it('a person who became active after the request cannot be erased', async () => {
    const T = await createTenant();
    const { id } = await person(T, 'employee', '2026-01-31', { document: false });
    const hr = await Client.login(app, T.host, T.users.hr!.email);
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    const req = (await hr.post(base, { subjectType: 'employee', subjectId: id })).json();
    await ownerQuery(`UPDATE employees SET status='active', exit_date=NULL WHERE id=$1`, [id]);
    const r = await admin.post(`${base}/${req.id}/execute`, {});
    expect(r.statusCode).toBe(409);
    expect(problem(r).code).toBe('erasure_refused');
  });

  describe('carrying one out', () => {
    let T: TenantFixture;
    let id: string;
    let keys: Record<string, string>;
    let reqId: string;
    let report: {
      erased: Record<string, number>;
      retained: { category: string; until: string; rows: number; tables: string[]; basis: string }[];
      filesDeleted: number;
      filesPending: number;
      auditLog: string;
      notLegalAdvice: string;
    };
    let hr: Client;
    let admin: Client;
    beforeAll(async () => {
      T = await createTenant();
      ({ id, keys } = await person(T, 'employee', '2026-01-31'));
      hr = await Client.login(app, T.host, T.users.hr!.email);
      admin = await Client.login(app, T.host, T.users.admin!.email);
    });

    it('needs the permission to raise and to carry out', async () => {
      const peer = await Client.login(app, T.host, T.users.other!.email);
      expect((await peer.post(base, { subjectType: 'employee', subjectId: id })).statusCode).toBe(403);
      expect((await peer.get(base)).statusCode).toBe(403);
    });

    it('raising twice is one request', async () => {
      const a = await hr.post(base, { subjectType: 'employee', subjectId: id, reason: 'They asked in writing' });
      expect(a.statusCode).toBe(201);
      const b = await hr.post(base, { subjectType: 'employee', subjectId: id });
      expect(b.statusCode).toBe(200);
      expect(b.json().id).toBe(a.json().id);
      reqId = a.json().id;
    });

    it('whoever raised it cannot carry it out in multi; HR cannot at all', async () => {
      expect((await hr.post(`${base}/${reqId}/execute`, {})).statusCode).toBe(403);
      const own = await admin.post(base, { subjectType: 'employee', subjectId: T.users.other!.employeeId! }).catch(() => null);
      expect(own?.statusCode).toBe(409); // still active
      await ownerQuery(`UPDATE erasure_requests SET requested_by=$2 WHERE id=$1`, [reqId, T.users.admin!.id]);
      expect((await admin.post(`${base}/${reqId}/execute`, {})).statusCode).toBe(403);
      await ownerQuery(`UPDATE erasure_requests SET requested_by=$2 WHERE id=$1`, [reqId, T.users.hr!.id]);
    });

    it('anonymizes personal fields, deletes files, and reports what stays and until when', async () => {
      const r = await admin.post(`${base}/${reqId}/execute`, { note: 'Checked' });
      expect(r.statusCode).toBe(200);
      const b = r.json();
      report = b.report;
      expect(b.status).toBe('retained');
      expect(b.alreadyDone).toBe(false);
      const [e] = await ownerQuery<Record<string, unknown>>(
        `SELECT first_name, last_name, work_email, phone, date_of_birth, designation, grade, erased_at, employee_code FROM employees WHERE id=$1`,
        [id],
      );
      expect(e).toMatchObject({ first_name: 'Erased', last_name: null, work_email: null, phone: null, date_of_birth: null, designation: null, grade: null, employee_code: 'E2' });
      expect(e!.erased_at).not.toBeNull();
      const [u] = await ownerQuery<Record<string, unknown>>(`SELECT email, display_name, password_hash, status FROM users WHERE id=$1`, [T.users.employee!.id]);
      expect(u).toMatchObject({ display_name: 'Erased person', password_hash: null, status: 'disabled', email: `erased-${T.users.employee!.id}@erased.invalid` });
      for (const t of ['employee_addresses', 'employee_emergency_contacts', 'employee_nominees'])
        expect((await ownerQuery(`SELECT 1 FROM ${t} WHERE employee_id=$1`, [id])).length, t).toBe(0);
      for (const t of ['notifications', 'sessions', 'user_roles']) expect((await ownerQuery(`SELECT 1 FROM ${t} WHERE user_id=$1`, [T.users.employee!.id])).length, t).toBe(0);
      expect((await ownerQuery(`SELECT 1 FROM email_outbox WHERE to_user_id=$1`, [T.users.employee!.id])).length).toBe(0);
      expect((await ownerQuery<{ latitude: string | null }>(`SELECT latitude FROM attendance_events WHERE employee_id=$1`, [id]))[0]!.latitude).toBeNull();
      // Files: identity gone, the payroll document stays until its date.
      await expect(getStore()!.get(keys.identity!)).rejects.toThrow();
      expect((await getStore()!.get(keys.tax!)).toString()).toBe('file');
      expect((await ownerQuery<{ file_name: string }>(`SELECT file_name FROM documents WHERE employee_id=$1`, [id])).map((d) => d.file_name)).toEqual(['tax.pdf']);
      expect(report.filesDeleted).toBe(1);
      expect(report.filesPending).toBe(0);
    });

    it('carve-outs: payroll, tax identity and vouchers kept with their dates; Aadhaar is not', async () => {
      const by = Object.fromEntries(report.retained.map((c) => [c.category, c]));
      expect(by.payroll!.until).toBe('2034-03-31');
      expect(by.attendance!.until).toBe('2031-03-31');
      expect(by.claims!.until).toBe('2029-03-31');
      expect(by.payroll!.tables).toEqual(expect.arrayContaining(['payroll_items', 'employee_salaries', 'employee_statutory', 'employee_bank_accounts', 'documents']));
      expect(by.payroll!.basis).toMatch(/Companies Act/);
      expect(report.notLegalAdvice).toMatch(/not legal advice/);
      const [s] = await ownerQuery<Record<string, unknown>>(`SELECT pan_enc, uan, aadhaar_enc, aadhaar_last4 FROM employee_statutory WHERE employee_id=$1`, [id]);
      expect(s!.pan_enc).not.toBeNull();
      expect(s).toMatchObject({ uan: '100200300400', aadhaar_enc: null, aadhaar_last4: null });
      expect((await ownerQuery(`SELECT 1 FROM payroll_items WHERE employee_id=$1`, [id])).length).toBe(1);
      const [v] = await ownerQuery<{ retained_identity_enc: string; retained_until: string; reason: string | null }>(
        `SELECT retained_identity_enc, retained_until::text, reason FROM erasure_requests WHERE id=$1`,
        [reqId],
      );
      expect(unseal<{ firstName: string; employeeCode: string }>(v!.retained_identity_enc)).toMatchObject({ firstName: 'Emp', employeeCode: 'E2' });
      expect(v).toMatchObject({ retained_until: '2034-03-31', reason: null });
    });

    it('running it again changes nothing and answers the same', async () => {
      const before = await ownerQuery(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id=$1 AND action='data_rights.erasure_executed'`, [T.id]);
      const r = await admin.post(`${base}/${reqId}/execute`, {});
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ alreadyDone: true, status: 'retained' });
      expect(r.json().report.retained).toEqual(report.retained);
      expect(await ownerQuery(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id=$1 AND action='data_rights.erasure_executed'`, [T.id])).toEqual(before);
    });

    it('the audit log is left as it was, chained, and holds no L3 or L4 value; it does hold L1 changes, which the report says', async () => {
      const logs = await ownerQuery<{ action: string; m: string }>(`SELECT action, change_metadata::text AS m FROM audit_logs WHERE tenant_id=$1`, [T.id]);
      for (const s of [PHONE, PAN, AADHAAR, ACCOUNT, 'Flat Secret 9', 'Kin Secretname', 'Secret complaint text', '987654'])
        expect(
          logs.some((l) => l.m.includes(s)),
          s,
        ).toBe(false);
      expect(logs.some((l) => l.action === 'data_rights.erasure_executed')).toBe(true);
      expect(report.auditLog).toMatch(/never rewritten/);
      expect(report.auditLog).toMatch(/L1 and L2/);
      expect((await admin.get('/api/v1/tenant/audit/chain/verify')).json()).toMatchObject({ ok: true });
    });

    it('the person can no longer sign in', async () => {
      await expect(Client.login(app, T.host, T.users.employee!.email)).rejects.toThrow();
    });

    it('when the period ends, the follow-up job removes what was held, and the request completes', async () => {
      const hrJob = await Client.login(app, T.host, T.users.admin!.email);
      expect((await hrJob.runJob('data_rights.erasure_followup')).json()).toMatchObject({ status: 'succeeded', result: { carveOutsEnded: 0 } });
      expect((await ownerQuery(`SELECT 1 FROM employee_statutory WHERE employee_id=$1`, [id])).length).toBe(1);
      await ownerQuery(
        `UPDATE erasure_requests SET report=jsonb_set(report, '{retained}', (SELECT jsonb_agg(jsonb_set(c, '{until}', '"2020-03-31"')) FROM jsonb_array_elements(report->'retained') c)) WHERE id=$1`,
        [reqId],
      );
      const r = (await hrJob.runJob('data_rights.erasure_followup')).json();
      expect(r).toMatchObject({ status: 'succeeded', result: { carveOutsEnded: 3, requestsCompleted: 1 } });
      for (const t of ['employee_statutory', 'employee_bank_accounts', 'documents']) expect((await ownerQuery(`SELECT 1 FROM ${t} WHERE employee_id=$1`, [id])).length, t).toBe(0);
      await expect(getStore()!.get(keys.tax!)).rejects.toThrow();
      const [q] = await ownerQuery<{ status: string; retained_identity_enc: string | null }>(`SELECT status, retained_identity_enc FROM erasure_requests WHERE id=$1`, [reqId]);
      expect(q).toEqual({ status: 'completed', retained_identity_enc: null });
      expect((await ownerQuery<{ employee_code: string }>(`SELECT employee_code FROM employees WHERE id=$1`, [id]))[0]!.employee_code).toMatch(/^ERASED-/);
      expect(testCipher.decrypt((await ownerQuery<{ description_enc: string }>(`SELECT description_enc FROM cases WHERE complainant_id=$1`, [id]))[0]!.description_enc)).toBe(
        '[erased]',
      );
      // Figures stay, as nobody's.
      expect((await ownerQuery(`SELECT 1 FROM payroll_items WHERE employee_id=$1`, [id])).length).toBe(1);
    });
  });

  it('someone who never joined has nothing kept, and their record is emptied at once', async () => {
    const T = await createTenant();
    const id = T.users.other!.employeeId!;
    await ownerQuery(`UPDATE employees SET status='pre_joining', phone=$2 WHERE id=$1`, [id, PHONE]);
    const hr = await Client.login(app, T.host, T.users.hr!.email);
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    const req = (await hr.post(base, { subjectType: 'employee', subjectId: id })).json();
    const r = (await admin.post(`${base}/${req.id}/execute`, {})).json();
    expect(r.status).toBe('completed');
    expect(r.report.retained).toEqual([]);
    expect((await ownerQuery<Record<string, unknown>>(`SELECT phone, status, employee_code FROM employees WHERE id=$1`, [id]))[0]).toMatchObject({
      phone: null,
      status: 'inactive',
      employee_code: expect.stringMatching(/^ERASED-/),
    });
  });

  it('a resume with no store to delete it from is not forgotten: the anonymization stops and says so', async () => {
    const T = await createTenant();
    const k = newKey(T.id, null, 'recruitment');
    await getStore()!.put(k, TINY_PNG, 'image/png');
    const [c] = await ownerQuery<{ id: string }>(
      `INSERT INTO candidates (tenant_id, first_name, source, resume_key, resume_name, resume_type, resume_sha256, consent_at, consent_note, retain_until, created_by) VALUES ($1,'Keep','job_portal',$2,'cv.png','image/png',repeat('a',64),now(),'x','2020-01-01',$3) RETURNING id`,
      [T.id, k, T.users.hr!.id],
    );
    const hr = await Client.login(app, T.host, T.users.hr!.email);
    const store = getStore();
    setStore(null);
    const run = (await hr.runJob('recruitment.retention')).json();
    setStore(store);
    expect(run.status).toBe('failed');
    expect((await ownerQuery(`SELECT first_name, resume_key FROM candidates WHERE id=$1`, [c!.id]))[0]).toEqual({ first_name: 'Keep', resume_key: k });
    expect((await hr.runJob('recruitment.retention')).json().status).toBe('succeeded');
    await expect(getStore()!.get(k)).rejects.toThrow();
  });

  it('an erased record cannot be edited back to life', async () => {
    const T = await createTenant();
    const id = T.users.other!.employeeId!;
    await ownerQuery(`UPDATE employees SET status='exited', exit_date='2026-01-31' WHERE id=$1`, [id]);
    const hr = await Client.login(app, T.host, T.users.hr!.email);
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    const req = (await hr.post(base, { subjectType: 'employee', subjectId: id })).json();
    expect((await admin.post(`${base}/${req.id}/execute`, {})).statusCode).toBe(200);
    const [{ version }] = (await ownerQuery<{ version: number }>(`SELECT version FROM employees WHERE id=$1`, [id])) as [{ version: number }];
    const r = await hr.patch(`/api/v1/employees/${id}`, { expectedVersion: version, changes: { firstName: 'Back' } });
    expect(r.statusCode).toBe(409);
    expect(problem(r).detail).toMatch(/erased/);
  });

  it('a refused request can be followed by another', async () => {
    const T = await createTenant();
    const id = T.users.other!.employeeId!;
    await ownerQuery(`UPDATE employees SET status='exited', exit_date='2026-01-31' WHERE id=$1`, [id]);
    const hr = await Client.login(app, T.host, T.users.hr!.email);
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    const req = (await hr.post(base, { subjectType: 'employee', subjectId: id })).json();
    expect((await admin.post(`${base}/${req.id}/reject`, { note: 'Not yet settled' })).json().status).toBe('rejected');
    expect((await admin.post(`${base}/${req.id}/execute`, {})).statusCode).toBe(409);
    expect((await hr.post(base, { subjectType: 'employee', subjectId: id })).statusCode).toBe(201);
  });

  it('a candidate: resume deleted, record anonymized, a hired one refused, works with recruitment off', async () => {
    const T = await createTenant();
    const off = await makeApp({ ...flags('default') }, { storeOverride: true });
    const k = newKey(T.id, null, 'recruitment');
    await getStore()!.put(k, TINY_PNG, 'image/png');
    const [c] = await ownerQuery<{ id: string }>(
      `INSERT INTO candidates (tenant_id, first_name, last_name, email, phone, source, resume_key, resume_name, resume_type, resume_sha256, consent_at, consent_note, retain_until, created_by)
      VALUES ($1,'Cand','Idate','c@x.test','+91 9','job_portal',$2,'cv.png','image/png',repeat('a',64),now(),'x','2030-01-01',$3) RETURNING id`,
      [T.id, k, T.users.hr!.id],
    );
    const hr = await Client.login(off, T.host, T.users.hr!.email);
    const admin = await Client.login(off, T.host, T.users.admin!.email);
    const ex = (await hr.get(`/api/v1/tenant/data-rights/candidates/${c!.id}/export`)).json();
    expect(ex.candidate).toMatchObject({ first_name: 'Cand', email: 'c@x.test' });
    const req = (await hr.post(base, { subjectType: 'candidate', subjectId: c!.id })).json();
    const r = (await admin.post(`${base}/${req.id}/execute`, {})).json();
    expect(r.status).toBe('completed');
    expect(r.report.retained).toEqual([]);
    expect((await ownerQuery(`SELECT first_name, email, resume_key FROM candidates WHERE id=$1`, [c!.id]))[0]).toEqual({ first_name: 'Anonymized', email: null, resume_key: null });
    await expect(getStore()!.get(k)).rejects.toThrow();
    const [h] = await ownerQuery<{ id: string }>(
      `INSERT INTO candidates (tenant_id, first_name, source, consent_at, consent_note, retain_until, created_by, employee_id) VALUES ($1,'Hired','job_portal',now(),'x','2030-01-01',$2,$3) RETURNING id`,
      [T.id, T.users.hr!.id, T.users.employee!.employeeId],
    );
    const hq = (await hr.post(base, { subjectType: 'candidate', subjectId: h!.id })).json();
    const refused = await admin.post(`${base}/${hq.id}/execute`, {});
    expect(refused.statusCode).toBe(409);
    expect(problem(refused).detail).toMatch(/hired/);
    await off.close();
  });

  it('in single mode one Owner suffices, audited as such; in single_hr HR raises and the Owner executes', async () => {
    for (const mode of ['single', 'single_hr'] as const) {
      const a = await makeApp({ ...flags('default'), ORG_MANAGEMENT_MODE: mode }, { storeOverride: true });
      const T = await createTenant();
      await ownerQuery(`INSERT INTO user_roles (user_id, tenant_id, role_key) VALUES ($1,$2,'owner')`, [T.users.admin!.id, T.id]);
      const id = T.users.other!.employeeId!;
      await ownerQuery(`UPDATE employees SET status='exited', exit_date='2026-01-31' WHERE id=$1`, [id]);
      const owner = await Client.login(a, T.host, T.users.admin!.email);
      const req = (await owner.post(base, { subjectType: 'employee', subjectId: id })).json();
      const r = await owner.post(`${base}/${req.id}/execute`, {});
      expect(r.statusCode, mode).toBe(200);
      const [log] = await ownerQuery<{ change_metadata: { selfApproved: boolean } }>(
        `SELECT change_metadata FROM audit_logs WHERE tenant_id=$1 AND action='data_rights.erasure_executed'`,
        [T.id],
      );
      expect(log!.change_metadata.selfApproved).toBe(true);
      if (mode === 'single_hr') {
        const hr = await Client.login(a, T.host, T.users.hr!.email);
        const id2 = T.users.employee!.employeeId!;
        await ownerQuery(`UPDATE employees SET status='exited', exit_date='2026-01-31' WHERE id=$1`, [id2]);
        const q = await hr.post(base, { subjectType: 'employee', subjectId: id2 });
        expect(q.statusCode).toBe(201);
        expect((await hr.post(`${base}/${q.json().id}/execute`, {})).statusCode).toBe(403);
        expect((await owner.post(`${base}/${q.json().id}/execute`, {})).statusCode).toBe(200);
      }
      await a.close();
    }
  });

  it('a file that could not be deleted is reported pending, and the follow-up job finishes it', async () => {
    const T = await createTenant();
    const { id, keys } = await person(T, 'other', '2026-01-31');
    const hr = await Client.login(app, T.host, T.users.hr!.email);
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    const req = (await hr.post(base, { subjectType: 'employee', subjectId: id })).json();
    const store = getStore();
    setStore(null);
    const r = (await admin.post(`${base}/${req.id}/execute`, {})).json();
    setStore(store);
    expect(r.report).toMatchObject({ filesDeleted: 0, filesPending: 1 });
    expect((await getStore()!.get(keys.identity!)).toString()).toBe('file');
    const job = (await admin.runJob('data_rights.erasure_followup')).json();
    expect(job.result).toMatchObject({ filesDeleted: 1, filesPending: 0 });
    await expect(getStore()!.get(keys.identity!)).rejects.toThrow();
  });
});

describe('retention', () => {
  it('every job that erases is marked to run with its module off', () => {
    for (const k of ['recruitment.retention', 'attendance.selfie_retention', 'retention.operational', 'retention.documents_after_exit', 'data_rights.erasure_followup']) {
      const j = JOB_MAP.get(k)!;
      expect(j.retention, k).toBe(true);
      expect(
        jobActive(j, () => false),
        k,
      ).toBe(true);
    }
  });

  it('the settings are there and validated', async () => {
    const T = await createTenant();
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    const items = (await admin.get('/api/v1/tenant/settings')).json().items as { key: string; group: string }[];
    expect(
      items
        .filter((i) => i.group === 'retention')
        .map((i) => i.key)
        .sort(),
    ).toEqual([
      'retention.attendance_years',
      'retention.claims_years',
      'retention.documents_after_exit_months',
      'retention.email_outbox_days',
      'retention.job_runs_days',
      'retention.notifications_days',
      'retention.payroll_years',
    ]);
    expect((await admin.put('/api/v1/tenant/settings/retention.payroll_years', { value: 0 })).statusCode).toBe(400);
    expect((await admin.put('/api/v1/tenant/settings/retention.payroll_years', { value: 10 })).statusCode).toBe(200);
    const r = (await admin.get('/api/v1/tenant/data-rights/retention')).json();
    expect(r.carveOuts.find((c: { category: string }) => c.category === 'payroll').years).toBe(10);
    expect(r.notLegalAdvice).toMatch(/not legal advice/);
  });

  it('the operational job purges what was unbounded, by its periods, and leaves what is recent or unsent', async () => {
    const T = await createTenant();
    const u = T.users.employee!.id;
    const old = "now() - interval '500 days'";
    await ownerQuery(`INSERT INTO notifications (tenant_id, user_id, kind, title, body, created_at) VALUES ($1,$2,'x','old','b',${old}), ($1,$2,'x','new','b',now())`, [T.id, u]);
    await ownerQuery(
      `INSERT INTO email_outbox (tenant_id, to_user_id, to_email, subject, text_body, html_body, kind, status, created_at) VALUES ($1,$2,'a@x.test','old','b','b','x','sent',${old}), ($1,$2,'a@x.test','queued','b','b','x','queued',${old}), ($1,$2,'a@x.test','recent','b','b','x','sent',now())`,
      [T.id, u],
    );
    await ownerQuery(
      `INSERT INTO job_runs (tenant_id, job_key, period_key, trigger, status, started_at) VALUES ($1,'x','old','schedule','succeeded',${old}), ($1,'x','new','schedule','succeeded',now())`,
      [T.id],
    );
    const before = (await ownerQuery<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id=$1`, [T.id]))[0]!.n;
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    const r = (await admin.runJob('retention.operational')).json();
    expect(r).toMatchObject({ status: 'succeeded', result: { notifications: 1, email: 1, jobRuns: 1 } });
    expect((await ownerQuery<{ title: string }>(`SELECT title FROM notifications WHERE tenant_id=$1`, [T.id])).map((x) => x.title)).toEqual(['new']);
    expect((await ownerQuery<{ subject: string }>(`SELECT subject FROM email_outbox WHERE tenant_id=$1 ORDER BY subject`, [T.id])).map((x) => x.subject)).toEqual([
      'queued',
      'recent',
    ]);
    expect((await ownerQuery<{ period_key: string }>(`SELECT period_key FROM job_runs WHERE tenant_id=$1 AND job_key='x'`, [T.id])).map((x) => x.period_key)).toEqual(['new']);
    expect((await ownerQuery<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id=$1`, [T.id]))[0]!.n).toBeGreaterThanOrEqual(before);
  });

  it('documents after exit: gone after the period, kept before it, payroll categories by their own', async () => {
    const T = await createTenant();
    const { id, keys } = await person(T, 'employee', '2020-01-31');
    const { id: id2, keys: k2 } = await person(T, 'other', `${Number(today.slice(0, 4)) - 1}-01-31`);
    const admin = await Client.login(app, T.host, T.users.admin!.email);
    const r = (await admin.runJob('retention.documents_after_exit')).json();
    expect(r).toMatchObject({ status: 'succeeded', result: { deleted: 1 } });
    await expect(getStore()!.get(keys.identity!)).rejects.toThrow();
    expect((await getStore()!.get(keys.tax!)).toString()).toBe('file');
    expect((await getStore()!.get(k2.identity!)).toString()).toBe('file');
    expect((await ownerQuery(`SELECT 1 FROM documents WHERE employee_id=$1`, [id2])).length).toBe(2);
    expect((await ownerQuery<{ file_name: string }>(`SELECT file_name FROM documents WHERE employee_id=$1`, [id])).map((d) => d.file_name)).toEqual(['tax.pdf']);
    await admin.put('/api/v1/tenant/settings/retention.payroll_years', { value: 1 });
    expect((await admin.runJob('retention.documents_after_exit')).json().result).toMatchObject({ deleted: 2 }); // both payroll documents, now past one year
    await expect(getStore()!.get(keys.tax!)).rejects.toThrow();
  });

  describe('with every module off', () => {
    let off: FastifyInstance;
    beforeAll(async () => {
      off = await makeApp({ ...flags('attendance,attendance.web') }, { storeOverride: true });
    });
    afterAll(async () => {
      await off.close();
    });

    /** A candidate past retention and a selfie past its date, under modules this app does not have. */
    async function dueData(T: TenantFixture) {
      const [c] = await ownerQuery<{ id: string }>(
        `INSERT INTO candidates (tenant_id, first_name, email, source, consent_at, consent_note, retain_until, created_by) VALUES ($1,'Old','o@x.test','job_portal',now(),'x','2020-01-01',$2) RETURNING id`,
        [T.id, T.users.hr!.id],
      );
      const k = newKey(T.id, T.users.employee!.employeeId!, 'selfies');
      await getStore()!.put(k, TINY_PNG, 'image/png');
      const [s] = await ownerQuery<{ id: string }>(
        `INSERT INTO attendance_selfies (tenant_id, employee_id, storage_key, content_type, size_bytes, sha256, retain_until) VALUES ($1,$2,$3,'image/png',1,repeat('a',64),now() - interval '1 day') RETURNING id`,
        [T.id, T.users.employee!.employeeId, k],
      );
      return { candidate: c!.id, selfie: s!.id, key: k };
    }
    const check = async (d: Awaited<ReturnType<typeof dueData>>) => {
      expect((await ownerQuery(`SELECT first_name FROM candidates WHERE id=$1`, [d.candidate]))[0]).toEqual({ first_name: 'Anonymized' });
      expect((await ownerQuery<{ erased: boolean }>(`SELECT erased_at IS NOT NULL AS erased FROM attendance_selfies WHERE id=$1`, [d.selfie]))[0]!.erased).toBe(true);
      await expect(getStore()!.get(d.key)).rejects.toThrow();
    };

    it('the scheduled path erases: AUDIT said it skipped them, and that is no longer so', async () => {
      const T = await createTenant();
      const d = await dueData(T);
      await inApp(off, () => tick(off.deps.pool, quiet, new Date(`${today}T23:30:00+05:30`)));
      await check(d);
      const runs = (await ownerQuery<{ job_key: string; status: string }>(`SELECT job_key, status FROM job_runs WHERE tenant_id=$1 AND status='succeeded'`, [T.id])).map(
        (r) => r.job_key,
      );
      for (const k of ['recruitment.retention', 'attendance.selfie_retention', 'retention.operational', 'retention.documents_after_exit', 'data_rights.erasure_followup'])
        expect(runs).toContain(k);
    });

    it('the queued path erases the same way', async () => {
      const T = await createTenant();
      const d = await dueData(T);
      for (const k of ['recruitment.retention', 'attendance.selfie_retention']) {
        await ownerQuery(`INSERT INTO job_runs (tenant_id, job_key, period_key, trigger, status) VALUES ($1,$2,$3,'manual','queued')`, [T.id, k, `manual:${k}`]);
      }
      await inApp(off, () => runQueued(off.deps.pool, quiet, T.id, new Date()));
      await check(d);
    });

    it('a retry of a failed retention run goes through as well', async () => {
      const T = await createTenant();
      const d = await dueData(T);
      await ownerQuery(
        `INSERT INTO job_runs (tenant_id, job_key, period_key, trigger, status, attempts, next_retry_at, started_at) VALUES ($1,'recruitment.retention',$2,'schedule','failed',1,now() - interval '1 minute',now() - interval '1 hour')`,
        [T.id, '2020-01-01'],
      );
      await inApp(off, () => tick(off.deps.pool, quiet, new Date(`${today}T23:30:00+05:30`)));
      expect((await ownerQuery(`SELECT status FROM job_runs WHERE tenant_id=$1 AND period_key='2020-01-01'`, [T.id]))[0]).toEqual({ status: 'succeeded' });
      await check(d);
    });

    it('report copies past their date are removed though the reports module, whose job used to do it, is off', async () => {
      const T = await createTenant();
      const [s] = await ownerQuery<{ id: string }>(
        `INSERT INTO report_snapshots (tenant_id, owner_id, report_key, name, params, scope, columns, data_enc, row_count, recipient_ids, viewer_level, expires_at)
        VALUES ($1,$2,'x','x','{}','all','[]',$3,0,'{}',0,now() - interval '1 day') RETURNING id`,
        [T.id, T.users.admin!.id, seal({ rows: [] })],
      );
      await inApp(off, () => tick(off.deps.pool, quiet, new Date(`${today}T23:30:00+05:30`)));
      expect((await ownerQuery(`SELECT 1 FROM report_snapshots WHERE id=$1`, [s!.id])).length).toBe(0);
    });
  });
});
