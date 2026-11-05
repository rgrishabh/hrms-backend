import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import PDFDocument from 'pdfkit';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../../db/tx.js';
import { BRAND_MOUNT } from '../http/web.js';
import { organizationName } from '../../config/env.js';
import { loadCompanyProfile, type CompanyProfile } from '../settings/company.js';
import { getSettingValue } from '../settings/service.js';
import { getStore } from '../storage/index.js';

/**
 * Branded documents (D52). The standard PDF fonts: no font file in the image, and no shaping to get wrong. They hold Windows-1252 only, so
 * amounts carry the ISO code, not a sign, and text outside that set is printed as `?` with a note at the end of the document.
 */
export type Doc = PDFKit.PDFDocument;
export interface PdfImages { logo: Buffer | null; signature: Buffer | null; stamp: Buffer | null }
export interface PdfIdentity { company: CompanyProfile; dateFormat: string }
export interface PdfContext extends PdfIdentity {
  brandName: string; productName: string; legalName: string; primaryColor: string; locale: string; currency: string; images: PdfImages;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_PIXELS_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Whether the drawing library can take this file. It inflates a PNG with alpha in a callback and throws from there, which no caller can catch
 * and which would end the process, so the bytes are checked here first: a broken file becomes a missing image.
 */
export function drawableImage(b: Buffer): boolean {
  if (b.length > MAX_IMAGE_BYTES) return false;
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  if (!b.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  try {
    let at = 8; const idat: Buffer[] = []; let width = 0; let height = 0; let bits = 0; let colour = -1; let interlace = 0;
    while (at + 8 <= b.length) {
      const len = b.readUInt32BE(at); const type = b.toString('latin1', at + 4, at + 8);
      if (at + 12 + len > b.length) return false;
      if (type === 'IHDR') { width = b.readUInt32BE(at + 8); height = b.readUInt32BE(at + 12); bits = b[at + 16]!; colour = b[at + 17]!; interlace = b[at + 20]!; }
      if (type === 'IDAT') idat.push(b.subarray(at + 8, at + 8 + len));
      if (type === 'IEND') break;
      at += 12 + len;
    }
    const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colour];
    if (!channels || !width || !height || interlace !== 0 || ![1, 2, 4, 8].includes(bits) || !idat.length) return false;
    const stride = Math.ceil((width * channels * bits) / 8) + 1;
    if (stride * height > MAX_IMAGE_PIXELS_BYTES) return false;
    const pixels = inflateSync(Buffer.concat(idat), { maxOutputLength: MAX_IMAGE_PIXELS_BYTES });
    if (pixels.length < stride * height) return false;
    for (let row = 0; row < height; row++) if (pixels[row * stride]! > 4) return false;
    return true;
  } catch { return false; }
}

/** The logo, when it is a PNG or JPEG in the mounted directory. The server never fetches a brand asset, so an `https://` logo prints as the name. */
async function loadLogo(app: FastifyInstance): Promise<Buffer | null> {
  const ref = app.deps.env.BRAND_LOGO_URL;
  if (!ref?.startsWith('/brand/') || !/\.(png|jpe?g)$/i.test(ref)) return null;
  const body = await readFile(path.join(app.deps.brandDirOverride ?? BRAND_MOUNT, path.basename(ref))).catch(() => null);
  return body && drawableImage(body) ? body : null;
}

async function loadStored(key: string | null): Promise<Buffer | null> {
  const store = getStore();
  if (!key || !store) return null;
  const body = await store.get(key).catch(() => null);
  return body && drawableImage(body) ? body : null;
}

/** What a document says about the employer, read with the data it goes with. */
export async function loadPdfIdentity(db: Db, tenantId: string): Promise<PdfIdentity> {
  return { company: await loadCompanyProfile(db, tenantId), dateFormat: await getSettingValue<string>(db, tenantId, 'general.date_format') };
}

/** Everything a document needs. Images are read here, outside any transaction, and one that cannot be read is left out: a document does not fail for its stamp. */
export async function loadPdfContext(app: FastifyInstance, identity: PdfIdentity): Promise<PdfContext> {
  const { env } = app.deps;
  const [logo, signature, stamp] = await Promise.all([loadLogo(app), loadStored(identity.company.signatureKey), loadStored(identity.company.stampKey)]);
  return { ...identity, brandName: env.BRAND_NAME, productName: env.BRAND_PRODUCT_NAME, legalName: identity.company.legalName ?? organizationName(env),
    primaryColor: env.BRAND_PRIMARY_COLOR, locale: env.BRAND_LOCALE, currency: env.BRAND_CURRENCY, images: { logo, signature, stamp } };
}

// ---------------------------------------------------------------- text
/** Windows-1252 outside Latin-1, which is what the standard fonts draw. */
const WIN_ANSI_EXTRA = new Set([0x20ac, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x17d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x17e, 0x178]);
const printable = (code: number) => (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(code);
const PLAIN = /^[\x20-\x7e]*$/;
const SPACES = /[\t\r\n\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g;
const MARKS = /\p{M}+/gu;

/** Text the standard fonts can draw, and whether anything had to go. Accents that have no glyph come off (`ā` to `a`); anything else becomes `?`. */
export function printableText(raw: string): { text: string; lossy: boolean } {
  if (PLAIN.test(raw)) return { text: raw, lossy: false };
  let text = ''; let lossy = false;
  for (const ch of raw.normalize('NFC').replace(/₹/g, 'INR ').replace(SPACES, ' ')) {
    const code = ch.codePointAt(0)!;
    if (printable(code)) { text += ch; continue; }
    if (code < 0x20 || (code >= 0x7f && code < 0xa0) || code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) continue;
    const bare = ch.normalize('NFD').replace(MARKS, '');
    if (bare && [...bare].every((c) => printable(c.codePointAt(0)!))) { text += bare; continue; }
    text += '?'; lossy = true;
  }
  return { text, lossy };
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** An ISO date in the organization's format. */
export function formatDate(v: unknown, format: string): string {
  const iso = v instanceof Date ? v.toISOString() : String(v ?? '');
  const m = ISO_DATE.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  if (format === 'DD/MM/YYYY') return `${d}/${mo}/${y}`;
  if (format === 'DD-MM-YYYY') return `${d}-${mo}-${y}`;
  if (format === 'DD-MMM-YYYY') return `${d}-${SHORT_MONTHS[Number(mo) - 1] ?? mo}-${y}`;
  return `${y}-${mo}-${d}`;
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const INK = '#222222';
export const MUTED = '#666666';
export const BOLD = 'Helvetica-Bold';
export const REGULAR = 'Helvetica';

/** One document: the brand's letterhead and footer, and text and numbers the fonts can draw. */
export class PdfWriter {
  readonly doc: Doc;
  /** Headings and rules: the brand's colour, unless it would be too pale to read on paper. */
  readonly accent: string;
  /** What to print on a bar of the brand's colour. */
  readonly onPrimary: string;
  readonly margin: number;
  private lossy = false;
  private numbers: Intl.NumberFormat;
  private page = 1;

  constructor(readonly ctx: PdfContext, o: { title: string; landscape?: boolean; margin?: number }) {
    this.margin = o.margin ?? 48;
    this.doc = new PDFDocument({ size: 'A4', layout: o.landscape ? 'landscape' : 'portrait', margin: this.margin, bufferPages: false, compress: true,
      info: { Title: printableText(o.title).text, Author: printableText(ctx.brandName).text, Creator: printableText(ctx.productName).text } });
    this.accent = luminance(ctx.primaryColor) > 0.75 ? INK : ctx.primaryColor;
    this.onPrimary = luminance(ctx.primaryColor) > 0.55 ? INK : '#ffffff';
    this.numbers = new Intl.NumberFormat(ctx.locale, { numberingSystem: 'latn', minimumFractionDigits: 2, maximumFractionDigits: 2 });
    this.doc.on('pageAdded', () => { this.page++; this.footer(); this.body(); });
    this.footer();
    this.body();
  }

  get usableWidth() { return this.doc.page.width - this.margin * 2; }
  /** The lowest a row may reach: the footer sits below it. */
  get bottom() { return this.doc.page.height - this.margin; }

  body(size = 10.5) { this.doc.font(REGULAR).fontSize(size).fillColor(INK); }

  /** Text for the page. Every string that came from data goes through here. */
  t(v: unknown): string {
    const { text, lossy } = printableText(String(v ?? ''));
    if (lossy) this.lossy = true;
    return text;
  }
  /** An amount without its currency, for a column headed with it. */
  amount(n: number | string) { return this.numbers.format(Number(n)).replace(SPACES, ' ').replace(/−/g, '-'); }
  /** An amount with the ISO code: the standard fonts have no rupee sign. */
  money(n: number | string) { return `${this.ctx.currency} ${this.amount(n)}`; }
  date(v: unknown) { return formatDate(v, this.ctx.dateFormat); }

  private footer() {
    const { doc } = this; const [x, y] = [doc.x, doc.y]; const at = doc.page.height - this.margin + 14;
    doc.font(REGULAR).fontSize(7.5).fillColor(MUTED);
    doc.text(printableText(`${this.ctx.brandName} · Generated by ${this.ctx.productName} · Confidential`).text, this.margin, at, { lineBreak: false });
    const n = `Page ${this.page}`;
    doc.text(n, doc.page.width - this.margin - doc.widthOfString(n), at, { lineBreak: false });
    doc.x = x; doc.y = y;
  }

  /** The brand at the top left (logo, or the name if there is none we can draw), and who the employer is at the right. */
  letterhead(details: 'full' | 'short' = 'full') {
    const { doc, ctx, margin } = this; const top = margin; const c = ctx.company;
    let drawn = false;
    if (ctx.images.logo) {
      try { doc.image(ctx.images.logo, margin, top, { fit: [130, 48] }); drawn = true; } catch { drawn = false; }
    }
    if (!drawn) doc.font(BOLD).fontSize(16).fillColor(this.accent).text(this.t(ctx.brandName), margin, top + 4, { width: 220 });
    const rightX = margin + 230; const width = this.usableWidth - 230;
    doc.font(BOLD).fontSize(10.5).fillColor(INK).text(this.t(ctx.legalName), rightX, top, { width, align: 'right' });
    const ids = details === 'full'
      ? [c.cin && `CIN ${c.cin}`, c.gstin && `GSTIN ${c.gstin}`, c.tan && `TAN ${c.tan}`, c.pfRegistration && `PF ${c.pfRegistration}`, c.esiRegistration && `ESI ${c.esiRegistration}`, c.ptRegistration && `PT ${c.ptRegistration}`]
      : [c.cin && `CIN ${c.cin}`, c.gstin && `GSTIN ${c.gstin}`];
    doc.font(REGULAR).fontSize(8).fillColor(MUTED);
    if (c.registeredAddress) doc.text(this.t(c.registeredAddress), rightX, doc.y + 1, { width, align: 'right' });
    const line = ids.filter(Boolean).join('  ·  ');
    if (line) doc.text(this.t(line), rightX, doc.y + 1, { width, align: 'right' });
    const y = Math.max(doc.y, top + 50) + 6;
    doc.moveTo(margin, y).lineTo(margin + this.usableWidth, y).lineWidth(1.5).strokeColor(this.accent).stroke();
    doc.x = margin; doc.y = y + 12;
    this.body();
  }

  /** The signature, stamp and signatory, for whichever of them this organization has. */
  signOff(o: { always: boolean }) {
    const { doc, ctx, margin } = this; const c = ctx.company; const { signature, stamp } = ctx.images;
    if (!o.always && !signature && !stamp && !c.signatoryName) return;
    if (doc.y + 110 > this.bottom) doc.addPage();
    doc.x = margin; doc.moveDown(1);
    this.body(10);
    doc.text(this.t(`For ${ctx.legalName}`), margin);
    const y = doc.y + 4;
    const place = (img: Buffer | null, x: number) => { if (!img) return false; try { doc.image(img, x, y, { fit: [110, 50] }); return true; } catch { return false; } };
    const drew = [place(signature, margin), place(stamp, margin + 130)].some(Boolean);
    doc.x = margin; doc.y = y + (drew ? 56 : 30);
    this.body(10);
    doc.font(BOLD).text(this.t(c.signatoryName ?? 'Authorised signatory'), margin);
    doc.font(REGULAR);
    if (c.signatoryDesignation) doc.text(this.t(c.signatoryDesignation), margin);
  }

  /** Said at the end, once it is known: what the page could not show. */
  closingNotes(extra: string[] = []) {
    const notes = [...extra, ...(this.lossy ? ['Some characters could not be printed in this document\'s font and appear as "?". The record in the system is unchanged.'] : [])];
    if (!notes.length) return;
    const { doc, margin } = this;
    if (doc.y + 16 * notes.length + 8 > this.bottom) doc.addPage();
    doc.x = margin; doc.y += 8;
    doc.font(REGULAR).fontSize(8).fillColor(MUTED);
    for (const n of notes) doc.text(printableText(n).text, margin, doc.y, { width: this.usableWidth });
  }
}

/** The answer for a document: named, never stored by anything between here and the reader. The name carries no L4. */
export const pdfHeaders = (reply: FastifyReply, fileName: string) =>
  reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${fileName}"`).header('cache-control', 'private, no-store');
