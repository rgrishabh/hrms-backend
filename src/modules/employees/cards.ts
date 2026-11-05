import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../core/audit/audit.js';
import { tenantActor, type TenantActor } from '../../core/http/context.js';
import { AppError, badRequest, conflict, notFound } from '../../core/http/errors.js';
import { Uuid } from '../../core/http/pagination.js';
import * as R from '../../core/http/responses.js';
import { BOLD, drawableImage, INK, loadPdfContext, loadPdfIdentity, MUTED, pdfHeaders, PdfWriter, REGULAR, type PdfContext } from '../../core/pdf/writer.js';
import { l3RowFilter, policyViewer } from '../../core/policy/salary.js';
import { getStore, newKey } from '../../core/storage/index.js';
import { prepareUpload } from '../../core/storage/upload.js';
import { safeFileName } from '../../core/storage/sniff.js';
import { getSettingValue } from '../../core/settings/service.js';
import type { Db } from '../../db/tx.js';

const MM = 72 / 25.4;
/** ISO/IEC 7810 ID-1, the size of a bank card, upright. */
const ID_W = 54 * MM;
const ID_H = 85.6 * MM;
/** The usual Indian business card. */
const BC_W = 89 * MM;
const BC_H = 51 * MM;
const GAP = 6;
const CORNER = 8;
const GUIDE = '#c8c8c8';
const ID_PER_PAGE = 4;
const BC_ROWS = 5;
const BC_PER_PAGE = BC_ROWS * 2;

/** One file at a time: photos are held in memory while it is drawn. A bigger organization prints a branch or department at a time. */
export const MAX_CARDS_PER_FILE = 300;
/** The app shrinks a photo before sending it. This stops anything else from filling a card file with camera originals. */
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const PHOTO_CATEGORY = 'PHOTO';

const IdParams = z.object({ id: Uuid });
const BulkQuery = z.object({ branchId: Uuid.optional(), departmentId: Uuid.optional() });

interface CardPerson {
  id: string;
  name: string;
  employee_code: string;
  designation: string | null;
  department: string | null;
  branch: string;
  work_email: string | null;
  /** Null unless this reader may see it: L3, for the person and HR above them. */
  phone: string | null;
  date_of_joining: string;
  status: string;
  erased_at: Date | null;
  photo_key: string | null;
}
type Contact = { email: string; phone: string | undefined };
/** What the organization has chosen for the back of its ID cards: Settings, General. */
interface IdBack {
  heading: string;
  showBranch: boolean;
  showJoiningDate: boolean;
  terms: string;
  returnTo: string;
}

async function loadIdBack(db: Db, tenantId: string): Promise<IdBack> {
  return {
    heading: await getSettingValue<string>(db, tenantId, 'cards.id_back_heading'),
    showBranch: await getSettingValue<boolean>(db, tenantId, 'cards.id_back_show_branch'),
    showJoiningDate: await getSettingValue<boolean>(db, tenantId, 'cards.id_back_show_joining_date'),
    terms: await getSettingValue<string>(db, tenantId, 'cards.id_back_terms'),
    returnTo: await getSettingValue<string>(db, tenantId, 'cards.id_back_return'),
  };
}

/** Puts the company's details into its wording. A detail it does not have leaves no stray separator behind. Anything else in braces prints as typed. */
export function fillCardText(template: string, values: { company: string; address: string | null; phone: string | undefined; email: string }) {
  const filled = template.replace(/\{(company|address|phone|email)\}/g, (_, k: keyof typeof values) => values[k] ?? '');
  return filled
    .replace(/(\s*·\s*)+/g, ' · ')
    .replace(/:\s*·\s*/g, ': ')
    .replace(/^\s*·\s*|\s*·\s*$/g, '')
    .trim();
}

async function peopleForCards(db: Db, a: TenantActor, where: string, params: unknown[]) {
  const v = await policyViewer(db, a.tenantId, a.user);
  return (
    await db.query<CardPerson>(
      `SELECT e.id, trim(e.first_name||' '||coalesce(e.last_name,'')) AS name, e.employee_code, e.designation, d.name AS department, b.name AS branch, e.work_email,
        CASE WHEN ${l3RowFilter(v, 'e')} THEN e.phone END AS phone, e.date_of_joining::text, e.status, e.erased_at,
        (SELECT p.storage_key FROM documents p JOIN document_categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id
          WHERE p.tenant_id=e.tenant_id AND p.employee_id=e.id AND c.code='${PHOTO_CATEGORY}' AND p.status='active' ORDER BY p.created_at DESC LIMIT 1) AS photo_key
      FROM employees e JOIN branches b ON b.tenant_id=e.tenant_id AND b.id=e.branch_id LEFT JOIN departments d ON d.tenant_id=e.tenant_id AND d.id=e.department_id
      WHERE e.tenant_id=$1 AND ${where} ORDER BY e.employee_code`,
      [a.tenantId, ...params],
    )
  ).rows;
}

/** Read outside any transaction, like the other images in a document, and one that cannot be read leaves the box to paste a print into. */
async function loadPhoto(key: string | null): Promise<Buffer | null> {
  const store = getStore();
  if (!key || !store) return null;
  const body = await store.get(key).catch(() => null);
  return body && drawableImage(body) ? body : null;
}

// ---------------------------------------------------------------- drawing
/** The biggest size, down to `min`, at which the text fits one line. Anything still too long is cut with an ellipsis by `put`. */
function fitted(w: PdfWriter, text: string, font: string, max: number, min: number, width: number) {
  w.doc.font(font);
  for (let size = max; size > min; size -= 0.5) if (w.doc.fontSize(size).widthOfString(text) <= width) return size;
  return min;
}

/** Text in a box. Giving it a height keeps a long value inside the card and stops the library from starting a new page. Returns where the text ended. */
function put(w: PdfWriter, raw: unknown, x: number, y: number, o: { width: number; size: number; font?: string; color?: string; align?: 'left' | 'center' | 'right'; lines?: number }) {
  const lines = o.lines ?? 1;
  const text = w.t(raw);
  w.doc.font(o.font ?? REGULAR).fontSize(o.size).fillColor(o.color ?? INK);
  const height = Math.min(w.doc.heightOfString(text, { width: o.width }), o.size * 1.25 * lines);
  w.doc.text(text, x, y, { width: o.width, height, align: o.align ?? 'left', ellipsis: true });
  return y + height;
}

/** The library stores a picture again each time it is given the bytes, and a sheet repeats the logo and signature on every card. */
type Openable = { openImage(picture: Buffer): Buffer };
const opened = new WeakMap<PdfWriter, Map<Buffer, Buffer>>();
function shared(w: PdfWriter, picture: Buffer) {
  const images = opened.get(w) ?? new Map<Buffer, Buffer>();
  opened.set(w, images);
  // Missing from the library's published types. It answers with an object that `image` accepts in place of the bytes.
  const image = images.get(picture) ?? (w.doc as unknown as Openable).openImage(picture);
  images.set(picture, image);
  return image;
}

function drawLogo(w: PdfWriter, x: number, y: number, width: number, height: number, align: 'left' | 'center') {
  const { logo } = w.ctx.images;
  if (logo) {
    try {
      w.doc.image(shared(w, logo), x, y, { fit: [width, height], ...(align === 'center' ? { align } : {}), valign: 'center' });
      return;
    } catch {
      // Falls through to the name: a card does not fail for its logo.
    }
  }
  put(w, w.ctx.brandName, x, y + height / 2 - 7, { width, size: 11, font: BOLD, color: w.accent, align, lines: 1 });
}

function outlined(w: PdfWriter, x: number, y: number, width: number, height: number, draw: () => void) {
  const { doc } = w;
  doc.save();
  doc.roundedRect(x, y, width, height, CORNER).clip();
  draw();
  doc.restore();
  doc.roundedRect(x, y, width, height, CORNER).lineWidth(0.5).strokeColor(GUIDE).stroke();
}

function idFront(w: PdfWriter, ctx: PdfContext, p: CardPerson, photo: Buffer | null, x: number, y: number) {
  const { doc } = w;
  const inner = ID_W - 20;
  outlined(w, x, y, ID_W, ID_H, () => {
    drawLogo(w, x + 10, y + 6, inner, 26, 'center');
    const company = w.t(ctx.legalName);
    const companyEnd = put(w, company, x + 10, y + 35, { width: inner, size: fitted(w, company, BOLD, 8.5, 6.5, inner), font: BOLD, color: w.accent, align: 'center', lines: 2 });
    const [pw, ph] = [74, 94];
    const [px, py] = [x + (ID_W - pw) / 2, companyEnd + 6];
    doc.save();
    doc.rect(px, py, pw, ph).clip();
    let drawn = false;
    if (photo) {
      try {
        doc.image(photo, px, py, { cover: [pw, ph], align: 'center', valign: 'center' });
        drawn = true;
      } catch {
        drawn = false;
      }
    }
    doc.restore();
    if (drawn) doc.rect(px, py, pw, ph).lineWidth(0.5).strokeColor(GUIDE).stroke();
    else {
      doc.rect(px, py, pw, ph).dash(2, { space: 2 }).lineWidth(0.5).strokeColor(MUTED).stroke().undash();
      put(w, 'Affix photo', px, py + ph / 2 - 4, { width: pw, size: 7, color: MUTED, align: 'center' });
    }
    let at = py + ph + 6;
    const name = w.t(p.name);
    at = put(w, name, x + 10, at, { width: inner, size: fitted(w, name, BOLD, 12, 9, inner), font: BOLD, align: 'center', lines: 2 }) + 2;
    if (p.designation) at = put(w, p.designation, x + 10, at, { width: inner, size: 8, color: w.accent, align: 'center' }) + 1;
    if (p.department) put(w, p.department, x + 10, at, { width: inner, size: 7.5, color: MUTED, align: 'center' });
    doc.rect(x, y + ID_H - 26, ID_W, 26).fill(w.accent);
    put(w, p.employee_code, x + 10, y + ID_H - 18, { width: inner, size: 10, font: BOLD, color: w.onPrimary, align: 'center' });
  });
}

function idBack(w: PdfWriter, ctx: PdfContext, p: CardPerson, contact: Contact, back: IdBack, x: number, y: number) {
  const { doc } = w;
  const inner = ID_W - 20;
  const left = x + 10;
  outlined(w, x, y, ID_W, ID_H, () => {
    doc.rect(x, y, ID_W, 8).fill(w.accent);
    const fill = (template: string) => fillCardText(template, { company: ctx.legalName, address: ctx.company.registeredAddress, phone: contact.phone, email: contact.email });
    let at = y + 16;
    const heading = fill(back.heading);
    if (heading) at = put(w, heading, left, at, { width: inner, size: 8.5, font: BOLD, align: 'center', lines: 2 }) + 6;
    const row = (label: string, value: string) => {
      put(w, label, left, at, { width: inner, size: 6, color: MUTED });
      at = put(w, value, left, at + 7, { width: inner, size: 7.5 }) + 3;
    };
    if (back.showBranch) row('Branch', p.branch);
    if (back.showJoiningDate) row('Date of joining', w.date(p.date_of_joining));
    const signTop = y + ID_H - 44;
    at += 2;
    for (const text of [fill(back.terms), fill(back.returnTo)]) {
      const room = Math.floor((signTop - at) / (6.5 * 1.25));
      if (text && room > 0) at = put(w, text, left, at, { width: inner, size: 6.5, color: MUTED, lines: room }) + 3;
    }
    if (ctx.images.signature) {
      try {
        doc.image(shared(w, ctx.images.signature), left, signTop, { fit: [70, 26] });
      } catch {
        // The line below still says who signs.
      }
    }
    doc.moveTo(left, signTop + 28).lineTo(left + 80, signTop + 28).lineWidth(0.4).strokeColor(MUTED).stroke();
    put(w, ctx.company.signatoryName ?? 'Authorised signatory', left, signTop + 31, { width: inner, size: 6.5, color: MUTED });
  });
}

function businessCard(w: PdfWriter, ctx: PdfContext, p: CardPerson, x: number, y: number) {
  const { doc } = w;
  const left = x + 16;
  const inner = BC_W - 28;
  outlined(w, x, y, BC_W, BC_H, () => {
    doc.rect(x, y, 6, BC_H).fill(w.accent);
    drawLogo(w, left, y + 10, 90, 28, 'left');
    put(w, ctx.legalName, left + 96, y + 12, { width: inner - 96, size: 6.5, font: BOLD, color: MUTED, align: 'right', lines: 3 });
    const name = w.t(p.name);
    let at = put(w, name, left, y + 46, { width: inner, size: fitted(w, name, BOLD, 12.5, 9, inner), font: BOLD }) + 1;
    const role = [p.designation, p.department].filter(Boolean).join(', ');
    if (role) at = put(w, role, left, at, { width: inner, size: 8, color: w.accent });
    const address = ctx.company.registeredAddress;
    const rows = [p.phone, p.work_email].filter(Boolean);
    at = y + BC_H - 10 - rows.length * 10 - (address ? 17 : 0);
    for (const r of rows) at = put(w, r, left, at, { width: inner, size: 7.5 }) + 1;
    if (address) put(w, address, left, at + 1, { width: inner, size: 6.5, color: MUTED, lines: 2 });
  });
}

/** The same for everyone: the company, on its colour. The logo sits on a white panel, since it may not read on the colour. */
function businessBack(w: PdfWriter, ctx: PdfContext, contact: Contact, x: number, y: number) {
  const { doc } = w;
  const inner = BC_W - 32;
  outlined(w, x, y, BC_W, BC_H, () => {
    doc.rect(x, y, BC_W, BC_H).fill(w.accent);
    const [tw, th] = [84, 46];
    const tx = x + (BC_W - tw) / 2;
    doc.roundedRect(tx, y + 28, tw, th, 6).fill('#ffffff');
    drawLogo(w, tx + 6, y + 32, tw - 12, th - 8, 'center');
    const at = put(w, ctx.legalName, x + 16, y + 84, { width: inner, size: 10, font: BOLD, color: w.onPrimary, align: 'center', lines: 2 }) + 6;
    put(w, [contact.phone, contact.email].filter(Boolean).join('  ·  '), x + 16, at, { width: inner, size: 7.5, color: w.onPrimary, align: 'center' });
  });
}

/** Where each card goes on a page: rows centred on it, so that a cut along the outlines leaves the right size. */
function grid(w: PdfWriter, o: { columns: number; rows: number; cellWidth: number; cellHeight: number; gapX: number }) {
  const { doc } = w;
  const startX = (doc.page.width - (o.columns * o.cellWidth + (o.columns - 1) * o.gapX)) / 2;
  const startY = (doc.page.height - (o.rows * o.cellHeight + (o.rows - 1) * GAP)) / 2 - 6;
  return (i: number) => ({ x: startX + (i % o.columns) * (o.cellWidth + o.gapX), y: startY + Math.floor(i / o.columns) * (o.cellHeight + GAP) });
}

async function idCardsPdf(ctx: PdfContext, people: CardPerson[], contact: Contact, back: IdBack) {
  const w = new PdfWriter(ctx, { title: 'ID cards', landscape: true, margin: 20 });
  const at = grid(w, { columns: 2, rows: 2, cellWidth: ID_W * 2 + GAP, cellHeight: ID_H, gapX: 20 });
  for (const [i, p] of people.entries()) {
    if (i > 0 && i % ID_PER_PAGE === 0) w.doc.addPage();
    const { x, y } = at(i % ID_PER_PAGE);
    idFront(w, ctx, p, await loadPhoto(p.photo_key), x, y);
    idBack(w, ctx, p, contact, back, x + ID_W + GAP, y);
  }
  return finish(w);
}

/**
 * A page of fronts, then a page of backs, to print on both sides flipping on the long edge. That flip swaps left and right, so a back takes the
 * mirrored place of its front, and a part-filled last sheet still lines up.
 */
function businessCardsPdf(ctx: PdfContext, people: CardPerson[], contact: Contact) {
  const w = new PdfWriter(ctx, { title: 'Business cards', margin: 20 });
  const at = grid(w, { columns: 2, rows: BC_ROWS, cellWidth: BC_W, cellHeight: BC_H, gapX: GAP });
  // One person's card fills a sheet, which is how they are printed. Several people get one each.
  const sheet = people.length === 1 ? Array.from({ length: BC_PER_PAGE }, () => people[0]!) : people;
  for (let start = 0; start < sheet.length; start += BC_PER_PAGE) {
    if (start > 0) w.doc.addPage();
    const page = sheet.slice(start, start + BC_PER_PAGE);
    page.forEach((p, i) => {
      const { x, y } = at(i);
      businessCard(w, ctx, p, x, y);
    });
    w.doc.addPage();
    page.forEach((_, i) => {
      const { x, y } = at(i % 2 === 0 ? i + 1 : i - 1);
      businessBack(w, ctx, contact, x, y);
    });
  }
  return finish(w, ['Print both sides, flipping on the long edge, then cut along the outlines.']);
}

function finish(w: PdfWriter, notes: string[] = []) {
  w.doc.x = w.margin;
  w.doc.y = w.bottom - 26;
  w.closingNotes(notes);
  w.doc.end();
  return w.doc;
}

// ---------------------------------------------------------------- routes
export async function cardRoutes(app: FastifyInstance) {
  const { env } = app.deps;
  const contact: Contact = { email: env.BRAND_SUPPORT_EMAIL, phone: env.BRAND_SUPPORT_PHONE };

  /** Reads, records and draws. A card says who someone is, so it is not printed for someone who has left. */
  async function send(a: TenantActor, kind: 'id' | 'business', people: (db: Db) => Promise<CardPerson[]>, target: { id?: string; filters?: Record<string, string | undefined> }) {
    const { list, identity, back } = await a.tx(async (db) => {
      const list = await people(db);
      await audit(db, {
        ...a.auditBase,
        action: 'employee.cards_printed',
        category: 'access',
        targetType: 'employee',
        ...(target.id ? { targetId: target.id } : {}),
        metadata: { kind, count: list.length, phonesPrinted: kind === 'business' ? list.filter((p) => p.phone).length : 0, ...(target.filters ?? {}) },
      });
      return { list, identity: await loadPdfIdentity(db, a.tenantId), back: await loadIdBack(db, a.tenantId) };
    });
    const ctx = await loadPdfContext(app, identity);
    return kind === 'id' ? idCardsPdf(ctx, list, contact, back) : businessCardsPdf(ctx, list, contact);
  }

  const one = (a: TenantActor, id: string) => async (db: Db) => {
    const [p] = await peopleForCards(db, a, 'e.id=$2', [id]);
    if (!p) throw notFound('Employee not found');
    if (p.erased_at || p.status === 'exited' || p.status === 'inactive') throw conflict('Cards are printed only for people who work here');
    return [p];
  };

  const all = (a: TenantActor, q: z.infer<typeof BulkQuery>) => async (db: Db) => {
    const list = await peopleForCards(db, a, `e.erased_at IS NULL AND e.status IN ('active','on_notice') AND ($2::uuid IS NULL OR e.branch_id=$2) AND ($3::uuid IS NULL OR e.department_id=$3)`, [
      q.branchId ?? null,
      q.departmentId ?? null,
    ]);
    if (!list.length) throw notFound('No current employees match');
    if (list.length > MAX_CARDS_PER_FILE) throw badRequest(`${list.length} people are too many for one file. Choose a branch or department: the limit is ${MAX_CARDS_PER_FILE}.`);
    return list;
  };

  const PDF = { 200: R.file('application/pdf') };
  const config = { perm: ['employees.manage'] };

  app.get('/cards/id-cards.pdf', { schema: { response: PDF, querystring: BulkQuery }, config }, async (req, reply) => {
    const a = tenantActor(req, 'employees.manage');
    const q = BulkQuery.parse(req.query);
    return pdfHeaders(reply, 'id-cards.pdf').send(await send(a, 'id', all(a, q), { filters: q }));
  });

  app.get('/cards/business-cards.pdf', { schema: { response: PDF, querystring: BulkQuery }, config }, async (req, reply) => {
    const a = tenantActor(req, 'employees.manage');
    const q = BulkQuery.parse(req.query);
    return pdfHeaders(reply, 'business-cards.pdf').send(await send(a, 'business', all(a, q), { filters: q }));
  });

  app.get('/:id/id-card.pdf', { schema: { response: PDF, params: IdParams }, config }, async (req, reply) => {
    const a = tenantActor(req, 'employees.manage');
    const { id } = IdParams.parse(req.params);
    const doc = await send(a, 'id', one(a, id), { id });
    return pdfHeaders(reply, 'id-card.pdf').send(doc);
  });

  app.get('/:id/business-card.pdf', { schema: { response: PDF, params: IdParams }, config }, async (req, reply) => {
    const a = tenantActor(req, 'employees.manage');
    const { id } = IdParams.parse(req.params);
    const doc = await send(a, 'business', one(a, id), { id });
    return pdfHeaders(reply, 'business-card.pdf').send(doc);
  });

  /** The photo on the ID card, kept as a document of the person, so that retention and erasure already cover it. A new one archives the last. */
  app.put(
    '/:id/photo',
    {
      schema: { response: { 200: R.PutEmployeesByIdPhoto200 }, params: IdParams, consumes: ['multipart/form-data'] },
      config: { perm: ['employees.manage'], rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req) => {
      const a = tenantActor(req, 'employees.manage');
      const { id } = IdParams.parse(req.params);
      if (!req.isMultipart()) throw badRequest('Upload as multipart/form-data');
      const part = await req.file();
      const received = await part?.toBuffer().catch((e: { code?: string }) => {
        if (e.code === 'FST_REQ_FILE_TOO_LARGE') throw tooBig();
        throw e;
      });
      if (!part || !received?.length) throw badRequest('Choose a photo');
      if (received.length > MAX_PHOTO_BYTES) throw tooBig();
      const upload = await prepareUpload(req, a, received, part.filename || 'photo');
      if (!['image/jpeg', 'image/png'].includes(upload.contentType) || !drawableImage(upload.bytes)) throw new AppError(415, 'unsupported_file', 'Use a JPEG or PNG photo.');
      const store = getStore();
      if (!store) throw new AppError(503, 'storage_unavailable', 'File storage is not configured');
      const key = newKey(a.tenantId, id);
      await store.put(key, upload.bytes, upload.contentType);
      try {
        await a.tx(async (db) => {
          const e = (await db.query<{ erased_at: Date | null }>('SELECT erased_at FROM employees WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id])).rows[0];
          if (!e) throw notFound('Employee not found');
          if (e.erased_at) throw conflict("This person's data was erased, and the record cannot be changed.");
          await db.query(`INSERT INTO document_categories (tenant_id, code, name, scope) VALUES ($1,$2,'Employee photo','employee') ON CONFLICT (tenant_id, code) DO NOTHING`, [a.tenantId, PHOTO_CATEGORY]);
          const category = (await db.query<{ id: string }>('SELECT id FROM document_categories WHERE tenant_id=$1 AND code=$2', [a.tenantId, PHOTO_CATEGORY])).rows[0]!.id;
          const replaced = await db.query(`UPDATE documents SET status='archived', archived_at=now(), archived_by=$4 WHERE tenant_id=$1 AND employee_id=$2 AND category_id=$3 AND status='active'`, [
            a.tenantId,
            id,
            category,
            a.user.userId,
          ]);
          await db.query(
            `INSERT INTO documents (tenant_id, category_id, employee_id, title, file_name, content_type, size_bytes, sha256, storage_key, uploaded_by)
            VALUES ($1,$2,$3,'Photo for ID card',$4,$5,$6,$7,$8,$9)`,
            [a.tenantId, category, id, safeFileName(part.filename || 'photo', upload.ext), upload.contentType, upload.bytes.length, createHash('sha256').update(upload.bytes).digest('hex'), key, a.user.userId],
          );
          await audit(db, { ...a.auditBase, action: 'employee.photo_updated', category: 'data', targetType: 'employee', targetId: id, metadata: { replaced: !!replaced.rowCount } });
        });
      } catch (e) {
        await store.delete(key).catch((err: unknown) => req.log.warn({ err, key }, 'could not remove an unused photo upload'));
        throw e;
      }
      return { ok: true };
    },
  );
}

const tooBig = () => new AppError(413, 'file_too_large', 'Photos are limited to 2 MB');
