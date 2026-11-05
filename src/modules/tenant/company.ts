import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../core/audit/audit.js';
import { dataCipher } from '../../core/crypto/index.js';
import { allOff } from '../../core/features/state.js';
import { tenantActor, tenantActorAny } from '../../core/http/context.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../core/http/errors.js';
import { maskFields } from '../../core/policy/salary.js';
import { companyRow, legalEntityFallback } from '../../core/settings/company.js';
import { BankAccount, Cin, EsiCode, Gstin, Ifsc, Pan, Registration, Tan } from '../../core/settings/india.js';
import { getStore, newKey } from '../../core/storage/index.js';
import { prepareUpload } from '../../core/storage/upload.js';
import type { Db } from '../../db/tx.js';

const opt = <T extends z.ZodTypeAny>(s: T) => s.nullable().optional();
const text = (max: number) => z.string().trim().min(1).max(max);

/** Everything is optional: a field left out stays as it is, and null clears it. */
export const CompanyBody = z.object({
  legalName: opt(text(200)), gstin: opt(Gstin), pan: opt(Pan), tan: opt(Tan), cin: opt(Cin), registeredAddress: opt(text(500)),
  pfRegistration: opt(Registration), esiRegistration: opt(EsiCode), ptRegistration: opt(Registration),
  bankAccountHolder: opt(text(120)), bankName: opt(text(120)), bankIfsc: opt(Ifsc), bankAccountNumber: opt(BankAccount),
  signatoryName: opt(text(120)), signatoryDesignation: opt(text(120)),
  expectedVersion: z.number().int().optional(),
}).strict();
const ImageParams = z.object({ kind: z.enum(['signature', 'stamp']) });

type BodyKey = Exclude<keyof z.infer<typeof CompanyBody>, 'expectedVersion'>;
/** Field to column. `sensitive` fields go in the audit log by name only (L4, docs/DATA_SECURITY.md); the rest go old to new. */
const FIELDS: Readonly<Record<BodyKey, { column: string; sensitive?: boolean; payroll?: boolean; sealed?: boolean }>> = {
  legalName: { column: 'legal_name' }, gstin: { column: 'gstin' }, pan: { column: 'pan_enc', sensitive: true, sealed: true }, tan: { column: 'tan' }, cin: { column: 'cin' },
  registeredAddress: { column: 'registered_address' }, pfRegistration: { column: 'pf_registration', payroll: true }, esiRegistration: { column: 'esi_registration', payroll: true }, ptRegistration: { column: 'pt_registration', payroll: true },
  bankAccountHolder: { column: 'bank_account_holder', sensitive: true, payroll: true }, bankName: { column: 'bank_name', sensitive: true, payroll: true }, bankIfsc: { column: 'bank_ifsc', sensitive: true, payroll: true },
  bankAccountNumber: { column: 'bank_account_enc', sensitive: true, sealed: true, payroll: true }, signatoryName: { column: 'signatory_name' }, signatoryDesignation: { column: 'signatory_designation' },
};
const LAST4: Partial<Record<BodyKey, string>> = { pan: 'pan_last4', bankAccountNumber: 'bank_account_last4' };
const L4_READERS = ['company.manage', 'payroll.manage', 'payroll.approve'] as const;
const IMAGE_READERS = ['company.manage', 'payroll.manage', 'payroll.approve', 'lifecycle.manage'] as const;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const COLS = { signature: { key: 'signature_key', type: 'signature_type', sha: 'signature_sha256' }, stamp: { key: 'stamp_key', type: 'stamp_type', sha: 'stamp_sha256' } } as const;

const mask = (last4: string | null) => (last4 ? `XXXXXX${last4}` : null);

async function ensureRow(db: Db, tenantId: string) {
  await db.query(`INSERT INTO company_profile (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`, [tenantId]);
}

/** Layer 3: legal name, tax and registration numbers, payroll bank details, authorised signatory, and the signature and stamp images. See D53. */
export async function companyRoutes(app: FastifyInstance) {
  app.get('/company', { schema: {}, config: { permAny: ['settings.read', ...L4_READERS] } }, async (req) => {
    const a = tenantActorAny(req, 'settings.read', ...L4_READERS);
    const mayReadL4 = L4_READERS.some((p) => a.has(p));
    if (a.reveal && !a.has('company.manage')) throw forbidden();
    return a.tx(async (db) => {
      const c = await companyRow(db, a.tenantId);
      const le = await legalEntityFallback(db, a.tenantId);
      const payrollOn = !allOff('payroll');
      const sealed = {
        panMasked: mask(c?.pan_last4 ?? null),
        ...(payrollOn ? { bankAccountHolder: c?.bank_account_holder ?? null, bankName: c?.bank_name ?? null, bankIfsc: c?.bank_ifsc ?? null, bankAccountMasked: mask(c?.bank_account_last4 ?? null) } : {}),
      };
      const row = {
        legalName: c?.legal_name ?? le?.name ?? null, gstin: c?.gstin ?? le?.gstin ?? null, cin: c?.cin ?? le?.cin ?? null,
        // Where the three came from, so a screen can say "from the legal entity" and an empty field is not taken for a saved one.
        stored: { legalName: c?.legal_name ?? null, gstin: c?.gstin ?? null, cin: c?.cin ?? null },
        tan: c?.tan ?? null, registeredAddress: c?.registered_address ?? null,
        ...(payrollOn ? { pfRegistration: c?.pf_registration ?? null, esiRegistration: c?.esi_registration ?? null, ptRegistration: c?.pt_registration ?? null } : {}),
        signatoryName: c?.signatory_name ?? null, signatoryDesignation: c?.signatory_designation ?? null, hasSignature: !!c?.signature_key, hasStamp: !!c?.stamp_key,
        version: c?.version ?? 0, updatedAt: c?.updated_at ?? null, editable: a.has('company.manage'),
        ...sealed,
      };
      if (!mayReadL4) return maskFields(row, Object.keys(sealed));
      // The bank account is the one sealed value a person may need whole, to check it against a statement. PAN never leaves whole (docs/DATA_SECURITY.md); the last four stay what is shown.
      if (!a.reveal) return row;
      if (c?.bank_account_enc && payrollOn) {
        await audit(db, { ...a.auditBase, action: 'company.reveal', category: 'access', targetType: 'company_profile', userAgent: a.userAgent, metadata: { fields: ['bankAccountNumber'] } });
        return { ...row, bankAccountNumber: dataCipher().decrypt(c.bank_account_enc) };
      }
      return row;
    });
  });

  app.put('/company', { schema: { body: CompanyBody }, config: { perm: ['company.manage'] } }, async (req) => {
    const a = tenantActor(req, 'company.manage');
    const { expectedVersion, ...body } = CompanyBody.parse(req.body);
    const given = (Object.keys(body) as BodyKey[]).filter((k) => body[k] !== undefined);
    // A field of a module that is off does not exist for this deployment. What it held stays.
    const hidden = allOff('payroll') ? given.filter((k) => FIELDS[k].payroll) : [];
    if (hidden.length) throw badRequest(`These fields belong to payroll, which is off: ${hidden.join(', ')}`);
    return a.tx(async (db) => {
      await ensureRow(db, a.tenantId);
      const cur = (await companyRow(db, a.tenantId, true))!;
      if (expectedVersion !== undefined && cur.version !== expectedVersion) throw conflict('The company details were changed by someone else. Reload and try again.');
      const sets: string[] = []; const values: unknown[] = [];
      const set = (col: string, v: unknown) => { values.push(v); sets.push(`${col}=$${values.length + 2}`); };
      const changes: Record<string, { from: unknown; to: unknown }> = {}; const sensitive: string[] = [];
      const current = cur as unknown as Record<string, string | null>;
      for (const k of given) {
        const f = FIELDS[k]; const v = body[k] ?? null;
        if (f.sealed) {
          const last4 = LAST4[k]!;
          // Sealing twice gives different text, so sameness is decided on the value itself.
          if ((current[f.column] ? dataCipher().decrypt(current[f.column]!) : null) === v) continue;
          set(f.column, v === null ? null : dataCipher().encrypt(v));
          set(last4, v === null ? null : v.slice(-4));
          sensitive.push(k);
        } else {
          if (current[f.column] === v) continue;
          set(f.column, v);
          if (f.sensitive) sensitive.push(k); else changes[k] = { from: current[f.column], to: v };
        }
      }
      if (!sets.length) return { ok: true, version: cur.version, changed: [] };
      set('updated_by', a.user.userId);
      const version = (await db.query<{ version: number }>(`UPDATE company_profile SET ${sets.join(', ')}, version=version+1, updated_at=now() WHERE tenant_id=$1 AND version=$2 RETURNING version`,
        [a.tenantId, cur.version, ...values])).rows[0]!.version;
      await audit(db, { ...a.auditBase, action: 'company.updated', category: 'configuration', targetType: 'company_profile',
        metadata: { changes, ...(sensitive.length ? { sensitiveFields: sensitive, note: 'Sensitive fields are recorded by name, without their values' } : {}) } });
      return { ok: true, version, changed: [...Object.keys(changes), ...sensitive] };
    });
  });

  app.post('/company/images/:kind', { schema: { params: ImageParams, consumes: ['multipart/form-data'] }, config: { perm: ['company.manage'], rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const a = tenantActor(req, 'company.manage');
    const { kind } = ImageParams.parse(req.params);
    const store = getStore();
    if (!store) throw new AppError(503, 'storage_unavailable', 'File storage is not configured');
    if (!req.isMultipart()) throw badRequest('Upload as multipart/form-data');
    const part = await req.file();
    if (!part) throw badRequest('Choose an image');
    const received = await part.toBuffer().catch((e: { code?: string }) => {
      if (e.code === 'FST_REQ_FILE_TOO_LARGE') throw new AppError(413, 'file_too_large', 'That image is too large');
      throw e;
    });
    if (!received.length) throw badRequest('Choose an image');
    if (received.length > MAX_IMAGE_BYTES) throw new AppError(413, 'file_too_large', 'That image is too large. The limit is 2 MB.');
    const detected = await prepareUpload(req, a, received, part.filename || kind);
    if (detected.contentType !== 'image/png' && detected.contentType !== 'image/jpeg') throw new AppError(415, 'unsupported_file', 'A signature or stamp must be a PNG or JPEG image');
    const key = newKey(a.tenantId, null);
    const sha = createHash('sha256').update(detected.bytes).digest('hex');
    await store.put(key, detected.bytes, detected.contentType);
    const col = COLS[kind];
    let old: string | null;
    try {
      old = await a.tx(async (db) => {
        await ensureRow(db, a.tenantId);
        const cur = (await companyRow(db, a.tenantId, true))!;
        await db.query(`UPDATE company_profile SET ${col.key}=$2, ${col.type}=$3, ${col.sha}=$4, updated_by=$5, version=version+1, updated_at=now() WHERE tenant_id=$1`, [a.tenantId, key, detected.contentType, sha, a.user.userId]);
        await audit(db, { ...a.auditBase, action: 'company.image_uploaded', category: 'configuration', targetType: 'company_profile', metadata: { kind, contentType: detected.contentType, from: cur[col.sha], to: sha } });
        return cur[col.key];
      });
    } catch (e) { await store.delete(key).catch(() => undefined); throw e; }
    if (old) await store.delete(old).catch((e: Error) => { req.log.error({ err: e.message }, 'replaced company image could not be deleted'); });
    reply.code(201);
    return { kind, contentType: detected.contentType, sha256: sha };
  });

  app.get('/company/images/:kind', { schema: { params: ImageParams }, config: { permAny: [...IMAGE_READERS] } }, async (req, reply) => {
    const a = tenantActorAny(req, ...IMAGE_READERS);
    const { kind } = ImageParams.parse(req.params);
    const col = COLS[kind];
    const img = await a.tx(async (db) => {
      const c = await companyRow(db, a.tenantId);
      if (!c?.[col.key]) throw notFound(`No ${kind} on file`);
      await audit(db, { ...a.auditBase, action: 'company.image_viewed', category: 'access', targetType: 'company_profile', metadata: { kind } });
      return { key: c[col.key]!, type: c[col.type]!, sha: c[col.sha]! };
    });
    const store = getStore();
    if (!store) throw new AppError(503, 'storage_unavailable', 'File storage is not configured');
    const buf = await store.get(img.key);
    if (createHash('sha256').update(buf).digest('hex') !== img.sha) throw new AppError(500, 'integrity_failed', 'The stored file failed its integrity check');
    return reply.header('content-type', img.type).header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff').send(buf);
  });

  app.delete('/company/images/:kind', { schema: { params: ImageParams }, config: { perm: ['company.manage'] } }, async (req) => {
    const a = tenantActor(req, 'company.manage');
    const { kind } = ImageParams.parse(req.params);
    const col = COLS[kind];
    const old = await a.tx(async (db) => {
      const c = await companyRow(db, a.tenantId, true);
      if (!c?.[col.key]) throw notFound(`No ${kind} on file`);
      await db.query(`UPDATE company_profile SET ${col.key}=NULL, ${col.type}=NULL, ${col.sha}=NULL, updated_by=$2, version=version+1, updated_at=now() WHERE tenant_id=$1`, [a.tenantId, a.user.userId]);
      await audit(db, { ...a.auditBase, action: 'company.image_removed', category: 'configuration', targetType: 'company_profile', metadata: { kind, from: c[col.sha] } });
      return c[col.key]!;
    });
    await getStore()?.delete(old).catch((e: Error) => { req.log.error({ err: e.message }, 'removed company image could not be deleted'); });
    return { ok: true };
  });
}
