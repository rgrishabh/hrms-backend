import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { tenantActor, tenantActorAny, gateFeatures, type TenantActor } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/errors.js';
import { IsoDate, PageQuery, offsetOf, paged, Uuid } from '../../core/http/pagination.js';
import { createApprovalRequest, registerApprovalHandler, cancelRequest, type StepSpec } from '../../core/workflow/engine.js';
import { getSettingValue } from '../../core/settings/service.js';
import { featureOn } from '../lifecycle/service.js';
import { teamEmployeeIds } from '../attendance/service.js';
import { addDays } from '../attendance/time.js';
import { orgToday } from '../competency/service.js';
import { insertLedgerEntry } from '../leave/jobs.js';
import { leaveYearOf, yearClosed, yearStartMonth, balanceOf } from '../leave/service.js';
import { overtimePaySettings, compOffType, compOffDays } from './service.js';
import type { Db } from '../../db/tx.js';

const F = 'overtime';
interface Claim { id: string; employee_id: string; work_date: string; minutes: number; payout: 'pay' | 'comp_off'; status: string; comp_off_days: string | null; payroll_run_id: string | null; user_id: string | null; name: string }

const CLAIM_COLS = `c.id, c.employee_id, c.work_date::text, c.minutes, c.recorded_minutes, c.payout, c.reason, c.status, c.comp_off_days, c.payroll_run_id, c.created_at, c.decided_at, c.cancel_reason,
  e.employee_code, e.user_id, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name, r.period AS payroll_period, r.status AS payroll_status,
  (SELECT ar.id FROM approval_requests ar WHERE ar.tenant_id=c.tenant_id AND ar.entity_type='overtime_claim' AND ar.entity_id=c.id ORDER BY ar.created_at DESC LIMIT 1) AS approval_request_id`;
const CLAIM_FROM = `overtime_claims c JOIN employees e ON e.tenant_id=c.tenant_id AND e.id=c.employee_id
  LEFT JOIN payroll_runs r ON r.tenant_id=c.tenant_id AND r.id=c.payroll_run_id AND r.status <> 'cancelled'`;

/** Calendar quarter [start, end] containing `date`. */
function quarterOf(date: string) {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const q0 = Math.floor((m - 1) / 3) * 3 + 1;
  const start = `${y}-${String(q0).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(y, q0 + 2, 0)).toISOString().slice(0, 10);
  return { start, end };
}
/** Refuse a claim that would take the person past the organization's quarterly limit. */
async function assertQuarterCap(db: Db, tenantId: string, employeeId: string, workDate: string, minutes: number, excludeId?: string) {
  const cap = await getSettingValue<number>(db, tenantId, 'overtime.quarter_cap_hours');
  if (!cap) return;
  const q = quarterOf(workDate);
  const used = Number((await db.query<{ m: string }>(`SELECT coalesce(sum(minutes),0)::text AS m FROM overtime_claims WHERE tenant_id=$1 AND employee_id=$2
    AND status IN ('pending','approved') AND work_date BETWEEN $3 AND $4 AND ($5::uuid IS NULL OR id <> $5)`, [tenantId, employeeId, q.start, q.end, excludeId ?? null])).rows[0]!.m);
  if (used + minutes > cap * 60) throw conflict(`This would exceed the overtime limit of ${cap} hours for the quarter (${Math.round(used / 6) / 10} h already claimed)`);
}

/** The claimant, their reporting chain, overtime readers, or whoever is or was an approver of it. */
async function loadClaim(db: Db, a: TenantActor, id: string, lock = false): Promise<Claim> {
  const c = (await db.query<Claim>(`SELECT c.id, c.employee_id, c.work_date::text, c.minutes, c.payout, c.status, c.comp_off_days, c.payroll_run_id, e.user_id,
      trim(e.first_name||' '||coalesce(e.last_name,'')) AS name FROM overtime_claims c JOIN employees e ON e.tenant_id=c.tenant_id AND e.id=c.employee_id
     WHERE c.tenant_id=$1 AND c.id=$2${lock ? ' FOR UPDATE OF c' : ''}`, [a.tenantId, id])).rows[0];
  if (!c) throw notFound('Overtime claim not found');
  if (c.employee_id === a.user.employeeId || a.has('overtime.read') || a.has('overtime.approve') || a.has('overtime.manage')) return c;
  if (a.has('overtime.team.read') && a.user.employeeId && (await teamEmployeeIds(db, a.tenantId, a.user.employeeId)).includes(c.employee_id)) return c;
  const r = await db.query(`SELECT 1 FROM approval_requests r JOIN approval_steps s ON s.tenant_id=r.tenant_id AND s.request_id=r.id
    WHERE r.tenant_id=$1 AND r.entity_type='overtime_claim' AND r.entity_id=$2 AND (s.approver_user_id=$3 OR s.acted_by=$3)`, [a.tenantId, id, a.user.userId]);
  if (r.rowCount) return c;
  throw notFound('Overtime claim not found');
}

/** What this person may claim with: pay (payroll on and the rate set) and/or compensatory off (a leave type configured). */
async function payoutOptions(db: Db, tenantId: string) {
  const pay = await featureOn(db, tenantId, 'payroll') ? await overtimePaySettings(db, tenantId) : null;
  const comp = await featureOn(db, tenantId, 'leave') ? await compOffType(db, tenantId) : null;
  return {
    pay: !!pay && !pay.missing.length,
    payBlocker: !pay ? 'Payroll is not in use' : pay.missing.length ? `Overtime pay is not set up (${pay.missing.join(', ')})` : null,
    compOff: comp ? { code: comp.code, name: comp.name, dayMinutes: await getSettingValue<number>(db, tenantId, 'overtime.comp_off_day_minutes') } : null,
  };
}

export async function overtimeRoutes(app: FastifyInstance) {
  gateFeatures(app, F);
  registerApprovalHandler('overtime_claim', {
    feature: F, label: 'Overtime claim', requesterLink: '/overtime',
    async onApproved(db, tenantId, id, actorId) {
      const c = (await db.query<{ employee_id: string; work_date: string; minutes: number; payout: string; status: string }>(
        `SELECT employee_id, work_date::text, minutes, payout, status FROM overtime_claims WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, id])).rows[0];
      if (!c || c.status !== 'pending') throw conflict('This overtime claim is no longer pending');
      await assertQuarterCap(db, tenantId, c.employee_id, c.work_date, c.minutes, id);
      let days: number | null = null;
      if (c.payout === 'comp_off') {
        const t = await compOffType(db, tenantId);
        if (!t) throw conflict('Compensatory off is no longer offered (no leave type configured); return the claim so it can be taken as pay');
        days = compOffDays(c.minutes, await getSettingValue<number>(db, tenantId, 'overtime.comp_off_day_minutes'));
        if (days <= 0) throw conflict('Too little overtime for compensatory off; return the claim so it can be taken as pay');
        // The day worked decides the leave year, unless that year is closed: its balance can no longer be taken.
        const startMonth = await yearStartMonth(db, tenantId);
        const workYear = leaveYearOf(c.work_date, startMonth);
        const year = await yearClosed(db, tenantId, workYear) ? leaveYearOf(await orgToday(db, tenantId), startMonth) : workYear;
        await insertLedgerEntry(db, tenantId, { empId: c.employee_id, typeId: t.id, year, entryType: 'adjustment', days: new Decimal(days),
          reference: `overtime:${id}:credit`, note: `Compensatory off for overtime on ${c.work_date}`, actorId });
      }
      await db.query(`UPDATE overtime_claims SET status='approved', decided_at=now(), comp_off_days=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, id, days]);
    },
    async onRejected(db, tenantId, id, actorId, status) {
      await db.query(`UPDATE overtime_claims SET status=$3, decided_at=now(), cancelled_by=CASE WHEN $3='cancelled' THEN $4::uuid END
        WHERE tenant_id=$1 AND id=$2 AND status='pending'`, [tenantId, id, status, actorId]);
    },
  });

  /** Days with recorded overtime the signed-in employee can still claim, and how they may take it. */
  app.get('/eligible', async (req) => {
    const a = tenantActor(req, 'overtime.self');
    if (!a.user.employeeId) throw badRequest('Your account is not linked to an employee record');
    return a.tx(async (db) => {
      const today = await orgToday(db, a.tenantId);
      const windowDays = await getSettingValue<number>(db, a.tenantId, 'overtime.claim_window_days');
      const minMinutes = await getSettingValue<number>(db, a.tenantId, 'overtime.min_minutes');
      const items = (await db.query(`SELECT d.work_date::text, d.overtime_minutes, d.first_in, d.last_out, d.worked_minutes, s.code AS shift_code
          FROM attendance_daily d LEFT JOIN shifts s ON s.tenant_id=d.tenant_id AND s.id=d.shift_id
         WHERE d.tenant_id=$1 AND d.employee_id=$2 AND d.work_date BETWEEN $3 AND $4 AND d.overtime_minutes >= greatest($5, 1)
           AND NOT EXISTS (SELECT 1 FROM overtime_claims c WHERE c.tenant_id=d.tenant_id AND c.employee_id=d.employee_id AND c.work_date=d.work_date AND c.status IN ('pending','approved'))
         ORDER BY d.work_date DESC`, [a.tenantId, a.user.employeeId, addDays(today, -windowDays), today, minMinutes])).rows;
      return { items, windowDays, minMinutes, payout: await payoutOptions(db, a.tenantId) };
    });
  });

  app.post('/claims', async (req, reply) => {
    const a = tenantActor(req, 'overtime.self');
    const b = z.object({ workDate: IsoDate, minutes: z.number().int().min(1).max(1440), payout: z.enum(['pay', 'comp_off']), reason: z.string().trim().min(3).max(1000) }).parse(req.body);
    const empId = a.user.employeeId;
    if (!empId) throw badRequest('Your account is not linked to an employee record');
    return a.tx(async (db) => {
      const today = await orgToday(db, a.tenantId);
      const windowDays = await getSettingValue<number>(db, a.tenantId, 'overtime.claim_window_days');
      if (b.workDate > today) throw badRequest('Overtime can be claimed only for days already worked');
      if (b.workDate < addDays(today, -windowDays)) throw badRequest(`Overtime can be claimed up to ${windowDays} days back`);
      const minMinutes = await getSettingValue<number>(db, a.tenantId, 'overtime.min_minutes');
      if (b.minutes < minMinutes) throw badRequest(`The smallest overtime claim is ${minMinutes} minutes`);
      const day = (await db.query<{ overtime_minutes: number }>(`SELECT overtime_minutes FROM attendance_daily WHERE tenant_id=$1 AND employee_id=$2 AND work_date=$3`, [a.tenantId, empId, b.workDate])).rows[0];
      if (!day || day.overtime_minutes <= 0) throw conflict('Attendance shows no overtime on this day (correct the attendance first)');
      if (b.minutes > day.overtime_minutes) throw badRequest(`Attendance shows ${day.overtime_minutes} minutes of overtime on this day; you cannot claim more`);
      const opts = await payoutOptions(db, a.tenantId);
      if (b.payout === 'pay' && !opts.pay) throw conflict(`Overtime cannot be paid yet: ${opts.payBlocker}`);
      if (b.payout === 'comp_off') {
        if (!opts.compOff) throw conflict('Compensatory off is not offered');
        if (compOffDays(b.minutes, opts.compOff.dayMinutes) <= 0) throw badRequest(`Compensatory off needs at least ${opts.compOff.dayMinutes / 2} minutes of overtime (half a day)`);
      }
      await assertQuarterCap(db, a.tenantId, empId, b.workDate, b.minutes);
      const id = (await db.query<{ id: string }>(`INSERT INTO overtime_claims (tenant_id, employee_id, work_date, minutes, recorded_minutes, payout, reason, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`, [a.tenantId, empId, b.workDate, b.minutes, day.overtime_minutes, b.payout, b.reason, a.user.userId])).rows[0]?.id;
      if (!id) throw conflict('You already have a claim for this day');
      const mgr = (await db.query<{ user_id: string | null; name: string }>(`SELECT m.user_id, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name FROM employees e
        LEFT JOIN employees m ON m.tenant_id=e.tenant_id AND m.id=e.reporting_manager_id WHERE e.tenant_id=$1 AND e.id=$2`, [a.tenantId, empId])).rows[0]!;
      // The manager confirms the work was needed and done; HR checks it against policy and the limits.
      const steps: StepSpec[] = [];
      if (mgr.user_id && mgr.user_id !== a.user.userId) steps.push({ kind: 'user', userId: mgr.user_id });
      steps.push({ kind: 'permission', permission: 'overtime.approve' });
      const h = Math.round((b.minutes / 60) * 100) / 100;
      const approvalId = await createApprovalRequest(db, a.tenantId, { entityType: 'overtime_claim', entityId: id, requesterId: a.user.userId,
        summary: `${mgr.name}: ${h} h overtime on ${b.workDate} (${b.payout === 'pay' ? 'paid' : 'compensatory off'})`, steps, excludeUserIds: [a.user.userId] });
      await audit(db, { ...a.auditBase, action: 'overtime.claimed', targetType: 'overtime_claim', targetId: id, metadata: { workDate: b.workDate, minutes: b.minutes, payout: b.payout, approvalId } });
      reply.code(201); return { id };
    });
  });

  app.get('/claims', async (req) => {
    const a = tenantActorAny(req, 'overtime.self', 'overtime.team.read', 'overtime.read', 'overtime.approve', 'overtime.manage');
    const q = PageQuery.extend({ scope: z.enum(['mine', 'team', 'all']).default('mine'), status: z.enum(['pending', 'approved', 'rejected', 'returned', 'cancelled']).optional(),
      period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }).parse(req.query);
    return a.tx(async (db) => {
      let ids: string[] | null;
      if (q.scope === 'all') { if (!(a.has('overtime.read') || a.has('overtime.approve') || a.has('overtime.manage'))) throw forbidden(); ids = null; }
      else if (q.scope === 'team') ids = a.user.employeeId && a.has('overtime.team.read') ? await teamEmployeeIds(db, a.tenantId, a.user.employeeId) : [];
      else ids = a.user.employeeId ? [a.user.employeeId] : [];
      const where = `c.tenant_id=$1 AND ($2::uuid[] IS NULL OR c.employee_id = ANY($2)) AND ($3::text IS NULL OR c.status=$3) AND ($4::text IS NULL OR to_char(c.work_date,'YYYY-MM')=$4)`;
      const args = [a.tenantId, ids, q.status ?? null, q.period ?? null];
      const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM overtime_claims c WHERE ${where}`, args)).rows[0]!.n);
      const sums = (await db.query<{ status: string; minutes: string }>(`SELECT status, sum(minutes)::text AS minutes FROM overtime_claims c WHERE ${where} GROUP BY status`, args)).rows;
      const rows = (await db.query(`SELECT ${CLAIM_COLS} FROM ${CLAIM_FROM} WHERE ${where} ORDER BY c.work_date DESC, e.employee_code LIMIT ${q.pageSize} OFFSET ${offsetOf(q)}`, args)).rows;
      return { ...paged(rows, total, q), minutesByStatus: Object.fromEntries(sums.map((s) => [s.status, Number(s.minutes)])) };
    });
  });

  app.get('/claims/:id', async (req) => {
    const a = tenantActor(req);
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      await loadClaim(db, a, id);
      return (await db.query(`SELECT ${CLAIM_COLS} FROM ${CLAIM_FROM} WHERE c.tenant_id=$1 AND c.id=$2`, [a.tenantId, id])).rows[0];
    });
  });

  /** The claimant takes back a claim still awaiting approval. */
  app.post('/claims/:id/withdraw', async (req) => {
    const a = tenantActor(req, 'overtime.self');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      const c = await loadClaim(db, a, id, true);
      if (c.employee_id !== a.user.employeeId) throw forbidden('Only the claimant can withdraw this claim');
      if (c.status !== 'pending') throw conflict(`This claim is ${c.status}`);
      const r = (await db.query<{ id: string }>(`SELECT id FROM approval_requests WHERE tenant_id=$1 AND entity_type='overtime_claim' AND entity_id=$2 AND status='pending'`, [a.tenantId, id])).rows[0];
      if (r) await cancelRequest(db, a.tenantId, r.id, a.user.userId, { requestId: a.auditBase.requestId, ip: a.auditBase.ip });
      else await db.query(`UPDATE overtime_claims SET status='cancelled', cancelled_by=$3 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, a.user.userId]);
      await audit(db, { ...a.auditBase, action: 'overtime.withdrawn', targetType: 'overtime_claim', targetId: id });
      return { ok: true };
    });
  });

  /**
   * HR cancels an approved claim (e.g. recorded in error). Paid overtime: only before its payroll run is submitted;
   * a computed run goes back to draft so it must be recomputed. Compensatory off: the days are taken back if unused.
   */
  app.post('/claims/:id/cancel', async (req) => {
    const a = tenantActor(req, 'overtime.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
    return a.tx(async (db) => {
      const c = await loadClaim(db, a, id, true);
      if (c.status !== 'approved') throw conflict(`Only approved claims can be cancelled here (this one is ${c.status})`);
      if (c.employee_id === a.user.employeeId) throw forbidden('You cannot cancel your own overtime');
      let rerun: string | null = null;
      if (c.payout === 'pay' && c.payroll_run_id) {
        const run = (await db.query<{ status: string; period: string }>(`SELECT status, period FROM payroll_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [a.tenantId, c.payroll_run_id])).rows[0]!;
        if (!['draft', 'computed', 'cancelled'].includes(run.status)) throw conflict(`Already in the ${run.period} payroll run (${run.status}); correct it with a deduction in a later run`);
        if (run.status === 'computed') { await db.query(`UPDATE payroll_runs SET status='draft' WHERE tenant_id=$1 AND id=$2`, [a.tenantId, c.payroll_run_id]); rerun = run.period; }
      }
      if (c.payout === 'comp_off' && c.comp_off_days) {
        const ledger = (await db.query<{ leave_type_id: string; leave_year: number }>(`SELECT leave_type_id, leave_year FROM leave_ledger WHERE tenant_id=$1 AND reference=$2`,
          [a.tenantId, `overtime:${id}:credit`])).rows[0];
        if (ledger) {
          const bal = await balanceOf(db, a.tenantId, c.employee_id, ledger.leave_type_id, ledger.leave_year);
          if (bal.available.lessThan(c.comp_off_days)) throw conflict(`The compensatory off has already been used or applied for (${bal.available.toFixed(1)} days available)`);
          await insertLedgerEntry(db, a.tenantId, { empId: c.employee_id, typeId: ledger.leave_type_id, year: ledger.leave_year, entryType: 'reversal',
            days: new Decimal(c.comp_off_days).neg(), reference: `overtime:${id}:reverse`, note: `Overtime claim for ${c.work_date} cancelled`, actorId: a.user.userId });
        }
      }
      await db.query(`UPDATE overtime_claims SET status='cancelled', cancelled_by=$3, cancel_reason=$4, payroll_run_id=NULL WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, a.user.userId, reason]);
      await audit(db, { ...a.auditBase, action: 'overtime.cancelled', targetType: 'overtime_claim', targetId: id, metadata: { reason, payout: c.payout, minutes: c.minutes, payrollRunReset: rerun } });
      return { ok: true, payrollRunToRecompute: rerun };
    });
  });
}
