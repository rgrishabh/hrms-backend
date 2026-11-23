import { BOLD, PdfWriter, REGULAR, type Doc, type PdfContext } from './writer.js';

/** One letter on the organization's letterhead: date, addressee, heading, paragraphs, signature. Every letter the product writes is drawn here. */
export function letterPdf(
  ctx: PdfContext,
  o: { title: string; today: string; to: readonly string[]; heading: string; paragraphs: (w: PdfWriter) => readonly string[]; acceptance?: string },
): Doc {
  const w = new PdfWriter(ctx, { title: o.title });
  const { doc, margin, usableWidth: width } = w;
  w.letterhead('short');
  doc
    .font(REGULAR)
    .fontSize(10)
    .text(`Date: ${w.date(o.today)}`, margin, doc.y, { width, align: 'right' });
  doc.moveDown(0.5);
  doc.text('To,', margin);
  o.to.forEach((line, i) => doc.font(i === 0 ? BOLD : REGULAR).text(w.t(line), margin));
  doc.moveDown(1);
  doc.font(BOLD).fontSize(12).fillColor(w.accent).text(w.t(o.heading), margin, doc.y, { width, align: 'center' });
  doc.moveDown(1);
  w.body(10.5);
  // A person's own text keeps its paragraphs: the writer turns a line break into a space.
  for (const p of o
    .paragraphs(w)
    .flatMap((x) => x.split(/\r?\n+/))
    .filter((x) => x.trim()))
    doc.text(w.t(p), margin, doc.y, { width, align: 'left', lineGap: 2, paragraphGap: 9 });
  w.signOff({ always: true });
  if (o.acceptance) {
    if (doc.y + 110 > w.bottom) doc.addPage();
    doc.x = margin;
    doc.moveDown(1.5);
    w.body(10);
    doc.text(w.t(o.acceptance), margin, doc.y, { width });
    doc.moveDown(2);
    doc.text('Signature: ____________________     Date: ____________________', margin);
  }
  w.closingNotes();
  doc.end();
  return doc;
}
