import type { FastifyInstance } from 'fastify';
import * as R from '../../core/http/responses.js';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { tenantActor, tenantActorAny, gateFeatures, requireFeature, type TenantActor } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/errors.js';
import { PageQuery, offsetOf, paged, Uuid } from '../../core/http/pagination.js';
import { buildSteps, createApprovalRequest, registerApprovalHandler, cancelRequest, type ApprovalHandler } from '../../core/workflow/engine.js';
import { getSettingValue } from '../../core/settings/service.js';
import { notifyUsers } from '../../core/notify/service.js';
import { teamEmployeeIds } from '../attendance/service.js';
import { orgToday } from '../competency/service.js';
import { assertMayChangeSubject, l4RowFilter, auditL4, maskFields, policyViewer, readContext, subjectVisible, wantsReveal } from '../../core/policy/salary.js';
import { isCollapsedMode } from '../../core/policy/mode.js';
import { isOwnerRole } from '../../core/auth/permissions.js';
import { KIND_LABEL, balanceOf, closeRepaid, outstandingOf, installmentOf, KIND_FEATURE, enabledLoanKinds } from './service.js';
import { isModuleEnabled } from '../../core/features/state.js';
import type { Db } from '../../db/tx.js';
import { money } from '../../core/brand.js';

const READ_ALL = ['loans.read', 'loans.approve', 'loans.manage'];
const Period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
interface Loan {
  id: string;
  employee_id: string;
  kind: string;
  amount: string;
  status: string;
  created_by: string;
  user_id: string | null;
  name: string;
  skip_periods: string[];
  first_period: string;
  installments: number;
}

const COLS = `l.id, l.employee_id, l.kind, l.amount, l.installments, l.installment_amount, l.first_period, l.skip_periods, l.purpose, l.status, l.created_at, l.decided_at,
  l.disbursed_at, l.disbursement_reference, l.closed_at, l.cancel_reason, (l.created_by <> coalesce(e.user_id, '00000000-0000-0000-0000-000000000000'::uuid)) AS recorded_by_other,
  e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name, dp.name AS department,
  (SELECT ar.id FROM approval_requests ar WHERE ar.tenant_id=l.tenant_id AND ar.entity_type IN ('employee_loan','salary_advance') AND ar.entity_id=l.id ORDER BY ar.created_at DESC LIMIT 1) AS approval_request_id`;

/** Loans are L4 but stay plaintext, under access control. Purpose can say why someone needs the money, so it goes with the amounts. */
const LOAN_FIELDS = [
  'amount',
  'installment_amount',
  'outstanding',
  'purpose',
  'balance',
  'schedule',
  'recoveries',
  'installments',
  'first_period',
  'skip_periods',
  'disbursement_reference',
  'cancel_reason',
] as const;
const FROM = `employee_loans l JOIN employees e ON e.tenant_id=l.tenant_id AND e.id=l.employee_id LEFT JOIN departments dp ON dp.tenant_id=e.tenant_id AND dp.id=e.department_id`;

async function loadLoan(db: Db, a: TenantActor, id: string, lock = false): Promise<Loan> {
  const l = (
    await db.query<Loan>(
      `SELECT l.id, l.employee_id, l.kind, l.amount, l.status, l.created_by, l.skip_periods, l.first_period, l.installments, e.user_id,
      trim(e.first_name||' '||coalesce(e.last_name,'')) AS name FROM employee_loans l JOIN employees e ON e.tenant_id=l.tenant_id AND e.id=l.employee_id
     WHERE l.tenant_id=$1 AND l.id=$2${lock ? ' FOR UPDATE OF l' : ''}`,
      [a.tenantId, id],
    )
  ).rows[0];
  if (!l || !isModuleEnabled(KIND_FEATURE[l.kind]!)) throw notFound('Loan not found');
  if (l.employee_id === a.user.employeeId || l.created_by === a.user.userId) return l;
  const viewer = await policyViewer(db, a.tenantId, a.user);
  if (READ_ALL.some((p) => a.has(p)) && (await subjectVisible(db, a.tenantId, viewer, l.employee_id))) return l;
  if (a.has('loans.team.read') && a.user.employeeId && (await teamEmployeeIds(db, a.tenantId, a.user.employeeId)).includes(l.employee_id)) return l;
  const r = await db.query(
    `SELECT 1 FROM approval_requests r JOIN approval_steps s ON s.tenant_id=r.tenant_id AND s.request_id=r.id
    WHERE r.tenant_id=$1 AND r.entity_type IN ('employee_loan','salary_advance') AND r.entity_id=$2 AND (s.approver_user_id=$3 OR s.acted_by=$3)`,
    [a.tenantId, id, a.user.userId],
  );
  if (r.rowCount) return l;
  throw notFound('Loan not found');
}

/** The planned instalments from the first month, skipping deferred months, until the amount is covered. */
export function schedule(l: { amount: string; installment_amount: string; first_period: string; skip_periods: string[] }) {
  const out: { period: string; amount: string }[] = [];
  let left = new Decimal(l.amount);
  let [y, m] = l.first_period.split('-').map(Number) as [number, number];
  for (let guard = 0; left.gt(0) && guard < 240; guard++) {
    const p = `${y}-${String(m).padStart(2, '0')}`;
    if (!l.skip_periods.includes(p)) {
      const amt = Decimal.min(left, l.installment_amount);
      out.push({ period: p, amount: amt.toFixed(2) });
      left = left.minus(amt);
    }
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** Approval effects. Registered once at startup (core/runtime), whether or not the module's routes are. */
export function registerLoanApprovals() {
  const handler = (feature: string, label: string): ApprovalHandler => ({
    feature,
    label,
    requesterLink: '/loans',
    async onApproved(db, tenantId, id) {
      const r = await db.query(`UPDATE employee_loans SET status='approved', decided_at=now() WHERE tenant_id=$1 AND id=$2 AND status='pending'`, [tenantId, id]);
      if (!r.rowCount) throw conflict('This request is no longer pending');
    },
    async onRejected(db, tenantId, id, actorId, status) {
      await db.query(
        `UPDATE employee_loans SET status=$3, decided_at=now(), cancelled_by=CASE WHEN $3='cancelled' THEN $4::uuid END
        WHERE tenant_id=$1 AND id=$2 AND status='pending'`,
        [tenantId, id, status, actorId],
      );
    },
  });
  registerApprovalHandler('employee_loan', handler('loans', 'Loan'));
  registerApprovalHandler('salary_advance', handler('salary_advance', 'Salary advance'));
}

const RequestsBody = z.object({
  employeeId: Uuid.optional(),
  kind: z.enum(['salary_advance', 'loan']),
  amount: z.number().int('Whole rupees only').positive().max(99_99_999),
  installments: z.number().int().min(1).max(120),
  firstPeriod: Period,
  purpose: z.string().trim().min(3).max(1000),
});
const RequestsQuery = PageQuery.extend({
  scope: z.enum(['mine', 'team', 'all']).default('mine'),
  status: z.enum(['pending', 'approved', 'rejected', 'returned', 'cancelled', 'disbursed', 'closed']).optional(),
  kind: z.enum(['salary_advance', 'loan']).optional(),
});
const IdParams = z.object({ id: Uuid });
const RequestsDisburseBody = z.object({ reference: z.string().trim().min(3).max(100) });
const RequestsCancelBody = z.object({ reason: z.string().trim().min(3).max(500) });
const RequestsRepaymentBody = z.object({ amount: z.number().int('Whole rupees only').positive(), reference: z.string().trim().min(3).max(100) });
const RequestsDeferBody = z.object({ period: Period, reason: z.string().trim().min(3).max(300) });
export async function loanRoutes(app: FastifyInstance) {
  gateFeatures(app, 'loans', 'salary_advance');

  /** Apply for a salary advance or loan, or (loans.manage) record one for an employee; the manager and finance approve. */
  app.post('/requests', { schema: { response: { 201: R.PostLoansRequests201 }, body: RequestsBody }, config: { permAny: ['loans.self', 'loans.manage'] } }, async (req, reply) => {
    const a = tenantActorAny(req, 'loans.self', 'loans.manage');
    const b = RequestsBody.parse(req.body);
    const forOther = !!b.employeeId && b.employeeId !== a.user.employeeId;
    if (forOther && !a.has('loans.manage')) throw forbidden('You can apply only for yourself');
    if (!forOther && !a.has('loans.self')) throw forbidden();
    const empId = b.employeeId ?? a.user.employeeId;
    if (!empId) throw badRequest('Your account is not linked to an employee record');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, KIND_FEATURE[b.kind]!);
      if (forOther) await assertMayChangeSubject(db, a.tenantId, await policyViewer(db, a.tenantId, a.user), empId);
      const e = (
        await db.query<{ status: string; user_id: string | null; name: string; mgr_user: string | null }>(
          `SELECT e.status, e.user_id, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name, CASE WHEN m.status IN ('active','on_notice') THEN m.user_id END AS mgr_user
         FROM employees e LEFT JOIN employees m ON m.tenant_id=e.tenant_id AND m.id=e.reporting_manager_id WHERE e.tenant_id=$1 AND e.id=$2`,
          [a.tenantId, empId],
        )
      ).rows[0];
      if (!e) throw notFound('Employee not found');
      if (e.status !== 'active') throw conflict('Advances and loans are only for active employees (not on notice)');
      const adv = b.kind === 'salary_advance';
      const maxN = await getSettingValue<number>(db, a.tenantId, adv ? 'loans.advance_max_installments' : 'loans.max_installments');
      const maxAmt = await getSettingValue<number | null>(db, a.tenantId, adv ? 'loans.max_advance_amount' : 'loans.max_loan_amount');
      if (b.installments > maxN) throw badRequest(`${KIND_LABEL[b.kind]} can be recovered in at most ${maxN} instalment(s)`);
      if (maxAmt != null && b.amount > maxAmt) throw badRequest(`${KIND_LABEL[b.kind]} is limited to ${money(maxAmt)}`);
      const thisMonth = (await orgToday(db, a.tenantId)).slice(0, 7);
      if (b.firstPeriod < thisMonth) throw badRequest('Recovery cannot start in a past month');
      if (await getSettingValue<boolean>(db, a.tenantId, 'loans.one_at_a_time')) {
        const live = (
          await db.query<{ id: string }>(`SELECT id FROM employee_loans WHERE tenant_id=$1 AND employee_id=$2 AND kind=$3 AND status IN ('pending','approved','disbursed')`, [
            a.tenantId,
            empId,
            b.kind,
          ])
        ).rows[0];
        if (live) throw conflict(`There is already a ${KIND_LABEL[b.kind]!.toLowerCase()} in progress; it must be repaid first`);
      }
      const inst = installmentOf(b.amount, b.installments);
      const id = (
        await db.query<{ id: string }>(
          `INSERT INTO employee_loans (tenant_id, employee_id, kind, amount, installments, installment_amount, first_period, purpose, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [a.tenantId, empId, b.kind, b.amount, b.installments, inst, b.firstPeriod, b.purpose, a.user.userId],
        )
      ).rows[0]!.id;
      const steps = buildSteps({ requesterId: a.user.userId, subjectUserId: e.user_id, managerUserId: e.mgr_user, then: ['loans.approve'] });
      const approvalId = await createApprovalRequest(db, a.tenantId, {
        entityType: adv ? 'salary_advance' : 'employee_loan',
        entityId: id,
        requesterId: a.user.userId,
        summary: `${e.name}: ${KIND_LABEL[b.kind]!.toLowerCase()} request`,
        steps,
        excludeUserIds: [a.user.userId, e.user_id],
      });
      await audit(db, {
        ...a.auditBase,
        action: 'loans.requested',
        targetType: 'employee_loan',
        targetId: id,
        metadata: { employeeId: empId, kind: b.kind, fields: ['amount', 'installments', 'purpose'], onBehalf: forOther, approvalId },
      });
      reply.code(201);
      return { id, installmentAmount: inst };
    });
  });

  app.get(
    '/requests',
    { schema: { response: { 200: R.GetLoansRequests200 }, querystring: RequestsQuery }, config: { permAny: ['loans.self', 'loans.team.read'] } },
    async (req) => {
      const a = tenantActorAny(req, 'loans.self', 'loans.team.read', ...READ_ALL);
      const q = RequestsQuery.parse(req.query);
      return a.tx(async (db) => {
        let ids: string[] | null;
        if (q.scope === 'all') {
          if (!READ_ALL.some((p) => a.has(p))) throw forbidden();
          ids = null;
        } else if (q.scope === 'team') ids = a.user.employeeId && a.has('loans.team.read') ? await teamEmployeeIds(db, a.tenantId, a.user.employeeId) : [];
        else ids = a.user.employeeId ? [a.user.employeeId] : [];
        const v = await policyViewer(db, a.tenantId, a.user);
        // A manager's team list still shows that a request exists; its figures only with the setting, below their level. Anyone else's list is cut by level.
        const where = `l.tenant_id=$1 AND ($2::uuid[] IS NULL OR l.employee_id = ANY($2)) AND ($3::text IS NULL OR l.status=$3) AND ($4::text IS NULL OR l.kind=$4) AND l.kind = ANY($5)${q.scope === 'all' ? ` AND ${l4RowFilter(v, 'e')}` : ''}`;
        const args = [a.tenantId, ids, q.status ?? null, q.kind ?? null, enabledLoanKinds()];
        const total = Number(
          (await db.query<{ n: string }>(`SELECT count(*) AS n FROM employee_loans l JOIN employees e ON e.tenant_id=l.tenant_id AND e.id=l.employee_id WHERE ${where}`, args))
            .rows[0]!.n,
        );
        const rows = (
          await db.query<{ id: string; amount: string; employee_id: string; visible: boolean } & Record<string, unknown>>(
            `SELECT ${COLS}, ${l4RowFilter(v, 'e')} AS visible FROM ${FROM} WHERE ${where} ORDER BY l.created_at DESC LIMIT ${q.pageSize} OFFSET ${offsetOf(q)}`,
            args,
          )
        ).rows;
        const outstanding = await outstandingOf(db, a.tenantId, rows);
        const reveal = wantsReveal(req);
        const fields = LOAN_FIELDS.filter((f) => !['balance', 'schedule', 'recoveries'].includes(f));
        const shown = rows.filter((r) => reveal && r.visible);
        if (shown.length)
          await auditL4(
            db,
            readContext(req, a),
            'reveal',
            'loans.requests',
            [...new Set(shown.map((r) => r.employee_id))].map((employeeId) => ({ employeeId, fields })),
          );
        return paged(
          rows.map(({ visible, ...r }) => {
            const row = { ...r, outstanding: outstanding.get(r.id)! };
            return reveal && visible ? row : maskFields(row, fields);
          }),
          total,
          q,
        );
      });
    },
  );

  app.get('/requests/:id', { schema: { response: { 200: R.GetLoansRequestsById200 }, params: IdParams } }, async (req) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      const loan = await loadLoan(db, a, id);
      const v = await policyViewer(db, a.tenantId, a.user);
      const l = (await db.query(`SELECT ${COLS} FROM ${FROM} WHERE l.tenant_id=$1 AND l.id=$2`, [a.tenantId, id])).rows[0];
      const recoveries = (
        await db.query(
          `SELECT x.id, x.source, x.period, x.amount, x.reference, x.created_at, r.status AS run_status, r.kind AS run_kind
        FROM loan_recoveries x LEFT JOIN payroll_runs r ON r.tenant_id=x.tenant_id AND r.id=x.payroll_run_id
        WHERE x.tenant_id=$1 AND x.loan_id=$2 AND (x.source='repayment' OR r.status <> 'cancelled') ORDER BY coalesce(x.period, to_char(x.created_at,'YYYY-MM')), x.created_at`,
          [a.tenantId, id],
        )
      ).rows;
      const outstanding = (await outstandingOf(db, a.tenantId, [{ id, amount: loan.amount }])).get(id)!;
      const body = { ...l, outstanding, balance: await balanceOf(db, a.tenantId, id), schedule: schedule(l), recoveries };
      // Being on the approval chain lets a manager see that a request exists, not what it says: figures need the L4 rule.
      if (!wantsReveal(req) || !(await subjectVisible(db, a.tenantId, v, loan.employee_id))) return maskFields(body, LOAN_FIELDS);
      await auditL4(db, readContext(req, a), 'reveal', 'loans.request', [{ employeeId: loan.employee_id, fields: LOAN_FIELDS }]);
      return body;
    });
  });

  app.post('/requests/:id/withdraw', { schema: { response: { 200: R.PostLoansRequestsByIdWithdraw200 }, params: IdParams } }, async (req) => {
    const a = tenantActor(req);
    const { id } = IdParams.parse(req.params);
    return a.tx(async (db) => {
      const l = await loadLoan(db, a, id, true);
      if (l.employee_id !== a.user.employeeId && l.created_by !== a.user.userId) throw forbidden('Only the employee or whoever recorded it can withdraw this request');
      if (l.status !== 'pending') throw conflict(`This request is ${l.status}`);
      const r = (
        await db.query<{ id: string }>(
          `SELECT id FROM approval_requests WHERE tenant_id=$1 AND entity_type IN ('employee_loan','salary_advance') AND entity_id=$2 AND status='pending'`,
          [a.tenantId, id],
        )
      ).rows[0];
      if (r)
        await cancelRequest(
          db,
          a.tenantId,
          r.id,
          a.user.userId,
          { requestId: a.auditBase.requestId, ip: a.auditBase.ip },
          { subjectMayWithdraw: l.employee_id === a.user.employeeId },
        );
      else await db.query(`UPDATE employee_loans SET status='cancelled', cancelled_by=$3 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, a.user.userId]);
      await audit(db, { ...a.auditBase, action: 'loans.withdrawn', targetType: 'employee_loan', targetId: id });
      return { ok: true };
    });
  });

  /** Payroll records the money paid out; recovery then starts in the first month. Never your own. */
  app.post(
    '/requests/:id/disburse',
    { schema: { response: { 200: R.PostLoansRequestsByIdDisburse200 }, params: IdParams, body: RequestsDisburseBody }, config: { perm: ['loans.manage'] } },
    async (req) => {
      const a = tenantActor(req, 'loans.manage');
      const { id } = IdParams.parse(req.params);
      const b = RequestsDisburseBody.parse(req.body);
      return a.tx(async (db) => {
        const l = await loadLoan(db, a, id, true);
        if (l.employee_id === a.user.employeeId && !(isCollapsedMode() && a.user.roles.some(isOwnerRole))) throw forbidden('You cannot disburse your own advance or loan');
        await assertMayChangeSubject(db, a.tenantId, await policyViewer(db, a.tenantId, a.user), l.employee_id);
        if (l.status !== 'approved') throw conflict(`Only an approved request can be disbursed (this one is ${l.status})`);
        await db.query(`UPDATE employee_loans SET status='disbursed', disbursed_at=now(), disbursed_by=$3, disbursement_reference=$4 WHERE tenant_id=$1 AND id=$2`, [
          a.tenantId,
          id,
          a.user.userId,
          b.reference,
        ]);
        if (l.user_id)
          await notifyUsers(db, a.tenantId, [l.user_id], {
            kind: 'loans.disbursed',
            feature: KIND_FEATURE[l.kind],
            title: `${KIND_LABEL[l.kind]} paid`,
            body: `Recovered through payroll from ${l.first_period}. Reference ${b.reference}`,
            link: '/loans',
          });
        await audit(db, { ...a.auditBase, action: 'loans.disbursed', targetType: 'employee_loan', targetId: id, metadata: { reference: b.reference } });
        return { ok: true };
      });
    },
  );

  /** Approved but not paid out: payroll or finance cancels it. */
  app.post(
    '/requests/:id/cancel',
    { schema: { response: { 200: R.PostLoansRequestsByIdCancel200 }, params: IdParams, body: RequestsCancelBody }, config: { permAny: ['loans.manage', 'loans.approve'] } },
    async (req) => {
      const a = tenantActorAny(req, 'loans.manage', 'loans.approve');
      const { id } = IdParams.parse(req.params);
      const { reason } = RequestsCancelBody.parse(req.body);
      return a.tx(async (db) => {
        const l = await loadLoan(db, a, id, true);
        await assertMayChangeSubject(db, a.tenantId, await policyViewer(db, a.tenantId, a.user), l.employee_id);
        if (l.status !== 'approved') throw conflict(`Only an approved, not yet paid request can be cancelled (this one is ${l.status})`);
        await db.query(`UPDATE employee_loans SET status='cancelled', cancelled_by=$3, cancel_reason=$4 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, a.user.userId, reason]);
        await audit(db, { ...a.auditBase, action: 'loans.cancelled', targetType: 'employee_loan', targetId: id, metadata: { reason } });
        return { ok: true };
      });
    },
  );

  /** The employee pays back directly (all or part); later instalments shrink accordingly. */
  app.post(
    '/requests/:id/repayment',
    { schema: { response: { 200: R.PostLoansRequestsByIdRepayment200 }, params: IdParams, body: RequestsRepaymentBody }, config: { perm: ['loans.manage'] } },
    async (req) => {
      const a = tenantActor(req, 'loans.manage');
      const { id } = IdParams.parse(req.params);
      const b = RequestsRepaymentBody.parse(req.body);
      return a.tx(async (db) => {
        const l = await loadLoan(db, a, id, true);
        if (l.employee_id === a.user.employeeId && !(isCollapsedMode() && a.user.roles.some(isOwnerRole))) throw forbidden('You cannot record a repayment of your own loan');
        await assertMayChangeSubject(db, a.tenantId, await policyViewer(db, a.tenantId, a.user), l.employee_id);
        if (l.status !== 'disbursed') throw conflict(`Repayments are recorded against a disbursed loan (this one is ${l.status})`);
        const bal = await balanceOf(db, a.tenantId, id);
        if (new Decimal(b.amount).gt(bal.outstanding))
          throw badRequest(
            `That is more than is outstanding on this ${KIND_LABEL[l.kind]!.toLowerCase()}${new Decimal(bal.inProgress).gt(0) ? ' (part of it is in a payroll run being processed)' : ''}`,
          );
        await db.query(`INSERT INTO loan_recoveries (tenant_id, loan_id, source, amount, reference, recorded_by) VALUES ($1,$2,'repayment',$3,$4,$5)`, [
          a.tenantId,
          id,
          b.amount,
          b.reference,
          a.user.userId,
        ]);
        const closed = await closeRepaid(db, a.tenantId, [l.employee_id]);
        await audit(db, { ...a.auditBase, action: 'loans.repaid', targetType: 'employee_loan', targetId: id, metadata: { reference: b.reference, fields: ['amount'] } });
        return { ok: true, closed: closed > 0 };
      });
    },
  );

  /** Skip a month's instalment (e.g. hardship, or a month with little pay); the schedule moves out by a month. */
  app.post(
    '/requests/:id/defer',
    { schema: { response: { 200: R.PostLoansRequestsByIdDefer200 }, params: IdParams, body: RequestsDeferBody }, config: { perm: ['loans.manage'] } },
    async (req) => {
      const a = tenantActor(req, 'loans.manage');
      const { id } = IdParams.parse(req.params);
      const b = RequestsDeferBody.parse(req.body);
      return a.tx(async (db) => {
        const l = await loadLoan(db, a, id, true);
        if (l.employee_id === a.user.employeeId && !(isCollapsedMode() && a.user.roles.some(isOwnerRole))) throw forbidden('You cannot defer your own recovery');
        await assertMayChangeSubject(db, a.tenantId, await policyViewer(db, a.tenantId, a.user), l.employee_id);
        if (!['approved', 'disbursed'].includes(l.status)) throw conflict(`The ${KIND_LABEL[l.kind]!.toLowerCase()} is ${l.status}`);
        if (l.skip_periods.includes(b.period)) throw conflict(`${b.period} is already deferred`);
        if (b.period < (await orgToday(db, a.tenantId)).slice(0, 7)) throw badRequest('A past month cannot be deferred');
        const inRun = await db.query(
          `SELECT 1 FROM loan_recoveries x JOIN payroll_runs r ON r.tenant_id=x.tenant_id AND r.id=x.payroll_run_id
        WHERE x.tenant_id=$1 AND x.loan_id=$2 AND x.period=$3 AND r.status NOT IN ('draft','computed','cancelled')`,
          [a.tenantId, id, b.period],
        );
        if (inRun.rowCount) throw conflict(`The ${b.period} instalment is already in a payroll run that is approved or final`);
        await db.query(`UPDATE employee_loans SET skip_periods=array_append(skip_periods, $3) WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, b.period]);
        await audit(db, { ...a.auditBase, action: 'loans.deferred', targetType: 'employee_loan', targetId: id, metadata: b });
        return {
          ok: true,
          recomputePayroll: (await db.query(`SELECT 1 FROM loan_recoveries WHERE tenant_id=$1 AND loan_id=$2 AND period=$3`, [a.tenantId, id, b.period])).rowCount
            ? b.period
            : null,
        };
      });
    },
  );
}
