import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { tenantActor, requireFeature, type TenantActor } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../core/http/errors.js';
import { IsoDate, PageQuery, offsetOf, paged, Uuid } from '../../core/http/pagination.js';
import { getStore, newKey } from '../../core/storage/index.js';
import { detectFile, safeFileName } from '../../core/storage/sniff.js';
import { notifyUsers } from '../../core/notify/service.js';
import { orgToday } from '../competency/service.js';
import type { Db } from '../../db/tx.js';

const FEATURE = 'core.policies';
export const CATEGORIES = ['hr', 'code_of_conduct', 'posh', 'safety', 'quality', 'it_security', 'data_protection', 'other'] as const;
const PolicyBody = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_-]{0,29}$/), title: z.string().trim().min(3).max(200),
  category: z.enum(CATEGORIES), owner: z.string().trim().max(80).nullable().optional().transform((v) => v || null),
});
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const contentHash = (body: string | null, fileSha: string | null) => sha(`body:${body ?? ''}\nfile:${fileSha ?? ''}`);

/** SQL predicate: employee `e` is in the audience of version `v` (active staff only). */
export const AUDIENCE_SQL = `e.status IN ('active','on_notice')
  AND (cardinality(v.audience_branch_ids)=0 OR e.branch_id = ANY(v.audience_branch_ids))
  AND (cardinality(v.audience_department_ids)=0 OR e.department_id = ANY(v.audience_department_ids))`;

interface VersionRow {
  id: string; policy_id: string; version_no: number; status: string; body: string | null; file_key: string | null; file_name: string | null; file_sha256: string | null;
  content_sha256: string; requires_ack: boolean; created_by: string; code: string; title: string; policy_status: string; published_at: string | null; ack_due_days: number;
}
async function loadVersion(db: Db, tenantId: string, id: string, lock = false) {
  return (await db.query<VersionRow>(`SELECT v.id, v.policy_id, v.version_no, v.status, v.body, v.file_key, v.file_name, v.file_sha256, v.content_sha256, v.requires_ack,
      v.created_by, p.code, p.title, p.status AS policy_status, v.published_at, v.ack_due_days
    FROM policy_versions v JOIN policies p ON p.tenant_id=v.tenant_id AND p.id=v.policy_id WHERE v.tenant_id=$1 AND v.id=$2${lock ? ' FOR UPDATE OF v' : ''}`, [tenantId, id])).rows[0];
}

/** Readers see everything; an employee sees a version that is published and applies to them, or one they acknowledged. */
async function canRead(db: Db, a: TenantActor, v: VersionRow) {
  if (a.has('policies.read') || a.has('policies.manage')) return true;
  if (!a.has('policies.self') || !a.user.employeeId) return false;
  const r = await db.query(`SELECT 1 FROM policy_versions v JOIN employees e ON e.tenant_id=v.tenant_id AND e.id=$3
      WHERE v.tenant_id=$1 AND v.id=$2 AND ((v.status='published' AND ${AUDIENCE_SQL})
        OR EXISTS (SELECT 1 FROM policy_acknowledgements k WHERE k.tenant_id=v.tenant_id AND k.version_id=v.id AND k.employee_id=e.id))`, [a.tenantId, v.id, a.user.employeeId]);
  return (r.rowCount ?? 0) > 0;
}

async function readMultipart(req: FastifyRequest, maxBytes: number) {
  let file: { buf: Buffer; name: string } | null = null;
  const fields: Record<string, string> = {};
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      if (file) throw badRequest('One file per version');
      const buf = await part.toBuffer().catch((e: { code?: string }) => {
        if (e.code === 'FST_REQ_FILE_TOO_LARGE') throw new AppError(413, 'file_too_large', `Files are limited to ${maxBytes / 1048576} MB`);
        throw e;
      });
      if (buf.length) file = { buf, name: part.filename || 'policy.pdf' };
    } else fields[part.fieldname] = String(part.value);
  }
  return { file, fields };
}
const idList = z.string().optional().transform((s, ctx) => {
  const ids = (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const id of ids) if (!Uuid.safeParse(id).success) { ctx.addIssue({ code: 'custom', message: 'Invalid id in list' }); return z.NEVER; }
  return [...new Set(ids)];
});

export async function policyRoutes(app: FastifyInstance) {
  const maxBytes = app.deps.env.STORAGE_MAX_FILE_MB * 1024 * 1024;

  // ------------------------------------------------------------ policies
  app.get('/', async (req) => {
    const a = tenantActor(req, 'policies.read');
    const q = z.object({ status: z.enum(['active', 'retired']).optional() }).parse(req.query);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const rows = (await db.query(`SELECT p.id, p.code, p.title, p.category, p.owner, p.status, p.created_at,
          v.id AS published_version_id, v.version_no AS published_version, v.effective_from::text, v.requires_ack, v.published_at,
          (SELECT count(*)::int FROM policy_versions d WHERE d.tenant_id=p.tenant_id AND d.policy_id=p.id AND d.status='draft') AS drafts,
          CASE WHEN v.id IS NULL THEN NULL ELSE (SELECT count(*)::int FROM employees e WHERE e.tenant_id=p.tenant_id AND ${AUDIENCE_SQL}) END AS audience,
          CASE WHEN v.id IS NULL THEN NULL ELSE (SELECT count(*)::int FROM policy_acknowledgements k JOIN employees e ON e.tenant_id=k.tenant_id AND e.id=k.employee_id
            WHERE k.tenant_id=p.tenant_id AND k.version_id=v.id AND ${AUDIENCE_SQL}) END AS acknowledged
        FROM policies p LEFT JOIN policy_versions v ON v.tenant_id=p.tenant_id AND v.policy_id=p.id AND v.status='published'
        WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.status=$2) ORDER BY p.status, p.category, p.code`, [a.tenantId, q.status ?? null])).rows;
      return { items: rows };
    });
  });

  app.post('/', async (req, reply) => {
    const a = tenantActor(req, 'policies.manage');
    const b = PolicyBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const id = (await db.query<{ id: string }>(`INSERT INTO policies (tenant_id, code, title, category, owner, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [a.tenantId, b.code, b.title, b.category, b.owner, a.user.userId])).rows[0]!.id;
      await audit(db, { ...a.auditBase, action: 'policies.created', category: 'configuration', targetType: 'policy', targetId: id, metadata: b });
      return reply.code(201).send({ id });
    });
  });

  app.put('/:id', async (req) => {
    const a = tenantActor(req, 'policies.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const b = PolicyBody.omit({ code: true }).parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const r = await db.query(`UPDATE policies SET title=$3, category=$4, owner=$5 WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, b.title, b.category, b.owner]);
      if (!r.rowCount) throw notFound('Policy not found');
      await audit(db, { ...a.auditBase, action: 'policies.updated', category: 'configuration', targetType: 'policy', targetId: id, metadata: b });
      return { ok: true };
    });
  });

  /** Retiring withdraws the published version; history and acknowledgements are kept. */
  app.post('/:id/retire', async (req) => {
    const a = tenantActor(req, 'policies.publish');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const r = await db.query(`UPDATE policies SET status='retired' WHERE tenant_id=$1 AND id=$2 AND status='active'`, [a.tenantId, id]);
      if (!r.rowCount) throw notFound('Active policy not found');
      await db.query(`UPDATE policy_versions SET status='withdrawn' WHERE tenant_id=$1 AND policy_id=$2 AND status IN ('published','draft')`, [a.tenantId, id]);
      await audit(db, { ...a.auditBase, action: 'policies.retired', category: 'configuration', targetType: 'policy', targetId: id, metadata: { reason } });
      return { ok: true };
    });
  });

  app.get('/:id', async (req) => {
    const a = tenantActor(req, 'policies.read');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const p = (await db.query(`SELECT id, code, title, category, owner, status, created_at FROM policies WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id])).rows[0];
      if (!p) throw notFound('Policy not found');
      const versions = (await db.query(`SELECT v.id, v.version_no, v.status, v.change_summary, v.effective_from::text, v.requires_ack, v.ack_due_days, v.file_name, v.body IS NOT NULL AS has_body,
          v.audience_branch_ids, v.audience_department_ids, v.created_at, v.published_at, v.created_by, cu.display_name AS created_by_name, pu.display_name AS published_by_name,
          (SELECT count(*)::int FROM policy_acknowledgements k WHERE k.tenant_id=v.tenant_id AND k.version_id=v.id) AS acknowledgements
        FROM policy_versions v JOIN users cu ON cu.id=v.created_by LEFT JOIN users pu ON pu.id=v.published_by
        WHERE v.tenant_id=$1 AND v.policy_id=$2 ORDER BY v.version_no DESC`, [a.tenantId, id])).rows;
      return { ...p, versions };
    });
  });

  // ------------------------------------------------------------ versions
  /** multipart/form-data: changeSummary, effectiveFrom, body?, requiresAck?, ackDueDays?, audienceBranchIds?, audienceDepartmentIds?, file? (PDF) */
  app.post('/:id/versions', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const a = tenantActor(req, 'policies.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    if (!req.isMultipart()) throw badRequest('Upload as multipart/form-data');
    const { file, fields } = await readMultipart(req, maxBytes);
    const b = z.object({
      changeSummary: z.string().trim().min(3).max(1000), effectiveFrom: IsoDate, body: z.string().trim().max(100000).optional().transform((v) => v || null),
      requiresAck: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'), ackDueDays: z.coerce.number().int().min(1).max(180).default(14),
      audienceBranchIds: idList, audienceDepartmentIds: idList,
    }).parse(fields);
    if (!b.body && !file) throw badRequest('Add the policy text, a PDF, or both');
    let detected: { contentType: string; ext: string } | null = null;
    if (file) {
      if (file.buf.length > maxBytes) throw new AppError(413, 'file_too_large', `Files are limited to ${app.deps.env.STORAGE_MAX_FILE_MB} MB`);
      const d = detectFile(file.buf, file.name);
      if ('error' in d) throw new AppError(415, 'unsupported_file', d.error);
      if (d.contentType !== 'application/pdf') throw new AppError(415, 'unsupported_file', 'Policy files must be PDF');
      detected = d;
    }
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const p = (await db.query<{ status: string }>('SELECT status FROM policies WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id])).rows[0];
      if (!p) throw notFound('Policy not found');
      if (p.status !== 'active') throw conflict('This policy is retired');
      if ((await db.query(`SELECT 1 FROM policy_versions WHERE tenant_id=$1 AND policy_id=$2 AND status='draft'`, [a.tenantId, id])).rowCount) throw conflict('This policy already has a draft; publish or discard it first');
      for (const [table, ids] of [['branches', b.audienceBranchIds], ['departments', b.audienceDepartmentIds]] as const) {
        if (ids.length && Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE tenant_id=$1 AND id = ANY($2::uuid[])`, [a.tenantId, ids])).rows[0]!.n) !== ids.length)
          throw badRequest(`Unknown ${table === 'branches' ? 'branch' : 'department'} in audience`);
      }
      let key: string | null = null; let fileSha: string | null = null;
      if (file) {
        const store = getStore();
        if (!store) throw new AppError(503, 'storage_unavailable', 'File storage is not configured; add the policy as text instead');
        key = newKey(a.tenantId, null, 'policies');
        await store.put(key, file.buf, detected!.contentType);
        fileSha = sha(file.buf);
      }
      const no = (await db.query<{ n: number }>('SELECT coalesce(max(version_no),0)+1 AS n FROM policy_versions WHERE tenant_id=$1 AND policy_id=$2', [a.tenantId, id])).rows[0]!.n;
      const vid = (await db.query<{ id: string }>(`INSERT INTO policy_versions (tenant_id, policy_id, version_no, change_summary, body, file_key, file_name, file_sha256, file_size, content_sha256,
          effective_from, requires_ack, ack_due_days, audience_branch_ids, audience_department_ids, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [a.tenantId, id, no, b.changeSummary, b.body, key, file ? safeFileName(file.name, 'pdf') : null, fileSha, file?.buf.length ?? null, contentHash(b.body, fileSha),
          b.effectiveFrom, b.requiresAck, b.ackDueDays, b.audienceBranchIds, b.audienceDepartmentIds, a.user.userId])).rows[0]!.id;
      await audit(db, { ...a.auditBase, action: 'policies.version_drafted', category: 'configuration', targetType: 'policy_version', targetId: vid,
        metadata: { policyId: id, versionNo: no, fileSha256: fileSha, hasBody: !!b.body, audienceBranches: b.audienceBranchIds.length, audienceDepartments: b.audienceDepartmentIds.length } });
      return reply.code(201).send({ id: vid, versionNo: no });
    });
  });

  app.post('/versions/:id/discard', async (req) => {
    const a = tenantActor(req, 'policies.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const r = await db.query(`UPDATE policy_versions SET status='withdrawn' WHERE tenant_id=$1 AND id=$2 AND status='draft'`, [a.tenantId, id]);
      if (!r.rowCount) throw notFound('Draft not found');
      await audit(db, { ...a.auditBase, action: 'policies.draft_discarded', category: 'configuration', targetType: 'policy_version', targetId: id });
      return { ok: true };
    });
  });

  app.post('/versions/:id/publish', async (req) => {
    const a = tenantActor(req, 'policies.publish');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const v = await loadVersion(db, a.tenantId, id, true);
      if (!v) throw notFound('Version not found');
      if (v.status !== 'draft') throw conflict(`A ${v.status} version cannot be published`);
      if (v.policy_status !== 'active') throw conflict('This policy is retired');
      if (v.created_by === a.user.userId) throw forbidden('A policy version must be published by someone other than its author');
      const prev = await db.query<{ id: string }>(`UPDATE policy_versions SET status='superseded' WHERE tenant_id=$1 AND policy_id=$2 AND status='published' RETURNING id`, [a.tenantId, v.policy_id]);
      await db.query(`UPDATE policy_versions SET status='published', published_by=$3, published_at=now() WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, a.user.userId]);
      const users = (await db.query<{ user_id: string }>(`SELECT e.user_id FROM employees e, policy_versions v WHERE e.tenant_id=$1 AND v.tenant_id=$1 AND v.id=$2 AND e.user_id IS NOT NULL AND ${AUDIENCE_SQL}`,
        [a.tenantId, id])).rows.map((r) => r.user_id);
      const r = await notifyUsers(db, a.tenantId, users, {
        kind: 'policies.published', title: `${v.requires_ack ? 'Please read and acknowledge' : 'Updated policy'}: ${v.title} (v${v.version_no})`,
        body: v.requires_ack ? `Acknowledge within ${v.ack_due_days} days.` : 'A new version has been published.', link: `/policies?version=${id}`, actionLabel: 'Read policy', dedupeKey: `policy-published:${id}`,
      });
      await audit(db, { ...a.auditBase, action: 'policies.published', category: 'configuration', targetType: 'policy_version', targetId: id,
        metadata: { policyId: v.policy_id, versionNo: v.version_no, superseded: prev.rows.map((x) => x.id), audience: users.length, contentSha256: v.content_sha256 } });
      return { ok: true, notified: r.inApp };
    });
  });

  app.post('/versions/:id/withdraw', async (req) => {
    const a = tenantActor(req, 'policies.publish');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const r = await db.query(`UPDATE policy_versions SET status='withdrawn' WHERE tenant_id=$1 AND id=$2 AND status='published'`, [a.tenantId, id]);
      if (!r.rowCount) throw notFound('Published version not found');
      await audit(db, { ...a.auditBase, action: 'policies.withdrawn', category: 'configuration', targetType: 'policy_version', targetId: id, metadata: { reason } });
      return { ok: true };
    });
  });

  app.get('/versions/:id', async (req) => {
    const a = tenantActor(req);
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const v = await loadVersion(db, a.tenantId, id);
      if (!v || !(await canRead(db, a, v))) throw notFound('Policy not found');
      const extra = (await db.query<{ change_summary: string; effective_from: string }>(`SELECT change_summary, effective_from::text FROM policy_versions WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id])).rows[0]!;
      const ack = a.user.employeeId ? (await db.query<{ acknowledged_at: string }>(`SELECT acknowledged_at FROM policy_acknowledgements WHERE tenant_id=$1 AND version_id=$2 AND employee_id=$3`,
        [a.tenantId, id, a.user.employeeId])).rows[0] : undefined;
      return { id: v.id, policyId: v.policy_id, code: v.code, title: v.title, versionNo: v.version_no, status: v.status, body: v.body, fileName: v.file_name, hasFile: !!v.file_key,
        contentSha256: v.content_sha256, requiresAck: v.requires_ack, changeSummary: extra.change_summary, effectiveFrom: extra.effective_from, publishedAt: v.published_at,
        acknowledgedAt: ack?.acknowledged_at ?? null };
    });
  });

  app.get('/versions/:id/file', async (req, reply) => {
    const a = tenantActor(req);
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const v = await a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const v = await loadVersion(db, a.tenantId, id);
      if (!v || !v.file_key || !(await canRead(db, a, v))) throw notFound('Policy file not found');
      return v;
    });
    const store = getStore();
    if (!store) throw new AppError(503, 'storage_unavailable', 'File storage is not configured');
    const buf = await store.get(v.file_key!);
    if (sha(buf) !== v.file_sha256) {
      req.log.error({ policyVersionId: id }, 'policy file integrity check failed');
      throw new AppError(500, 'integrity_failed', 'The stored file failed its integrity check. Contact your administrator.');
    }
    const q = z.object({ inline: z.coerce.boolean().default(false) }).parse(req.query);
    return reply.header('content-type', 'application/pdf')
      .header('content-disposition', `${q.inline ? 'inline' : 'attachment'}; filename="${v.file_name!.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(v.file_name!)}`)
      .header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff').send(buf);
  });

  /** The client sends back the content hash it displayed; a stale page (newer version published) is refused. */
  app.post('/versions/:id/acknowledge', async (req) => {
    const a = tenantActor(req, 'policies.self');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const { contentSha256 } = z.object({ contentSha256: z.string().regex(/^[0-9a-f]{64}$/) }).parse(req.body);
    if (!a.user.employeeId) throw badRequest('Your account is not linked to an employee record');
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const v = await loadVersion(db, a.tenantId, id);
      if (!v || !(await canRead(db, a, v))) throw notFound('Policy not found');
      if (v.status !== 'published') throw conflict('This version is no longer current; open the latest version');
      if (!v.requires_ack) throw conflict('This policy does not need an acknowledgement');
      if (contentSha256 !== v.content_sha256) throw conflict('The policy changed since you opened it; reload and read it again');
      const ua = String(req.headers['user-agent'] ?? '').slice(0, 300);
      const r = await db.query<{ acknowledged_at: string }>(`INSERT INTO policy_acknowledgements (tenant_id, version_id, employee_id, user_id, content_sha256, ip, user_agent)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id, version_id, employee_id) DO NOTHING RETURNING acknowledged_at`,
        [a.tenantId, id, a.user.employeeId, a.user.userId, v.content_sha256, req.ctx.ip, ua]);
      if (r.rowCount) await audit(db, { ...a.auditBase, action: 'policies.acknowledged', category: 'data', targetType: 'policy_version', targetId: id, metadata: { contentSha256: v.content_sha256 } });
      const at = r.rows[0]?.acknowledged_at ?? (await db.query<{ acknowledged_at: string }>(`SELECT acknowledged_at FROM policy_acknowledgements WHERE tenant_id=$1 AND version_id=$2 AND employee_id=$3`,
        [a.tenantId, id, a.user.employeeId])).rows[0]!.acknowledged_at;
      return { ok: true, acknowledgedAt: at, alreadyAcknowledged: !r.rowCount };
    });
  });

  /** Current policies that apply to me, with acknowledgement status. */
  app.get('/mine', async (req) => {
    const a = tenantActor(req, 'policies.self');
    if (!a.user.employeeId) return { items: [], pending: 0 };
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const today = await orgToday(db, a.tenantId);
      const items = (await db.query<{ acknowledged_at: string | null; requires_ack: boolean; due_on: string }>(`SELECT v.id, p.code, p.title, p.category, v.version_no, v.effective_from::text, v.requires_ack,
          v.change_summary, v.published_at, ((v.published_at AT TIME ZONE t.timezone)::date + v.ack_due_days)::text AS due_on, k.acknowledged_at
        FROM policy_versions v JOIN policies p ON p.tenant_id=v.tenant_id AND p.id=v.policy_id JOIN tenants t ON t.id=v.tenant_id
        JOIN employees e ON e.tenant_id=v.tenant_id AND e.id=$2
        LEFT JOIN policy_acknowledgements k ON k.tenant_id=v.tenant_id AND k.version_id=v.id AND k.employee_id=e.id
        WHERE v.tenant_id=$1 AND v.status='published' AND p.status='active' AND ${AUDIENCE_SQL}
        ORDER BY (v.requires_ack AND k.acknowledged_at IS NULL) DESC, p.category, p.code`, [a.tenantId, a.user.employeeId])).rows;
      const pending = items.filter((i) => i.requires_ack && !i.acknowledged_at);
      return { date: today, items, pending: pending.length, overdue: pending.filter((i) => i.due_on < today).length };
    });
  });

  // ------------------------------------------------------------ acknowledgement report
  async function ackRows(db: Db, a: TenantActor, id: string, status: 'pending' | 'acknowledged' | undefined, limit?: { pageSize: number; offset: number }) {
    const where = `v.tenant_id=$1 AND v.id=$2 AND ${AUDIENCE_SQL} AND ($3::text IS NULL OR ($3='pending' AND k.id IS NULL) OR ($3='acknowledged' AND k.id IS NOT NULL))`;
    const from = `FROM policy_versions v JOIN employees e ON e.tenant_id=v.tenant_id LEFT JOIN branches b ON b.tenant_id=e.tenant_id AND b.id=e.branch_id
      LEFT JOIN departments d ON d.tenant_id=e.tenant_id AND d.id=e.department_id
      LEFT JOIN policy_acknowledgements k ON k.tenant_id=v.tenant_id AND k.version_id=v.id AND k.employee_id=e.id`;
    const args = [a.tenantId, id, status ?? null];
    const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n ${from} WHERE ${where}`, args)).rows[0]!.n);
    const rows = (await db.query<{ employee_code: string; name: string; branch: string | null; department: string | null; acknowledged_at: Date | null; content_sha256: string | null }>(
      `SELECT e.id AS employee_id, e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name, b.name AS branch, d.name AS department, k.acknowledged_at, k.content_sha256
       ${from} WHERE ${where} ORDER BY k.acknowledged_at NULLS FIRST, e.employee_code ${limit ? `LIMIT ${limit.pageSize} OFFSET ${limit.offset}` : ''}`, args)).rows;
    return { total, rows };
  }

  app.get('/versions/:id/acknowledgements', async (req) => {
    const a = tenantActor(req, 'policies.read');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const q = PageQuery.extend({ status: z.enum(['pending', 'acknowledged']).optional() }).parse(req.query);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      if (!(await loadVersion(db, a.tenantId, id))) throw notFound('Version not found');
      const { total, rows } = await ackRows(db, a, id, q.status, { pageSize: q.pageSize, offset: offsetOf(q) });
      return paged(rows, total, q);
    });
  });

  app.get('/versions/:id/acknowledgements.csv', async (req, reply) => {
    const a = tenantActor(req, 'policies.read');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const { csv, name } = await a.tx(async (db) => {
      await requireFeature(db, a.tenantId, FEATURE);
      const v = await loadVersion(db, a.tenantId, id);
      if (!v) throw notFound('Version not found');
      const { rows } = await ackRows(db, a, id, undefined);
      const cell = (s: unknown) => { let t = s == null ? '' : String(s); if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
      const lines = [['employee_code', 'name', 'branch', 'department', 'acknowledged_at', 'content_sha256'].join(','),
        ...rows.map((r) => [r.employee_code, r.name, r.branch, r.department, r.acknowledged_at ? new Date(r.acknowledged_at).toISOString() : '', r.content_sha256].map(cell).join(','))];
      await audit(db, { ...a.auditBase, action: 'policies.acknowledgements_exported', category: 'access', targetType: 'policy_version', targetId: id, metadata: { rows: rows.length } });
      return { csv: lines.join('\r\n') + '\r\n', name: `${v.code}-v${v.version_no}-acknowledgements.csv` };
    });
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}"`).header('cache-control', 'private, no-store').send(csv);
  });
}
