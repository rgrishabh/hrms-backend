import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { tenantActor, requireFeature, type TenantActor } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { AppError, badRequest, forbidden, notFound } from '../../core/http/errors.js';
import { IsoDate, PageQuery, offsetOf, paged, Uuid } from '../../core/http/pagination.js';
import { getStore, newKey } from '../../core/storage/index.js';
import { detectFile, safeFileName } from '../../core/storage/sniff.js';
import type { Db } from '../../db/tx.js';

interface Category { id: string; code: string; name: string; scope: 'employee' | 'company'; employee_visible: boolean; employee_upload: boolean; restricted: boolean; requires_expiry: boolean; status: string }
const CAT_COLS = 'id, code, name, scope, employee_visible, employee_upload, restricted, requires_expiry, status';

const CategoryBody = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{0,19}$/), name: z.string().trim().min(2).max(80),
  scope: z.enum(['employee', 'company']).default('employee'), employeeVisible: z.boolean().default(true), employeeUpload: z.boolean().default(false),
  restricted: z.boolean().default(false), requiresExpiry: z.boolean().default(false), status: z.enum(['active', 'inactive']).default('active'),
}).refine((c) => !(c.scope === 'company' && c.employeeUpload), { message: 'Employees cannot upload company documents', path: ['employeeUpload'] });

/**
 * Visibility (one rule used for list, metadata and download):
 *  - documents.read: all non-restricted documents; restricted ones need documents.restricted
 *  - everyone: their own employee documents in employee-visible categories, and
 *    company documents in employee-visible categories
 * Managers get no implicit access to their team's documents (least privilege).
 */
function visibilitySql(a: TenantActor) {
  const hr = a.has('documents.read') || a.has('documents.manage');
  const restricted = a.has('documents.restricted');
  return {
    sql: `(($2::boolean AND ($3::boolean OR NOT c.restricted))
       OR (c.employee_visible AND (d.employee_id = $4::uuid OR d.employee_id IS NULL)))`,
    params: [hr, restricted, a.user.employeeId ?? '00000000-0000-0000-0000-000000000000'] as unknown[],
  };
}

async function loadCategory(db: Db, tenantId: string, id: string) {
  const c = (await db.query<Category>(`SELECT ${CAT_COLS} FROM document_categories WHERE tenant_id=$1 AND id=$2`, [tenantId, id])).rows[0];
  if (!c) throw notFound('Document category not found');
  return c;
}

export async function documentRoutes(app: FastifyInstance) {
  const { env } = app.deps;
  const maxBytes = env.STORAGE_MAX_FILE_MB * 1024 * 1024;

  // ------------------------------------------------------------ categories
  app.get('/categories', async (req) => {
    const a = tenantActor(req);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'core.documents');
      const all = a.has('documents.manage');
      return { items: (await db.query(`SELECT ${CAT_COLS} FROM document_categories WHERE tenant_id=$1 AND ($2 OR status='active') ORDER BY scope, name`, [a.tenantId, all])).rows };
    });
  });

  const catCols = (b: z.infer<typeof CategoryBody>) => [b.code, b.name, b.scope, b.employeeVisible, b.employeeUpload, b.restricted, b.requiresExpiry, b.status];
  app.post('/categories', async (req, reply) => {
    const a = tenantActor(req, 'documents.manage');
    const b = CategoryBody.parse(req.body);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'core.documents');
      const r = await db.query<{ id: string }>(`INSERT INTO document_categories (tenant_id, code, name, scope, employee_visible, employee_upload, restricted, requires_expiry, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [a.tenantId, ...catCols(b)]);
      await audit(db, { ...a.auditBase, action: 'documents.category_created', category: 'configuration', targetType: 'document_category', targetId: r.rows[0]!.id, metadata: b });
      reply.code(201); return { id: r.rows[0]!.id };
    });
  });

  app.put('/categories/:id', async (req) => {
    const a = tenantActor(req, 'documents.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const b = CategoryBody.parse(req.body);
    return a.tx(async (db) => {
      const prev = await loadCategory(db, a.tenantId, id);
      if (prev.scope !== b.scope) throw badRequest('The scope of an existing category cannot change');
      // The restricted flag is what keeps medical / identity files from document managers: only those cleared for them may change it.
      if ((prev.restricted || b.restricted) && !a.has('documents.restricted')) throw forbidden('Only users with access to restricted documents can change a restricted category');
      await db.query(`UPDATE document_categories SET code=$3, name=$4, scope=$5, employee_visible=$6, employee_upload=$7, restricted=$8, requires_expiry=$9, status=$10
        WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id, ...catCols(b)]);
      await audit(db, { ...a.auditBase, action: 'documents.category_updated', category: 'configuration', targetType: 'document_category', targetId: id, metadata: { from: prev, to: b } });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------ documents
  app.get('/', async (req) => {
    const a = tenantActor(req);
    const q = PageQuery.extend({ employeeId: Uuid.optional(), scope: z.enum(['employee', 'company', 'mine']).optional(), categoryId: Uuid.optional(),
      status: z.enum(['active', 'archived']).default('active'), expiringWithinDays: z.coerce.number().int().min(0).max(365).optional() }).parse(req.query);
    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'core.documents');
      const v = visibilitySql(a);
      const params = [a.tenantId, ...v.params, q.employeeId ?? null, q.scope === 'mine' ? (a.user.employeeId ?? '00000000-0000-0000-0000-000000000000') : null,
        q.scope ?? null, q.categoryId ?? null, q.status, q.expiringWithinDays ?? null];
      const where = `d.tenant_id=$1 AND ${v.sql} AND ($5::uuid IS NULL OR d.employee_id=$5) AND ($6::uuid IS NULL OR d.employee_id=$6)
        AND ($7::text IS NULL OR $7='mine' OR ($7='company') = (d.employee_id IS NULL)) AND ($8::uuid IS NULL OR d.category_id=$8) AND d.status=$9
        AND ($10::int IS NULL OR (d.expires_on IS NOT NULL AND d.expires_on <= current_date + $10))`;
      const from = `FROM documents d JOIN document_categories c ON c.tenant_id=d.tenant_id AND c.id=d.category_id
        LEFT JOIN employees e ON e.tenant_id=d.tenant_id AND e.id=d.employee_id LEFT JOIN users u ON u.id=d.uploaded_by`;
      const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n ${from} WHERE ${where}`, params)).rows[0]!.n);
      const rows = await db.query(`SELECT d.id, d.title, d.file_name, d.content_type, d.size_bytes, d.expires_on, d.status, d.created_at, d.employee_id,
          e.employee_code, trim(e.first_name||' '||coalesce(e.last_name,'')) AS employee_name, c.id AS category_id, c.name AS category_name, c.restricted,
          u.display_name AS uploaded_by_name
        ${from} WHERE ${where} ORDER BY d.created_at DESC LIMIT $11 OFFSET $12`, [...params, q.pageSize, offsetOf(q)]);
      return paged(rows.rows, total, q);
    });
  });

  /** multipart/form-data: file + categoryId, title, employeeId?, expiresOn? */
  app.post('/', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const a = tenantActor(req);
    if (!req.isMultipart()) throw badRequest('Upload as multipart/form-data');
    const store = getStore();
    let file: { buf: Buffer; name: string } | null = null;
    const fields: Record<string, string> = {};
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (file) throw badRequest('One file per upload');
        const buf = await part.toBuffer().catch((e: { code?: string }) => {
          if (e.code === 'FST_REQ_FILE_TOO_LARGE') throw new AppError(413, 'file_too_large', `Files are limited to ${env.STORAGE_MAX_FILE_MB} MB`);
          throw e;
        });
        file = { buf, name: part.filename || 'document' };
      } else fields[part.fieldname] = String(part.value);
    }
    const body = z.object({ categoryId: Uuid, title: z.string().trim().min(2).max(200), employeeId: Uuid.optional(), expiresOn: IsoDate.optional() }).parse(fields);
    if (!file || !file.buf.length) throw badRequest('Choose a file to upload');
    if (file.buf.length > maxBytes) throw new AppError(413, 'file_too_large', `Files are limited to ${env.STORAGE_MAX_FILE_MB} MB`);
    const detected = detectFile(file.buf, file.name);
    if ('error' in detected) throw new AppError(415, 'unsupported_file', detected.error);

    return a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'core.documents');
      const c = await loadCategory(db, a.tenantId, body.categoryId);
      if (c.status !== 'active') throw badRequest('This category is not active');
      if (c.scope === 'employee' && !body.employeeId) throw badRequest('Choose the employee this document belongs to');
      if (c.scope === 'company' && body.employeeId) throw badRequest('Company documents are not linked to an employee');
      const manage = a.has('documents.manage');
      const ownUpload = c.employee_upload && body.employeeId === a.user.employeeId;
      if (!manage && !ownUpload) throw forbidden('You cannot upload documents to this category for this employee');
      if (c.requires_expiry && !body.expiresOn) throw badRequest(`${c.name} needs an expiry date`);
      if (body.employeeId && !(await db.query('SELECT 1 FROM employees WHERE tenant_id=$1 AND id=$2', [a.tenantId, body.employeeId])).rowCount) throw notFound('Employee not found');
      if (!store) throw new AppError(503, 'storage_unavailable', 'Document storage is not configured');
      const key = newKey(a.tenantId, body.employeeId ?? null);
      await store.put(key, file!.buf, detected.contentType);
      const sha = createHash('sha256').update(file!.buf).digest('hex');
      const r = await db.query<{ id: string }>(`INSERT INTO documents (tenant_id, category_id, employee_id, title, file_name, content_type, size_bytes, sha256, storage_key, expires_on, uploaded_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [a.tenantId, c.id, body.employeeId ?? null, body.title, safeFileName(file!.name, detected.ext),
        detected.contentType, file!.buf.length, sha, key, body.expiresOn ?? null, a.user.userId]);
      await audit(db, { ...a.auditBase, action: 'documents.uploaded', targetType: 'document', targetId: r.rows[0]!.id,
        metadata: { category: c.code, employeeId: body.employeeId ?? null, sizeBytes: file!.buf.length, contentType: detected.contentType, sha256: sha } });
      reply.code(201); return { id: r.rows[0]!.id };
    });
  });

  app.get('/:id/download', async (req, reply) => {
    const a = tenantActor(req);
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const doc = await a.tx(async (db) => {
      await requireFeature(db, a.tenantId, 'core.documents');
      const v = visibilitySql(a);
      const d = (await db.query<{ id: string; storage_key: string; file_name: string; content_type: string; sha256: string; restricted: boolean }>(
        `SELECT d.id, d.storage_key, d.file_name, d.content_type, d.sha256, c.restricted FROM documents d
           JOIN document_categories c ON c.tenant_id=d.tenant_id AND c.id=d.category_id WHERE d.tenant_id=$1 AND ${v.sql} AND d.id=$5`,
        [a.tenantId, ...v.params, id])).rows[0];
      if (!d) throw notFound('Document not found');
      await audit(db, { ...a.auditBase, action: 'documents.downloaded', category: 'access', targetType: 'document', targetId: id, metadata: { restricted: d.restricted } });
      return d;
    });
    const store = getStore();
    if (!store) throw new AppError(503, 'storage_unavailable', 'Document storage is not configured');
    const buf = await store.get(doc.storage_key);
    if (createHash('sha256').update(buf).digest('hex') !== doc.sha256) {
      req.log.error({ documentId: id }, 'document integrity check failed');
      throw new AppError(500, 'integrity_failed', 'The stored file failed its integrity check. Contact your administrator.');
    }
    return reply
      .header('content-type', doc.content_type)
      .header('content-disposition', `attachment; filename="${doc.file_name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(buf);
  });

  app.post('/:id/archive', async (req) => {
    const a = tenantActor(req, 'documents.manage');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      const r = await db.query(`UPDATE documents SET status='archived', archived_at=now(), archived_by=$3 WHERE tenant_id=$1 AND id=$2 AND status='active'`, [a.tenantId, id, a.user.userId]);
      if (!r.rowCount) throw notFound('Active document not found');
      await audit(db, { ...a.auditBase, action: 'documents.archived', targetType: 'document', targetId: id });
      return { ok: true };
    });
  });
}
