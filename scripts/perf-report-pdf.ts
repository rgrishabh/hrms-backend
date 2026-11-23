/**
 * Measures drawing a report PDF at the row limit: how long the whole file takes and how long the event loop was held at once, with
 * the drawing yielding as it does in the API and, for comparison, with it not yielding. Needs no database.
 *
 *   npx tsx scripts/perf-report-pdf.ts
 */
import { PassThrough } from 'node:stream';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { ReportTable, type TableColumn } from '../src/core/pdf/table.js';
import type { PdfContext } from '../src/core/pdf/writer.js';
import { MAX_ROWS } from '../src/modules/reports/registry.js';

const ctx: PdfContext = {
  brandName: 'Perf Co',
  productName: 'Perf',
  legalName: 'Perf Co Ltd',
  primaryColor: '#1f5f8b',
  locale: 'en-IN',
  currency: 'INR',
  dateFormat: 'DD/MM/YYYY',
  images: { logo: null, signature: null, stamp: null },
  company: {
    legalName: null,
    gstin: null,
    pan: null,
    tan: null,
    cin: null,
    registeredAddress: null,
    pfRegistration: null,
    esiRegistration: null,
    ptRegistration: null,
    signatoryName: null,
    signatoryDesignation: null,
    signatureKey: null,
    stampKey: null,
  },
};
const columns: TableColumn[] = [
  { key: 'code', label: 'Code', type: 'text' },
  { key: 'name', label: 'Employee name', type: 'text' },
  { key: 'joined', label: 'Joined', type: 'date' },
  ...Array.from({ length: 12 }, (_, i): TableColumn => ({ key: `m${i}`, label: `Month ${i + 1}`, type: 'money' })),
];
const rows = Array.from({ length: MAX_ROWS }, (_, i) => ({
  code: `E${i}`,
  name: `A person with a long name, number ${i}`,
  joined: '2024-01-05',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, k) => [`m${k}`, 123456.78 + i + k])),
}));

async function measure(yielding: boolean) {
  const table = new ReportTable(ctx, { title: 'Perf', subtitle: [], notes: [], columns, rows, totals: null }, yielding ? undefined : { sliceMs: Number.POSITIVE_INFINITY });
  const out = new PassThrough();
  let bytes = 0;
  out.on('data', (b: Buffer) => {
    bytes += b.length;
  });
  const done = new Promise((resolve) => out.on('end', resolve));
  table.w.doc.pipe(out);
  const loop = monitorEventLoopDelay({ resolution: 1 });
  loop.enable();
  let last = performance.now();
  let worst = 0;
  const beat = setInterval(() => {
    const n = performance.now();
    worst = Math.max(worst, n - last);
    last = n;
  }, 1);
  const start = performance.now();
  table.start();
  const stats = await table.finish();
  worst = Math.max(worst, performance.now() - last);
  await done;
  const ms = performance.now() - start;
  clearInterval(beat);
  loop.disable();
  return {
    yielding,
    rows: rows.length,
    cells: rows.length * columns.length,
    totalMs: Math.round(ms),
    longestStallMs: Math.round(worst),
    yields: stats.yields,
    kb: Math.round(bytes / 1024),
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
  };
}
for (const y of [true, true, true, false]) process.stdout.write(`${JSON.stringify(await measure(y))}\n`);
