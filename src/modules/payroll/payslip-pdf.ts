import { BOLD, INK, MUTED, PdfWriter, REGULAR, type Doc, type PdfContext } from '../../core/pdf/writer.js';
import type { Line } from './calc.js';

export type PayslipData = {
  period: string;
  kind: string;
  days_in_period: string;
  employed_days: string;
  lop_days: string;
  paid_days: string;
  employee_code: string;
  name: string;
  designation: string | null;
  date_of_joining: string;
  department: string | null;
  branch: string;
  legal_entity: string;
  uan: string | null;
  ifsc: string | null;
  pan: string | null;
  account: string | null;
  lines: Line[];
  gross: string;
  deductions: string;
  net: string;
};

const monthName = (w: PdfWriter, period: string) => {
  const label = new Intl.DateTimeFormat(w.ctx.locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${period}-01T00:00:00Z`));
  // A locale whose month names the standard fonts cannot draw keeps the numbers.
  return /^[\x20-\x7e]*$/.test(label) ? label : period;
};

/**
 * One page, drawn in a moment and then read out as a stream: the whole file exists in memory for that moment, and an image or font problem can still
 * become an ordinary error answer, because nothing has been sent. Employer contributions are not on it: they are not part of the employee's pay.
 */
export function payslipPdf(ctx: PdfContext, p: PayslipData, state: { status: string; hold: boolean }): Doc {
  const w = new PdfWriter(ctx, { title: `Payslip ${p.period}` });
  const { doc, margin, usableWidth: width } = w;
  w.letterhead('full');
  const heading = p.kind === 'fnf' ? 'Full and final settlement' : 'Payslip';
  doc
    .font(BOLD)
    .fontSize(14)
    .fillColor(w.accent)
    .text(`${heading} for ${monthName(w, p.period)}`, margin, doc.y);
  // Staff can open a slip the employee cannot see yet. It must say so on its face.
  const notFinal = !['finalized', 'paid'].includes(state.status);
  if (notFinal || state.hold) {
    doc
      .moveDown(0.3)
      .font(BOLD)
      .fontSize(10)
      .fillColor('#b00020')
      .text(
        [notFinal ? `NOT FINAL: this payroll run is ${w.t(state.status)}.` : '', state.hold ? 'ON HOLD: this pay has not been released.' : ''].filter(Boolean).join(' '),
        margin,
        doc.y,
        { width },
      );
  }
  doc.moveDown(0.6);

  const details: [string, string | null][] = [
    ['Name', p.name],
    ['Employee code', p.employee_code],
    ['Designation', p.designation],
    ['Department', p.department],
    ['Branch', p.branch],
    ['Legal entity', p.legal_entity],
    ['Date of joining', w.date(p.date_of_joining)],
    ['UAN', p.uan],
    ['PAN', p.pan],
    ['Bank account', p.account],
    ['IFSC', p.ifsc],
    ['Days in period', p.days_in_period],
    ['Days employed', p.employed_days],
    ['Loss of pay days', p.lop_days],
    ['Paid days', p.paid_days],
  ];
  const shown = details.filter(([, v]) => v !== null && v !== '');
  const half = Math.ceil(shown.length / 2);
  const col = width / 2;
  const top = doc.y;
  const rowH = 15;
  shown.forEach(([k, v], i) => {
    const x = margin + (i < half ? 0 : col);
    const y = top + (i < half ? i : i - half) * rowH;
    doc.font(REGULAR).fontSize(8.5).fillColor(MUTED).text(k, x, y, { lineBreak: false });
    doc
      .font(BOLD)
      .fontSize(9)
      .fillColor(INK)
      .text(w.t(v), x + 85, y, { width: col - 95, height: rowH, ellipsis: true, lineBreak: false });
  });
  let y = top + half * rowH + 10;

  const earnings = p.lines.filter((l) => l.kind === 'earning' && l.amount !== 0);
  const deductions = p.lines.filter((l) => l.kind === 'deduction' && l.amount !== 0);
  const head = (x: number, label: string) => {
    doc.rect(x, y, col - 6, 18).fill(ctx.primaryColor);
    doc
      .font(BOLD)
      .fontSize(9)
      .fillColor(w.onPrimary)
      .text(label, x + 6, y + 5, { lineBreak: false });
    const amount = `Amount (${ctx.currency})`;
    doc.text(amount, x + col - 12 - doc.widthOfString(amount), y + 5, { lineBreak: false });
  };
  const headers = () => {
    head(margin, 'Earnings');
    head(margin + col + 6, 'Deductions');
    y += 22;
  };
  const room = (needed: number) => {
    if (y + needed > w.bottom) {
      doc.addPage();
      y = margin;
      return true;
    }
    return false;
  };
  const line = (l: Line | undefined, x: number) => {
    if (!l) return;
    doc
      .font(REGULAR)
      .fontSize(9)
      .fillColor(INK)
      .text(w.t(l.name), x + 6, y, { lineBreak: false });
    const amount = w.amount(l.amount);
    doc.text(amount, x + col - 12 - doc.widthOfString(amount), y, { lineBreak: false });
  };
  headers();
  for (let i = 0; i < Math.max(earnings.length, deductions.length, 1); i++) {
    if (room(15)) headers();
    line(earnings[i], margin);
    line(deductions[i], margin + col + 6);
    y += 15;
  }
  y += 2;

  const total = (x: number, label: string, value: string) => {
    doc
      .moveTo(x, y)
      .lineTo(x + col - 6, y)
      .lineWidth(0.75)
      .strokeColor(INK)
      .stroke();
    doc
      .font(BOLD)
      .fontSize(9)
      .fillColor(INK)
      .text(label, x + 6, y + 5, { lineBreak: false });
    const amount = w.amount(value);
    doc.text(amount, x + col - 12 - doc.widthOfString(amount), y + 5, { lineBreak: false });
  };
  room(60);
  total(margin, 'Gross earnings', p.gross);
  total(margin + col + 6, 'Total deductions', p.deductions);
  y += 26;

  doc.rect(margin, y, width, 26).fill(ctx.primaryColor);
  doc
    .font(BOLD)
    .fontSize(11)
    .fillColor(w.onPrimary)
    .text('Net pay', margin + 8, y + 8, { lineBreak: false });
  const net = w.money(p.net);
  doc.text(net, margin + width - 8 - doc.widthOfString(net), y + 8, { lineBreak: false });
  doc.x = margin;
  doc.y = y + 36;

  w.body(8);
  doc.fillColor(MUTED).text('This is a computer-generated document.', margin, doc.y, { width });
  w.signOff({ always: false });
  w.closingNotes();
  doc.end();
  return doc;
}
