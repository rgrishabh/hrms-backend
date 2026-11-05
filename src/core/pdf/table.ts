import { setTimeout as sleep } from 'node:timers/promises';
import { BOLD, INK, MUTED, PdfWriter, REGULAR, type PdfContext } from './writer.js';

export type CellType = 'text' | 'int' | 'number' | 'percent' | 'money' | 'date';
export interface TableColumn { key: string; label: string; type: CellType }
export interface TableInput { title: string; subtitle: string[]; notes: string[]; columns: TableColumn[]; rows: Record<string, unknown>[]; totals: Record<string, unknown> | null }

const MARGIN = 28;
const SIZES = [8, 7.5, 7, 6.5, 6];
const CELL_PAD = 3;
const MIN_TEXT_WIDTH = 28;
const WIDTH_SAMPLE = 200;
/** How long drawing may hold the event loop before it lets others run. Measured in D52. */
export const SLICE_MS = 8;
/** Stop drawing while this much is waiting for a slow reader, so a large report does not pile up in memory. */
const MAX_BUFFERED_BYTES = 256 * 1024;
const TRUNCATED_NOTE = 'Long values are cut to fit, ending in "...". The CSV and Excel exports hold them in full.';
const NUMERIC = /^-?\d+(\.\d+)?$/;

const isText = (c: TableColumn) => c.type === 'text';
const asNumber = (v: unknown) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && NUMERIC.test(v.trim()));

export interface TableStats { yields: number; truncated: boolean }

/**
 * A report on landscape A4: one line a row, so that rows and pages are known in advance and drawing stays cheap. A number is never cut: it is
 * drawn smaller if it has to be. Text is cut, with a note. The header comes back on every page. Rows are drawn in slices with the event loop
 * let through between them, and the document is a stream, so a finished page leaves for the client while the next one is drawn.
 */
export class ReportTable {
  readonly w: PdfWriter;
  private size = SIZES[0]!;
  private widths: number[] = [];
  private rowHeight = 12;
  private truncated = false;
  private y = 0;
  private rowIndex = 0;
  private yields = 0;

  /** `sliceMs`: only `scripts/perf-report-pdf.ts` changes it, to measure what not yielding would cost. */
  constructor(ctx: PdfContext, private input: TableInput, private o: { sliceMs: number } = { sliceMs: SLICE_MS }) {
    this.w = new PdfWriter(ctx, { title: input.title, landscape: true, margin: MARGIN });
  }

  private cell(c: TableColumn, v: unknown): string {
    if (v === null || v === undefined || v === '') return '';
    if (c.type === 'date') return this.w.date(v);
    if (c.type === 'money' && asNumber(v)) return this.w.amount(Number(v));
    if ((c.type === 'number' || c.type === 'percent') && asNumber(v)) return this.w.amount(Number(v));
    return this.w.t(v);
  }

  /** Numbers and dates get what they need, and text shares the rest. If that does not fit, everything gets smaller. */
  private layout() {
    const { doc } = this.w; const { columns, rows, totals } = this.input;
    const sample = rows.slice(0, WIDTH_SAMPLE).concat(totals ? [totals] : []);
    const usable = this.w.usableWidth;
    for (const size of SIZES) {
      this.size = size;
      doc.font(REGULAR).fontSize(size);
      const natural = columns.map((c) => {
        const body = sample.reduce((m, r) => Math.max(m, doc.widthOfString(this.cell(c, r[c.key]))), 0);
        return body + CELL_PAD * 2;
      });
      doc.font(BOLD);
      const head = columns.map((c) => Math.min(70, doc.widthOfString(this.w.t(c.label)) + CELL_PAD * 2));
      const fixed = columns.reduce((t, c, i) => t + (isText(c) ? 0 : Math.max(natural[i]!, head[i]!)), 0);
      const texts = columns.map((c, i) => (isText(c) ? Math.max(natural[i]!, head[i]!, MIN_TEXT_WIDTH) : 0));
      const wantText = texts.reduce((a, b) => a + b, 0);
      const room = usable - fixed;
      const textCount = columns.filter(isText).length;
      const fits = room >= textCount * MIN_TEXT_WIDTH;
      if (fits || size === SIZES[SIZES.length - 1]) {
        const scale = fits ? (wantText > room ? room / wantText : 1) : 0;
        let widths = columns.map((c, i) => (isText(c) ? Math.max(MIN_TEXT_WIDTH, texts[i]! * scale) : Math.max(natural[i]!, head[i]!)));
        // Whatever is left over or still over goes evenly, so the table always spans the page exactly.
        const total = widths.reduce((a, b) => a + b, 0);
        widths = widths.map((x) => (x * usable) / total);
        this.widths = widths;
        this.rowHeight = size * 1.65;
        return;
      }
    }
  }

  private header() {
    const { doc, ctx } = this.w; const { columns } = this.input;
    doc.font(BOLD).fontSize(this.size);
    const headerHeight = Math.max(...columns.map((c, i) => doc.heightOfString(this.w.t(c.label), { width: this.widths[i]! - CELL_PAD * 2 }))) + 6;
    doc.rect(MARGIN, this.y, this.w.usableWidth, headerHeight).fill(ctx.primaryColor);
    doc.font(BOLD).fontSize(this.size).fillColor(this.w.onPrimary);
    let x = MARGIN;
    columns.forEach((c, i) => {
      const width = this.widths[i]! - CELL_PAD * 2;
      doc.text(this.w.t(c.label), x + CELL_PAD, this.y + 3, { width, align: isText(c) ? 'left' : 'right' });
      x += this.widths[i]!;
    });
    this.y += headerHeight;
  }

  private fit(c: TableColumn, s: string, room: number): { text: string; size: number } {
    const { doc } = this.w;
    const width = doc.widthOfString(s);
    if (width <= room) return { text: s, size: this.size };
    if (!isText(c)) return { text: s, size: Math.max(3, (this.size * room) / width) };
    this.truncated = true;
    const ellipsis = doc.widthOfString('...');
    let low = 0; let high = s.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (doc.widthOfString(s.slice(0, mid)) + ellipsis <= room) low = mid; else high = mid - 1;
    }
    return { text: `${s.slice(0, low).trimEnd()}...`, size: this.size };
  }

  private row(r: Record<string, unknown>, bold: boolean, shaded: boolean) {
    const { doc } = this.w; const { columns } = this.input;
    if (shaded) doc.rect(MARGIN, this.y, this.w.usableWidth, this.rowHeight).fill('#f3f5f7');
    doc.font(bold ? BOLD : REGULAR).fontSize(this.size).fillColor(INK);
    let x = MARGIN;
    const textY = this.y + (this.rowHeight - this.size) / 2;
    columns.forEach((c, i) => {
      const room = this.widths[i]! - CELL_PAD * 2;
      const raw = bold && i === 0 ? 'Total' : this.cell(c, r[c.key]);
      if (raw) {
        const { text, size } = this.fit(c, raw, room);
        if (size !== this.size) doc.fontSize(size);
        const left = isText(c) ? x + CELL_PAD : x + this.widths[i]! - CELL_PAD - doc.widthOfString(text);
        doc.text(text, left, textY, { lineBreak: false });
        if (size !== this.size) doc.fontSize(this.size);
      }
      x += this.widths[i]!;
    });
    this.y += this.rowHeight;
  }

  private newPage() {
    const { doc } = this.w;
    doc.addPage();
    doc.font(BOLD).fontSize(8).fillColor(MUTED).text(this.w.t(this.input.title), MARGIN, MARGIN, { lineBreak: false });
    this.y = MARGIN + 12;
    this.header();
  }

  /** The first page, up to the header. Synchronous, so a mistake here is still an ordinary error answer. */
  start() {
    const { w, input } = this; const { doc } = w;
    this.layout();
    w.letterhead('short');
    doc.font(BOLD).fontSize(13).fillColor(w.accent).text(w.t(input.title), MARGIN, doc.y, { width: w.usableWidth });
    doc.font(REGULAR).fontSize(8).fillColor(MUTED);
    for (const s of input.subtitle) doc.text(w.t(s), MARGIN, doc.y, { width: w.usableWidth });
    for (const n of input.notes) doc.text(w.t(n), MARGIN, doc.y, { width: w.usableWidth });
    this.y = doc.y + 6;
    this.header();
  }

  /** The remaining rows, the totals and the end of the file. Stops without a sound if the client went away, which destroys the stream. */
  async finish(): Promise<TableStats> {
    const { w, input } = this; const { doc } = w;
    let slice = performance.now();
    const total = input.rows.length;
    for (; this.rowIndex < total; this.rowIndex++) {
      if (doc.destroyed) return this.stats();
      if (this.y + this.rowHeight > w.bottom) this.newPage();
      this.row(input.rows[this.rowIndex]!, false, this.rowIndex % 2 === 1);
      if (performance.now() - slice >= this.o.sliceMs) { await this.breathe(); slice = performance.now(); }
    }
    if (doc.destroyed) return this.stats();
    if (input.totals) {
      if (this.y + this.rowHeight > w.bottom) this.newPage();
      doc.moveTo(MARGIN, this.y).lineTo(MARGIN + w.usableWidth, this.y).lineWidth(0.75).strokeColor(INK).stroke();
      this.row(input.totals, true, false);
    }
    if (!total) doc.font(REGULAR).fontSize(9).fillColor(MUTED).text('No rows.', MARGIN, this.y + 6, { lineBreak: false });
    doc.x = MARGIN; doc.y = this.y + (total ? 2 : 20);
    w.closingNotes(this.truncated ? [TRUNCATED_NOTE] : []);
    doc.end();
    return this.stats();
  }

  private stats(): TableStats { return { yields: this.yields, truncated: this.truncated }; }

  private async breathe() {
    this.yields++;
    await new Promise((resolve) => setImmediate(resolve));
    const { doc } = this.w;
    while (!doc.destroyed && doc.readableLength > MAX_BUFFERED_BYTES) await sleep(5);
  }
}
