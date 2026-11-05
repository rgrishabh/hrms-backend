import { dataCipher, sealJson, openJson } from '../../core/crypto/index.js';
import { audit } from '../../core/audit/audit.js';
import { isCollapsedMode } from '../../core/policy/mode.js';
import { AppError, conflict, forbidden, notFound } from '../../core/http/errors.js';
import { isOwnerRole } from '../../core/auth/permissions.js';
import { levelOf, SYSTEM_COLUMNS } from '../../core/policy/classification.js';
import { getSettingValue } from '../../core/settings/service.js';
import { getStore } from '../../core/storage/index.js';
import { subjectLevelSql } from '../../core/policy/salary.js';
import type { Db } from '../../db/tx.js';
import { anonymizeCandidate } from '../recruitment/routes.js';
import { AUDIT_LOG_NOTE, CARVE_OUT_BASIS, NOT_LEGAL_ADVICE, PERSONAL_TABLES, type CarveOut, type PersonalTable } from './map.js';

export const ERASED_FIRST_NAME = 'Erased';
const ERASED_TEXT = '[erased]';

export interface EmployeeSubject {
  id: string;
  userId: string | null;
  status: string;
  exitDate: string | null;
  erasedAt: Date | null;
  code: string;
  firstName: string;
  lastName: string | null;
  dob: string | null;
}

export async function loadEmployee(db: Db, tenantId: string, id: string, lock = false): Promise<EmployeeSubject | undefined> {
  const r = await db.query<{
    id: string;
    user_id: string | null;
    status: string;
    exit_date: string | null;
    erased_at: Date | null;
    employee_code: string;
    first_name: string;
    last_name: string | null;
    dob: string | null;
  }>(
    `SELECT id, user_id, status, exit_date::text, erased_at, employee_code, first_name, last_name, date_of_birth::text AS dob FROM employees WHERE tenant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
    [tenantId, id],
  );
  const e = r.rows[0];
  return (
    e && {
      id: e.id,
      userId: e.user_id,
      status: e.status,
      exitDate: e.exit_date,
      erasedAt: e.erased_at,
      code: e.employee_code,
      firstName: e.first_name,
      lastName: e.last_name,
      dob: e.dob,
    }
  );
}

/** Why this person cannot be erased yet, or null. Separated or never joined: nothing else. */
export function refusalFor(e: Pick<EmployeeSubject, 'status'>): string | null {
  if (e.status === 'active') return 'This person is still employed. Personal data needed to run their employment cannot be erased until they have separated.';
  if (e.status === 'on_notice') return 'This person is serving notice. Their data can be erased once they have separated.';
  return null;
}

/** The end of the Indian financial year in which `from` falls, plus `years`: statutes count financial years. */
export function retentionEnd(from: string, years: number): string {
  const y = Number(from.slice(0, 4));
  const m = Number(from.slice(5, 7));
  return `${(m >= 4 ? y + 1 : y) + years}-03-31`;
}

// ---------------------------------------------------------------- export
const colsCache = new Map<string, { name: string; nullable: boolean; type: string; hasDefault: boolean }[]>();
async function columnsOf(db: Db, table: string) {
  const hit = colsCache.get(table);
  if (hit) return hit;
  const r = await db.query<{ column_name: string; is_nullable: string; data_type: string; column_default: string | null }>(
    `SELECT column_name, is_nullable, data_type, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [table],
  );
  const out = r.rows.map((c) => ({ name: c.column_name, nullable: c.is_nullable === 'YES', type: c.data_type, hasDefault: c.column_default !== null }));
  colsCache.set(table, out);
  return out;
}

const finder = (t: PersonalTable) => t.where ?? `tenant_id=$1 AND ${t.column ?? (t.by === 'user' ? 'user_id' : 'employee_id')}=$2`;
const subjectKey = (t: PersonalTable, e: { id: string; userId: string | null }) => (t.by === 'user' ? e.userId : e.id);

export interface ExportView {
  self: boolean;
  mayL3: boolean;
  mayL4: boolean;
}
export interface ExportSection {
  key: string;
  total: number;
  rows: Record<string, unknown>[];
  nextOffset: number | null;
  maskedColumns?: string[];
  withheld?: boolean;
}

export const EXPORT_SECTIONS = PERSONAL_TABLES.filter((t) => !t.noExport);

/** A sealed value as what was sealed: JSON where it was JSON. */
function openSealed(token: string): unknown {
  const s = dataCipher().decrypt(token);
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** One section of a person's data: columns by level, sealed columns opened only where the section names them and the viewer may see L4. */
export async function exportSection(
  db: Db,
  tenantId: string,
  t: PersonalTable,
  e: { id: string; userId: string | null },
  view: ExportView,
  limit: number,
  offset: number,
): Promise<ExportSection> {
  if (t.selfOnly && !view.self) return { key: t.section, total: 0, rows: [], nextOffset: null, withheld: true };
  const key = subjectKey(t, e);
  if (key === null) return { key: t.section, total: 0, rows: [], nextOffset: null };
  const all = await columnsOf(db, t.table);
  const masked: string[] = [];
  const select: string[] = [];
  const toOpen = new Set<string>();
  for (const { name } of all) {
    if (name === 'tenant_id' || t.omit?.includes(name)) continue;
    const level = levelOf(t.table, name);
    if (!level && !SYSTEM_COLUMNS.has(name)) continue;
    const sealed = name.endsWith('_enc');
    if (sealed && !t.open?.includes(name)) continue;
    // A hash or secret of the account is never data to hand over, whatever the viewer.
    if (t.table === 'users' && level === 'L4') continue;
    if (t.table === 'sessions' && (name === 'token_hash' || name === 'csrf_hash')) continue;
    if ((level === 'L4' && !view.mayL4) || (level === 'L3' && !view.mayL3)) {
      masked.push(name);
      continue;
    }
    select.push(`"${name}"`);
    if (sealed) toOpen.add(name);
  }
  const where = finder(t);
  const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${t.table} WHERE ${where}`, [tenantId, key])).rows[0]!.n);
  if (!select.length) return { key: t.section, total, rows: [], nextOffset: null, ...(masked.length ? { maskedColumns: masked } : {}) };
  const rows = (
    await db.query<Record<string, unknown>>(`SELECT ${select.join(', ')} FROM ${t.table} WHERE ${where} ORDER BY ${t.order ?? 'id'} LIMIT $3 OFFSET $4`, [
      tenantId,
      key,
      limit,
      offset,
    ])
  ).rows;
  for (const row of rows)
    for (const c of toOpen) {
      const v = row[c];
      delete row[c];
      row[c.replace(/_enc$/, '')] = typeof v === 'string' ? openSealed(v) : null;
    }
  return { key: t.section, total, rows, nextOffset: offset + rows.length < total ? offset + rows.length : null, ...(masked.length ? { maskedColumns: masked } : {}) };
}

/** L4 columns that actually left in this answer, for auditL4. */
export function l4Fields(sections: readonly ExportSection[], view: ExportView): string[] {
  if (!view.mayL4) return [];
  const out = new Set<string>();
  for (const s of sections) {
    if (!s.rows.length) continue;
    const t = PERSONAL_TABLES.find((x) => x.section === s.key)!;
    for (const c of Object.keys(s.rows[0]!)) if (levelOf(t.table, c) === 'L4' || levelOf(t.table, `${c}_enc`) === 'L4') out.add(`${t.table}.${c}`);
  }
  return [...out].sort();
}

// ---------------------------------------------------------------- erasure
export interface RetainedCategory {
  category: CarveOut;
  label: string;
  tables: string[];
  rows: number;
  until: string;
  basis: string;
  ended?: boolean;
}
export interface ErasureReport {
  erased: Record<string, number>;
  filesDeleted: number;
  filesPending: number;
  retained: RetainedCategory[];
  auditLog: string;
  notLegalAdvice: string;
}

async function scrubRows(db: Db, tenantId: string, t: PersonalTable, key: string): Promise<number> {
  const cols = await columnsOf(db, t.table);
  const sets = (t.scrub ?? []).map((name) => {
    const c = cols.find((x) => x.name === name)!;
    if (c.nullable) return `${name}=NULL`;
    if (c.hasDefault) return `${name}=DEFAULT`;
    if (c.type === 'jsonb') return `${name}='[]'::jsonb`;
    if (c.type === 'numeric') return `${name}=0`;
    return `${name}='${ERASED_TEXT}'`;
  });
  return (await db.query(`UPDATE ${t.table} SET ${sets.join(', ')} WHERE ${finder(t)}`, [tenantId, key])).rowCount ?? 0;
}

const uniq = <T>(a: readonly T[]) => [...new Set(a)];

/** Everything the person's id reaches that has no reason to stay. Never reads a value out. */
async function eraseEmployeeData(
  db: Db,
  tenantId: string,
  e: EmployeeSubject,
  today: string,
): Promise<{ erased: Record<string, number>; files: string[]; retained: RetainedCategory[]; identityNeeded: boolean }> {
  const erased: Record<string, number> = {};
  const files: string[] = [];
  const count = (table: string, n: number) => {
    if (n) erased[table] = (erased[table] ?? 0) + n;
  };
  const held = new Map<CarveOut, { tables: Set<string>; rows: number }>();

  for (const t of PERSONAL_TABLES) {
    const key = subjectKey(t, e);
    if (t.erase === 'custom' || key === null) continue;
    if (t.erase === 'delete') {
      count(t.table, (await db.query(`DELETE FROM ${t.table} WHERE ${finder(t)}`, [tenantId, key])).rowCount ?? 0);
      continue;
    }
    if (t.erase === 'scrub') count(t.table, await scrubRows(db, tenantId, t, key));
    if (t.carveOut) {
      const n = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${t.table} WHERE ${finder(t)}`, [tenantId, key])).rows[0]!.n);
      if (n) {
        const h = held.get(t.carveOut) ?? { tables: new Set<string>(), rows: 0 };
        h.tables.add(t.table);
        h.rows += n;
        held.set(t.carveOut, h);
      }
    }
  }

  // Comments on their approvals, and notes on their checklist tasks, can say anything.
  count(
    'approval_steps',
    (
      await db.query(
        `UPDATE approval_steps s SET comment=NULL FROM approval_requests r WHERE s.tenant_id=$1 AND r.tenant_id=$1 AND s.request_id=r.id AND r.requester_id=$2 AND s.comment IS NOT NULL`,
        [tenantId, e.userId],
      )
    ).rowCount ?? 0,
  );
  count(
    'checklist_tasks',
    (
      await db.query(
        `UPDATE checklist_tasks k SET note=NULL FROM checklists c WHERE k.tenant_id=$1 AND c.tenant_id=$1 AND k.checklist_id=c.id AND c.employee_id=$2 AND k.note IS NOT NULL`,
        [tenantId, e.id],
      )
    ).rowCount ?? 0,
  );
  if (e.userId)
    count(
      'approval_delegations',
      (await db.query(`UPDATE approval_delegations SET note=NULL WHERE tenant_id=$1 AND (delegator_id=$2 OR delegate_id=$2) AND note IS NOT NULL`, [tenantId, e.userId]))
        .rowCount ?? 0,
    );

  // Selfies: always, and at once. Attendance does not need a photo to stand as a record.
  const selfies = await db.query<{ id: string; storage_key: string }>(
    `SELECT id, storage_key FROM attendance_selfies WHERE tenant_id=$1 AND employee_id=$2 AND storage_key IS NOT NULL`,
    [tenantId, e.id],
  );
  files.push(...selfies.rows.map((s) => s.storage_key));
  count(
    'attendance_selfies',
    (await db.query(`UPDATE attendance_selfies SET storage_key=NULL, erased_at=now() WHERE tenant_id=$1 AND employee_id=$2 AND storage_key IS NOT NULL`, [tenantId, e.id]))
      .rowCount ?? 0,
  );

  // Someone who never joined has no employment to keep records of, so no carve-out applies. What rows they have, such as a planned shift, stay without a name on them.
  const neverJoined = e.status === 'pre_joining';
  if (neverJoined) held.clear();

  // Documents: all but those in a payroll category, which are vouchers and proofs.
  const docs = await db.query<{ storage_key: string }>(
    `DELETE FROM documents d USING document_categories c WHERE d.tenant_id=$1 AND c.tenant_id=$1 AND d.category_id=c.id AND d.employee_id=$2 AND ($3 OR NOT c.payroll_related) RETURNING d.storage_key`,
    [tenantId, e.id, neverJoined],
  );
  files.push(...docs.rows.map((d) => d.storage_key));
  count('documents', docs.rowCount ?? 0);
  const kept = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM documents WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, e.id])).rows[0]!.n);
  if (kept) {
    const h = held.get('payroll') ?? { tables: new Set<string>(), rows: 0 };
    h.tables.add('documents');
    h.rows += kept;
    held.set('payroll', h);
  }

  // A candidate who became this employee.
  const hired = await db.query<{ id: string }>(`SELECT id FROM candidates WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, e.id]);
  for (const c of hired.rows) if (await anonymizeCandidate(db, tenantId, c.id)) count('candidates', 1);

  // The account: signing in ends here, and links still out are ended.
  if (e.userId) {
    await db.query(`UPDATE admin_setup_tokens SET used_at=now() WHERE tenant_id=$1 AND user_id=$2 AND used_at IS NULL`, [tenantId, e.userId]);
    count(
      'users',
      (
        await db.query(
          `UPDATE users SET email=$3, display_name='Erased person', password_hash=NULL, status='disabled', mfa_secret_enc=NULL, mfa_pending_secret_enc=NULL, mfa_recovery_hashes='{}', mfa_enabled_at=NULL, mfa_method=NULL, updated_at=now()
      WHERE tenant_id=$1 AND id=$2`,
          [tenantId, e.userId, `erased-${e.userId}@erased.invalid`],
        )
      ).rowCount ?? 0,
    );
  }
  count(
    'employees',
    (
      await db.query(
        `UPDATE employees SET first_name=$3, last_name=NULL, work_email=NULL, phone=NULL, date_of_birth=NULL, designation=NULL, grade=NULL, reporting_manager_id=NULL,
      status=CASE WHEN status='pre_joining' THEN 'inactive' ELSE status END, erased_at=now(), version=version+1, updated_at=now() WHERE tenant_id=$1 AND id=$2`,
        [tenantId, e.id, ERASED_FIRST_NAME],
      )
    ).rowCount ?? 0,
  );

  // How long each carve-out runs. Payroll counts from the last period paid, in case that is later than the last day.
  const anchor = e.exitDate ?? today;
  const lastPeriod = (
    await db.query<{ p: string | null }>(
      `SELECT max(r.period) AS p FROM payroll_items i JOIN payroll_runs r ON r.tenant_id=i.tenant_id AND r.id=i.run_id WHERE i.tenant_id=$1 AND i.employee_id=$2`,
      [tenantId, e.id],
    )
  ).rows[0]?.p;
  const payrollAnchor = lastPeriod && `${lastPeriod}-28` > anchor ? `${lastPeriod}-28` : anchor;
  const latestCase = (
    await db.query<{ d: string | null }>(`SELECT max(closed_at)::date::text AS d FROM cases WHERE tenant_id=$1 AND (complainant_id=$2 OR respondent_id=$2)`, [tenantId, e.id])
  ).rows[0]?.d;
  const openCase = (await db.query(`SELECT 1 FROM cases WHERE tenant_id=$1 AND (complainant_id=$2 OR respondent_id=$2) AND closed_at IS NULL LIMIT 1`, [tenantId, e.id])).rowCount;
  const claimsAnchor = openCase ? today : latestCase && latestCase > anchor ? latestCase : anchor;
  const anchors: Record<CarveOut, string> = { payroll: payrollAnchor, attendance: anchor, claims: claimsAnchor };
  const retained: RetainedCategory[] = [];
  for (const [category, h] of held) {
    const b = CARVE_OUT_BASIS[category];
    const years = await getSettingValue<number>(db, tenantId, b.setting);
    retained.push({ category, label: b.label, tables: [...h.tables].sort(), rows: h.rows, until: retentionEnd(anchors[category], years), basis: b.basis });
  }
  // A case naming them as respondent is retained for the other party's sake, with no row found by their own id above.
  if (!held.has('claims') && (latestCase || openCase)) {
    const b = CARVE_OUT_BASIS.claims;
    retained.push({
      category: 'claims',
      label: b.label,
      tables: ['cases'],
      rows: 0,
      until: retentionEnd(claimsAnchor, await getSettingValue<number>(db, tenantId, b.setting)),
      basis: b.basis,
    });
  }
  retained.sort((a, b) => a.category.localeCompare(b.category));
  return { erased, files: uniq(files), retained, identityNeeded: held.has('payroll') };
}

/** Delete listed files. Whatever could not go stays pending for the follow-up job. */
export async function deleteFiles(keys: readonly string[], onFail?: (e: Error) => void): Promise<{ deleted: number; pending: string[] }> {
  const store = getStore();
  if (!store) return { deleted: 0, pending: [...keys] };
  let deleted = 0;
  const pending: string[] = [];
  for (const k of keys) {
    try {
      await store.delete(k);
      deleted++;
    } catch (e) {
      pending.push(k);
      onFail?.(e as Error);
    }
  }
  return { deleted, pending };
}

export interface ErasureRow {
  id: string;
  subject_type: 'employee' | 'candidate';
  subject_id: string;
  status: string;
  requested_by: string;
  report: ErasureReport | null;
  files_pending: string[];
  retained_until: string | null;
  reason: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  completed_at: Date | null;
  created_at: Date;
  retained_identity_enc: string | null;
}

export const REQUEST_COLS = `id, subject_type, subject_id, status, requested_by, report, files_pending, retained_until::text, reason, decided_by, decided_at, decision_note, completed_at, created_at, retained_identity_enc`;

/** What a person may be told about a request: the sealed identity and storage keys stay here. */
export const publicRequest = (r: ErasureRow) => ({
  id: r.id,
  subjectType: r.subject_type,
  subjectId: r.subject_id,
  status: r.status,
  requestedBy: r.requested_by,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
  decisionNote: r.decision_note,
  completedAt: r.completed_at,
  createdAt: r.created_at,
  retainedUntil: r.retained_until,
  reason: r.reason,
  report: r.report,
});

export interface Actor {
  tenantId: string;
  userId: string;
  employeeId: string | null;
  level: number;
  roles: readonly string[];
  auditBase: { tenantId: string; actorId: string; requestId: string; ip: string };
}

/** The two-person rule. In the smaller modes an Owner has nobody above them, so they may carry out their own request, and the audit log says so. */
function checkMaker(r: ErasureRow, a: Actor): { selfApproved: boolean } {
  if (r.requested_by !== a.userId) return { selfApproved: false };
  if (isCollapsedMode() && a.roles.some(isOwnerRole)) return { selfApproved: true };
  throw forbidden('Someone other than the person who raised this request must carry it out.');
}

export async function assertReachable(db: Db, a: Pick<Actor, 'tenantId' | 'level'>, employeeId: string) {
  const r = await db.query<{ ok: boolean }>(`SELECT ${Number(a.level)} > ${subjectLevelSql('e')} AS ok FROM employees e WHERE e.tenant_id=$1 AND e.id=$2`, [
    a.tenantId,
    employeeId,
  ]);
  if (!r.rows[0]?.ok) throw notFound('Person not found');
}

async function assertNotLastOwner(db: Db, tenantId: string, userId: string | null) {
  if (!userId) return;
  const holds = await db.query(`SELECT 1 FROM user_roles WHERE tenant_id=$1 AND user_id=$2 AND role_key IN ('owner','tenant_admin') LIMIT 1`, [tenantId, userId]);
  if (!holds.rowCount) return;
  const others = await db.query(
    `SELECT 1 FROM user_roles r JOIN users u ON u.id=r.user_id WHERE r.tenant_id=$1 AND r.user_id<>$2 AND r.role_key IN ('owner','tenant_admin') AND u.status='active' LIMIT 1`,
    [tenantId, userId],
  );
  if (!others.rowCount) throw conflict('This is the last administrator of the organization. Appoint another first.');
}

/**
 * Carry out a request. Everything in the database goes in one transaction, with the files listed; the caller removes the files after the commit. Executing what is already done answers with
 * what was done: it changes nothing, so a retry after a lost answer is safe.
 */
export async function executeErasure(db: Db, r: ErasureRow, a: Actor, today: string, note: string | undefined): Promise<{ row: ErasureRow; alreadyDone: boolean }> {
  if (r.status === 'retained' || r.status === 'completed') return { row: r, alreadyDone: true };
  if (r.status !== 'pending') throw conflict('This request was refused. Raise a new one.');
  const { selfApproved } = checkMaker(r, a);
  const tenantId = a.tenantId;
  let report: ErasureReport;
  let files: string[] = [];
  let identity: string | null = null;
  let until: string | null = null;
  if (r.subject_type === 'employee') {
    const e = await loadEmployee(db, tenantId, r.subject_id, true);
    if (!e) throw notFound('Person not found');
    await assertReachable(db, a, e.id);
    if (a.employeeId === e.id) throw forbidden('Someone else must carry out the erasure of your own data.');
    const refusal = refusalFor(e);
    if (refusal) throw new AppError(409, 'erasure_refused', refusal);
    await assertNotLastOwner(db, tenantId, e.userId);
    const res = await eraseEmployeeData(db, tenantId, e, today);
    files = res.files;
    if (res.identityNeeded) identity = sealJson({ firstName: e.firstName, lastName: e.lastName, dateOfBirth: e.dob, employeeCode: e.code });
    until = res.retained.length
      ? res.retained
          .map((x) => x.until)
          .sort()
          .at(-1)!
      : null;
    report = { erased: res.erased, filesDeleted: 0, filesPending: files.length, retained: res.retained, auditLog: AUDIT_LOG_NOTE, notLegalAdvice: NOT_LEGAL_ADVICE };
    if (!res.retained.length) await pseudonymize(db, tenantId, e.id);
  } else {
    const c = (
      await db.query<{ employee_id: string | null; status: string }>(`SELECT employee_id, status FROM candidates WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, r.subject_id])
    ).rows[0];
    if (!c) throw notFound('Person not found');
    if (c.employee_id) throw new AppError(409, 'erasure_refused', 'This candidate was hired. Their data goes with their employee record: raise the request for the employee.');
    const live = await db.query(
      `SELECT 1 FROM job_offers o JOIN job_applications ap ON ap.tenant_id=o.tenant_id AND ap.id=o.application_id
      WHERE o.tenant_id=$1 AND ap.candidate_id=$2 AND o.status IN ('pending','approved','sent','accepted') LIMIT 1`,
      [tenantId, r.subject_id],
    );
    if (live.rowCount) throw new AppError(409, 'erasure_refused', 'This candidate has a live offer. Withdraw it first.');
    const erased: Record<string, number> = {};
    if (await anonymizeCandidate(db, tenantId, r.subject_id)) erased.candidates = 1;
    const offers = await db.query(
      `UPDATE job_offers o SET annual_ctc=0, notes=NULL FROM job_applications ap WHERE o.tenant_id=$1 AND ap.tenant_id=$1 AND ap.id=o.application_id AND ap.candidate_id=$2`,
      [tenantId, r.subject_id],
    );
    if (offers.rowCount) erased.job_offers = offers.rowCount;
    const apps = await db.query(`UPDATE job_applications SET rejection_reason=NULL WHERE tenant_id=$1 AND candidate_id=$2 AND rejection_reason IS NOT NULL`, [
      tenantId,
      r.subject_id,
    ]);
    if (apps.rowCount) erased.job_applications = apps.rowCount;
    report = { erased, filesDeleted: 0, filesPending: 0, retained: [], auditLog: AUDIT_LOG_NOTE, notLegalAdvice: NOT_LEGAL_ADVICE };
  }
  const status = report.retained.length ? 'retained' : 'completed';
  const row = (
    await db.query<ErasureRow>(
      `UPDATE erasure_requests SET status=$3, decided_by=$4, decided_at=now(), decision_note=$5, reason=NULL, report=$6, files_pending=$7, retained_identity_enc=$8, retained_until=$9,
      completed_at=CASE WHEN $3='completed' THEN now() END WHERE tenant_id=$1 AND id=$2 RETURNING ${REQUEST_COLS}`,
      [tenantId, r.id, status, a.userId, note ?? null, JSON.stringify(report), files, identity, until],
    )
  ).rows[0]!;
  await audit(db, {
    ...a.auditBase,
    action: 'data_rights.erasure_executed',
    category: 'security',
    targetType: r.subject_type,
    targetId: r.subject_id,
    metadata: {
      requestId: r.id,
      selfApproved,
      erased: report.erased,
      files: files.length,
      retained: report.retained.map((x) => ({ category: x.category, rows: x.rows, until: x.until })),
    },
  });
  return { row, alreadyDone: false };
}

async function pseudonymize(db: Db, tenantId: string, employeeId: string) {
  await db.query(`UPDATE employees SET employee_code='ERASED-'||left(id::text, 8) WHERE tenant_id=$1 AND id=$2`, [tenantId, employeeId]);
}

/** After the commit: the files, then what is left to say about them. */
export async function finishFiles(
  pool: { tx: <T>(fn: (db: Db) => Promise<T>) => Promise<T> },
  tenantId: string,
  row: ErasureRow,
  onFail?: (e: Error) => void,
): Promise<ErasureRow> {
  if (!row.files_pending.length) return row;
  const { deleted, pending } = await deleteFiles(row.files_pending, onFail);
  return pool.tx(
    async (db) =>
      (
        await db.query<ErasureRow>(
          `UPDATE erasure_requests SET files_pending=$3, report=jsonb_set(jsonb_set(report, '{filesDeleted}', to_jsonb(coalesce((report->>'filesDeleted')::int, 0) + $4::int)), '{filesPending}', to_jsonb($5::int))
    WHERE tenant_id=$1 AND id=$2 RETURNING ${REQUEST_COLS}`,
          [tenantId, row.id, pending, deleted, pending.length],
        )
      ).rows[0]!,
  );
}

/** The payroll carve-out has ended: nothing statutory needs the person any more. Punches and payslips stay, as figures of nobody. */
async function endPayrollCarveOut(db: Db, tenantId: string, employeeId: string): Promise<string[]> {
  const files: string[] = [];
  await db.query(`DELETE FROM employee_statutory WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, employeeId]);
  await db.query(`DELETE FROM employee_bank_accounts WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, employeeId]);
  await db.query(`DELETE FROM employee_bank_changes WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, employeeId]);
  const docs = await db.query<{ storage_key: string }>(`DELETE FROM documents WHERE tenant_id=$1 AND employee_id=$2 RETURNING storage_key`, [tenantId, employeeId]);
  files.push(...docs.rows.map((d) => d.storage_key));
  const receipts = await db.query<{ receipt_key: string }>(
    `SELECT i.receipt_key FROM expense_items i JOIN expense_claims c ON c.tenant_id=i.tenant_id AND c.id=i.claim_id WHERE i.tenant_id=$1 AND c.employee_id=$2 AND i.receipt_key IS NOT NULL`,
    [tenantId, employeeId],
  );
  files.push(...receipts.rows.map((x) => x.receipt_key));
  await db.query(
    `UPDATE expense_items i SET receipt_key=NULL, receipt_name=NULL, receipt_type=NULL, receipt_sha256=NULL FROM expense_claims c WHERE i.tenant_id=$1 AND c.tenant_id=$1 AND c.id=i.claim_id AND c.employee_id=$2 AND i.receipt_key IS NOT NULL`,
    [tenantId, employeeId],
  );
  await pseudonymize(db, tenantId, employeeId);
  return files;
}

/** Closed cases about this person: what was written stays sealed for its period, and then is replaced. A case still open, or closed too recently, waits. */
async function endClaimsCarveOut(db: Db, tenantId: string, employeeId: string): Promise<void> {
  const blank = dataCipher().encrypt(ERASED_TEXT);
  const closed = await db.query<{ id: string }>(
    `UPDATE cases SET description_enc=$3, respondent_text_enc=NULL, late_reason_enc=NULL, outcome_enc=NULL WHERE tenant_id=$1 AND (complainant_id=$2 OR respondent_id=$2) AND closed_at IS NOT NULL RETURNING id`,
    [tenantId, employeeId, blank],
  );
  for (const c of closed.rows) await db.query(`UPDATE case_events SET text_enc=$3 WHERE tenant_id=$1 AND case_id=$2 AND text_enc IS NOT NULL`, [tenantId, c.id, blank]);
}

/**
 * Follow-up, daily and module-independent: files a crash or a missing store left, and carve-outs whose date has come. Returns the keys of files due, so that one job can delete them after committing.
 * Idempotent: a category ended stays ended.
 */
export async function erasureFollowUp(
  db: Db,
  tenantId: string,
  today: string,
): Promise<{ filesDeleted: number; filesPending: number; carveOutsEnded: number; requestsCompleted: number }> {
  const out = { filesDeleted: 0, filesPending: 0, carveOutsEnded: 0, requestsCompleted: 0 };
  const due = (
    await db.query<ErasureRow>(
      `SELECT ${REQUEST_COLS} FROM erasure_requests WHERE tenant_id=$1 AND status IN ('retained','completed') AND (cardinality(files_pending) > 0 OR status='retained') ORDER BY created_at LIMIT 500 FOR UPDATE SKIP LOCKED`,
      [tenantId],
    )
  ).rows;
  for (const r of due) {
    let files = [...r.files_pending];
    const report = r.report!;
    let ended = 0;
    for (const c of report.retained) {
      if (c.ended || c.until > today) continue;
      if (c.category === 'payroll') {
        files.push(...(await endPayrollCarveOut(db, tenantId, r.subject_id)));
      }
      if (c.category === 'claims') await endClaimsCarveOut(db, tenantId, r.subject_id);
      c.ended = true;
      ended++;
    }
    const payrollDone = !report.retained.some((c) => c.category === 'payroll' && !c.ended);
    const done = report.retained.every((c) => c.ended);
    files = uniq(files);
    const del = await deleteFiles(files);
    report.filesDeleted += del.deleted;
    report.filesPending = del.pending.length;
    await db.query(
      `UPDATE erasure_requests SET report=$3, files_pending=$4, retained_identity_enc=CASE WHEN $5 THEN NULL ELSE retained_identity_enc END, status=CASE WHEN $6 THEN 'completed' ELSE status END,
        completed_at=CASE WHEN $6 THEN coalesce(completed_at, now()) ELSE completed_at END WHERE tenant_id=$1 AND id=$2`,
      [tenantId, r.id, JSON.stringify(report), del.pending, payrollDone, done],
    );
    if (ended)
      await audit(db, {
        tenantId,
        actorId: null,
        actorType: 'system',
        action: 'data_rights.carve_out_ended',
        category: 'data',
        targetType: r.subject_type,
        targetId: r.subject_id,
        metadata: { requestId: r.id, ended: report.retained.filter((c) => c.ended).map((c) => c.category), completed: done },
      });
    out.filesDeleted += del.deleted;
    out.filesPending += del.pending.length;
    out.carveOutsEnded += ended;
    if (done && r.status !== 'completed') out.requestsCompleted++;
  }
  return out;
}

/** Who a retained statutory record belongs to. Only for a viewer entitled to the record itself; the caller checks and audits. */
export const openIdentity = (token: string) => openJson<{ firstName: string; lastName: string | null; dateOfBirth: string | null; employeeCode: string }>(token);

// ---------------------------------------------------------------- retention jobs
/** What audit section 5 called unbounded, plus report copies, whose purge lived in a job that stops with its module. audit_logs stays: see docs/DATA_RIGHTS.md. */
export async function purgeOperational(db: Db, tenantId: string) {
  const notifDays = await getSettingValue<number>(db, tenantId, 'retention.notifications_days');
  const mailDays = await getSettingValue<number>(db, tenantId, 'retention.email_outbox_days');
  const runDays = await getSettingValue<number>(db, tenantId, 'retention.job_runs_days');
  const n = async (sql: string, p: unknown[]) => (await db.query(sql, p)).rowCount ?? 0;
  return {
    notifications: await n(`DELETE FROM notifications WHERE tenant_id=$1 AND created_at < now() - make_interval(days => $2)`, [tenantId, notifDays]),
    email: await n(`DELETE FROM email_outbox WHERE tenant_id=$1 AND status IN ('sent','failed') AND created_at < now() - make_interval(days => $2)`, [tenantId, mailDays]),
    push: await n(`DELETE FROM push_outbox WHERE tenant_id=$1 AND status IN ('sent','failed') AND created_at < now() - make_interval(days => $2)`, [tenantId, mailDays]),
    jobRuns: await n(
      `DELETE FROM job_runs WHERE tenant_id=$1 AND status IN ('succeeded','failed') AND (next_retry_at IS NULL) AND started_at < now() - make_interval(days => $2)`,
      [tenantId, runDays],
    ),
    reportCopies: await n(`DELETE FROM report_snapshots WHERE tenant_id=$1 AND expires_at < now()`, [tenantId]),
  };
}

/** Employee documents after exit. Payroll categories count from the payroll period; everything else from `retention.documents_after_exit_months`. 0 keeps those until asked. */
export async function purgeDocumentsAfterExit(db: Db, tenantId: string, today: string) {
  const months = await getSettingValue<number>(db, tenantId, 'retention.documents_after_exit_months');
  const years = await getSettingValue<number>(db, tenantId, 'retention.payroll_years');
  const due = (
    await db.query<{ id: string; storage_key: string; exit_date: string; payroll_related: boolean; employee_id: string }>(
      `SELECT d.id, d.storage_key, e.exit_date::text, c.payroll_related, d.employee_id FROM documents d JOIN employees e ON e.tenant_id=d.tenant_id AND e.id=d.employee_id JOIN document_categories c ON c.tenant_id=d.tenant_id AND c.id=d.category_id
      WHERE d.tenant_id=$1 AND e.status='exited' AND e.exit_date IS NOT NULL AND ((NOT c.payroll_related AND $2::int > 0 AND e.exit_date + make_interval(months => $2) < $3::date) OR c.payroll_related)
      ORDER BY e.exit_date LIMIT 2000 FOR UPDATE OF d SKIP LOCKED`,
      [tenantId, months, today],
    )
  ).rows.filter((d) => !d.payroll_related || retentionEnd(d.exit_date, years) < today);
  if (!due.length) return { deleted: 0 };
  const store = getStore();
  if (!store) throw new Error('Documents are due for deletion but no storage is configured');
  for (const d of due) {
    await store.delete(d.storage_key);
    await db.query(`DELETE FROM documents WHERE tenant_id=$1 AND id=$2`, [tenantId, d.id]);
    await audit(db, {
      tenantId,
      actorId: null,
      actorType: 'system',
      action: 'documents.retention_deleted',
      category: 'data',
      targetType: 'employee',
      targetId: d.employee_id,
      metadata: { documentId: d.id, payrollRelated: d.payroll_related },
    });
  }
  return { deleted: due.length };
}
