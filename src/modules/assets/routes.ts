import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantActor, requireFeature } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { badRequest, conflict, notFound } from '../../core/http/errors.js';
import { IsoDate, PageQuery, offsetOf, paged, Uuid } from '../../core/http/pagination.js';
import { notifyUsers, usersWithPermission } from '../../core/notify/service.js';
import { orgToday } from '../competency/service.js';
import type { Db } from '../../db/tx.js';

const F = 'assets';
const CATEGORIES = ['lab_instrument', 'it', 'ppe', 'vehicle', 'furniture', 'tool', 'other'] as const;
const Text = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => v || null);
const AssetBody = z.object({
  tag: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,39}$/), name: z.string().trim().min(2).max(150), category: z.enum(CATEGORIES),
  serialNumber: Text(100), branchId: Uuid.nullable().default(null), purchaseDate: IsoDate.nullable().default(null), calibrationDue: IsoDate.nullable().default(null), notes: Text(1000),
  status: z.enum(['available', 'in_repair', 'retired']).optional(),
});

/** Open assignments of an employee (used by exit clearance). */
export async function openAssets(db: Db, tenantId: string, employeeId: string) {
  return (await db.query<{ tag: string; name: string }>(`SELECT a.tag, a.name FROM asset_assignments s JOIN assets a ON a.tenant_id=s.tenant_id AND a.id=s.asset_id
    WHERE s.tenant_id=$1 AND s.employee_id=$2 AND s.returned_at IS NULL ORDER BY a.tag`, [tenantId, employeeId])).rows;
}

export async function assetRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    const a = tenantActor(req, 'assets.manage');
    const q = PageQuery.extend({ search: z.string().trim().max(100).optional(), status: z.string().max(20).optional(), category: z.enum(CATEGORIES).optional(), calibrationWithinDays: z.coerce.number().int().min(0).max(365).optional() }).parse(req.query);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, F);
      const today = await orgToday(db, a.tenantId);
      const where = `a.tenant_id=$1 AND ($2::text IS NULL OR a.tag ILIKE '%'||$2||'%' OR a.name ILIKE '%'||$2||'%' OR a.serial_number ILIKE '%'||$2||'%') AND ($3::text IS NULL OR a.status=$3)
        AND ($4::text IS NULL OR a.category=$4) AND ($5::int IS NULL OR (a.calibration_due IS NOT NULL AND a.calibration_due <= $6::date + $5::int))`;
      const args = [a.tenantId, q.search || null, q.status ?? null, q.category ?? null, q.calibrationWithinDays ?? null, today];
      const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM assets a WHERE ${where}`, args)).rows[0]!.n);
      const rows = (await db.query(`SELECT a.id, a.tag, a.name, a.category, a.serial_number, a.status, a.purchase_date::text, a.calibration_due::text, a.notes, a.branch_id, b.name AS branch_name,
          s.employee_id AS holder_id, trim(e.first_name||' '||coalesce(e.last_name,'')) AS holder_name, s.issued_at::text, s.due_back::text, s.acknowledged_at
        FROM assets a LEFT JOIN branches b ON b.tenant_id=a.tenant_id AND b.id=a.branch_id
        LEFT JOIN asset_assignments s ON s.tenant_id=a.tenant_id AND s.asset_id=a.id AND s.returned_at IS NULL LEFT JOIN employees e ON e.tenant_id=s.tenant_id AND e.id=s.employee_id
        WHERE ${where} ORDER BY a.tag LIMIT ${q.pageSize} OFFSET ${offsetOf(q)}`, args)).rows;
      return { ...paged(rows, total, q), today };
    });
  });

  app.post('/', async (req, reply) => {
    const a = tenantActor(req, 'assets.manage');
    const b = AssetBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, F);
      const id = (await db.query<{ id: string }>(`INSERT INTO assets (tenant_id, tag, name, category, serial_number, branch_id, purchase_date, calibration_due, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [a.tenantId, b.tag, b.name, b.category, b.serialNumber, b.branchId, b.purchaseDate, b.calibrationDue, b.notes])).rows[0]!.id;
      await audit(db, { ...a.auditBase, action: 'assets.created', targetType: 'asset', targetId: id, metadata: b });
      reply.code(201); return { id };
    });
  });
  app.put('/:id', async (req) => {
    const a = tenantActor(req, 'assets.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const b = AssetBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, F);
      const cur = (await db.query<{ status: string }>('SELECT status FROM assets WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id])).rows[0];
      if (!cur) throw notFound();
      if (b.status && cur.status === 'assigned') throw conflict('Receive the asset back before changing its status');
      await db.query(`UPDATE assets SET tag=$3, name=$4, category=$5, serial_number=$6, branch_id=$7, purchase_date=$8, calibration_due=$9, notes=$10, status=coalesce($11, status) WHERE tenant_id=$1 AND id=$2`,
        [a.tenantId, id, b.tag, b.name, b.category, b.serialNumber, b.branchId, b.purchaseDate, b.calibrationDue, b.notes, b.status ?? null]);
      await audit(db, { ...a.auditBase, action: 'assets.updated', targetType: 'asset', targetId: id, metadata: b });
      return { ok: true };
    });
  });

  app.get('/:id/history', async (req) => {
    const a = tenantActor(req, 'assets.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => ({ items: (await db.query(`SELECT s.id, trim(e.first_name||' '||coalesce(e.last_name,'')) AS employee_name, e.employee_code, s.issued_at::text, s.condition_out, s.due_back::text,
        s.returned_at::text, s.condition_in, s.outcome, s.acknowledged_at, iu.display_name AS issued_by_name, ru.display_name AS received_by_name
      FROM asset_assignments s JOIN employees e ON e.tenant_id=s.tenant_id AND e.id=s.employee_id JOIN users iu ON iu.id=s.issued_by LEFT JOIN users ru ON ru.id=s.received_by
      WHERE s.tenant_id=$1 AND s.asset_id=$2 ORDER BY s.issued_at DESC`, [a.tenantId, id])).rows }));
  });

  app.post('/:id/issue', async (req) => {
    const a = tenantActor(req, 'assets.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const b = z.object({ employeeId: Uuid, issuedAt: IsoDate, conditionOut: Text(300), dueBack: IsoDate.nullable().default(null) }).parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, F);
      const as = (await db.query<{ status: string; tag: string; name: string; category: string; calibration_due: string | null }>('SELECT status, tag, name, category, calibration_due::text FROM assets WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id])).rows[0];
      if (!as) throw notFound('Asset not found');
      if (as.status !== 'available') throw conflict(`The asset is ${as.status}`);
      const today = await orgToday(db, a.tenantId);
      if (as.category === 'lab_instrument' && as.calibration_due && as.calibration_due < today) throw conflict(`Calibration expired on ${as.calibration_due}; calibrate before issuing`);
      const e = (await db.query<{ user_id: string | null; status: string }>('SELECT user_id, status FROM employees WHERE tenant_id=$1 AND id=$2', [a.tenantId, b.employeeId])).rows[0];
      if (!e) throw notFound('Employee not found');
      if (!['active', 'pre_joining', 'on_notice'].includes(e.status)) throw conflict(`Employee is ${e.status}`);
      if (b.dueBack && b.dueBack < b.issuedAt) throw badRequest('Due back must be after issue');
      await db.query(`INSERT INTO asset_assignments (tenant_id, asset_id, employee_id, issued_at, issued_by, condition_out, due_back) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [a.tenantId, id, b.employeeId, b.issuedAt, a.user.userId, b.conditionOut, b.dueBack]);
      await db.query(`UPDATE assets SET status='assigned' WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
      if (e.user_id) await notifyUsers(db, a.tenantId, [e.user_id], { kind: 'assets.issued', title: `${as.name} (${as.tag}) issued to you`, body: 'Confirm that you received it.', link: '/assets', actionLabel: 'Confirm' });
      await audit(db, { ...a.auditBase, action: 'assets.issued', targetType: 'asset', targetId: id, metadata: b });
      return { ok: true };
    });
  });

  app.post('/:id/receive', async (req) => {
    const a = tenantActor(req, 'assets.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const b = z.object({ returnedAt: IsoDate, outcome: z.enum(['returned', 'lost', 'damaged']), conditionIn: Text(500) }).parse(req.body);
    return a.tx(async (db) => {
      const s = (await db.query<{ id: string; issued_at: string }>(`SELECT id, issued_at::text FROM asset_assignments WHERE tenant_id=$1 AND asset_id=$2 AND returned_at IS NULL FOR UPDATE`, [a.tenantId, id])).rows[0];
      if (!s) throw conflict('The asset is not issued to anyone');
      if (b.returnedAt < s.issued_at) throw badRequest('Return date is before the issue date');
      if (b.outcome !== 'returned' && !b.conditionIn) throw badRequest('Describe what happened');
      await db.query(`UPDATE asset_assignments SET returned_at=$3, outcome=$4, condition_in=$5, received_by=$6 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, s.id, b.returnedAt, b.outcome, b.conditionIn, a.user.userId]);
      await db.query(`UPDATE assets SET status=$3 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, b.outcome === 'returned' ? 'available' : b.outcome === 'lost' ? 'lost' : 'in_repair']);
      await audit(db, { ...a.auditBase, action: 'assets.received', targetType: 'asset', targetId: id, metadata: b });
      return { ok: true };
    });
  });

  app.get('/mine', async (req) => {
    const a = tenantActor(req, 'assets.self');
    if (!a.user.employeeId) return { items: [] };
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, F);
      return { items: (await db.query(`SELECT s.id, a.tag, a.name, a.category, a.serial_number, s.issued_at::text, s.due_back::text, s.condition_out, s.acknowledged_at
        FROM asset_assignments s JOIN assets a ON a.tenant_id=s.tenant_id AND a.id=s.asset_id WHERE s.tenant_id=$1 AND s.employee_id=$2 AND s.returned_at IS NULL ORDER BY s.issued_at DESC`, [a.tenantId, a.user.employeeId])).rows };
    });
  });
  app.post('/assignments/:id/acknowledge', async (req) => {
    const a = tenantActor(req, 'assets.self');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      const r = await db.query(`UPDATE asset_assignments SET acknowledged_at=now() WHERE tenant_id=$1 AND id=$2 AND employee_id=$3 AND returned_at IS NULL AND acknowledged_at IS NULL`, [a.tenantId, id, a.user.employeeId ?? null]);
      if (!r.rowCount) throw notFound('Assignment not found');
      await audit(db, { ...a.auditBase, action: 'assets.acknowledged', targetType: 'asset_assignment', targetId: id });
      return { ok: true };
    });
  });
}

/** Daily: calibration due in 30/7/0 days, and assets overdue for return (weekly). */
export async function assetsDaily(db: Db, tenantId: string, today: string) {
  const managers = await usersWithPermission(db, tenantId, 'assets.manage');
  let reminders = 0;
  const cal = (await db.query<{ id: string; tag: string; name: string; calibration_due: string; days: number }>(`SELECT id, tag, name, calibration_due::text, (calibration_due - $2::date) AS days FROM assets
    WHERE tenant_id=$1 AND status NOT IN ('retired','lost') AND calibration_due IS NOT NULL AND calibration_due - $2::date IN (30, 7, 0)`, [tenantId, today])).rows;
  for (const c of cal) reminders += (await notifyUsers(db, tenantId, managers, { kind: 'assets.calibration', title: `Calibration ${c.days ? `due in ${c.days} days` : 'due today'}: ${c.name} (${c.tag})`, body: `Due ${c.calibration_due}.`, link: '/assets?tab=register', dedupeKey: `cal:${c.id}:${c.days}` })).inApp;
  const over = (await db.query<{ id: string; tag: string; name: string; user_id: string | null }>(`SELECT s.id, a.tag, a.name, e.user_id FROM asset_assignments s JOIN assets a ON a.tenant_id=s.tenant_id AND a.id=s.asset_id
    JOIN employees e ON e.tenant_id=s.tenant_id AND e.id=s.employee_id WHERE s.tenant_id=$1 AND s.returned_at IS NULL AND s.due_back < $2::date AND ($2::date - s.due_back) % 7 = 1`, [tenantId, today])).rows;
  for (const o of over) reminders += (await notifyUsers(db, tenantId, o.user_id ? [o.user_id] : managers, { kind: 'assets.overdue', title: `Please return ${o.name} (${o.tag})`, body: 'It is past its return date.', link: '/assets', dedupeKey: `due:${o.id}:${today}` })).inApp;
  return { calibrationReminders: cal.length, overdue: over.length, notificationsCreated: reminders };
}
