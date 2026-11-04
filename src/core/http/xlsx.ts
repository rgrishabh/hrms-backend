import { deflateRawSync } from 'node:zlib';

/**
 * Minimal Excel (.xlsx, Office Open XML) writer, no dependencies: one or more sheets with a bold, frozen header row,
 * an auto-filter, typed cells (numbers, money, percent, dates) and an optional bold totals row.
 * Text is always written as an inline string, never as a formula, so cell contents cannot run in a spreadsheet
 * (unlike CSV, nothing needs a leading apostrophe).
 */
export type XType = 'text' | 'int' | 'number' | 'money' | 'percent' | 'date' | 'auto';
export interface XColumn { label: string; type?: XType; width?: number }
export interface XSheet { name: string; columns: XColumn[]; rows: unknown[][]; totals?: unknown[] | null }

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Styles (cellXfs index): 0 general · 1 header · 2 integer · 3 money · 4 percent · 5 date · 6 bold · 7 bold money · 8 number
const STYLE: Record<Exclude<XType, 'auto'>, number> = { text: 0, int: 2, money: 3, percent: 4, date: 5, number: 8 };
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="0.0&quot;%&quot;"/><numFmt numFmtId="165" formatCode="dd\\-mmm\\-yyyy"/><numFmt numFmtId="166" formatCode="0.##"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF5"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// XML 1.0 forbids most control characters; drop them rather than produce a file Excel refuses to open.
// eslint-disable-next-line no-control-regex
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
const esc = (s: string) => clean(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i: number) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const NUMERIC = /^-?\d+(\.\d+)?$/;
const serial = (y: number, m: number, d: number) => (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000;

function cell(ref: string, v: unknown, type: XType, bold: boolean): string {
  if (v == null || v === '') return '';
  if (type === 'date') {
    const m = v instanceof Date ? [0, v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate()] : ISO_DATE.exec(String(v))?.map(Number);
    if (m) return `<c r="${ref}" s="5"><v>${serial(m[1]!, m[2]!, m[3]!)}</v></c>`;
  } else if (type !== 'text') {
    const s = typeof v === 'number' ? String(v) : String(v).trim();
    if ((typeof v === 'number' && Number.isFinite(v)) || NUMERIC.test(s)) {
      const style = type === 'auto' ? (bold ? 6 : 0) : type === 'money' && bold ? 7 : STYLE[type];
      return `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${Number(s)}</v></c>`;
    }
  }
  return `<c r="${ref}" t="inlineStr"${bold ? ' s="6"' : ''}><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
}

function sheetXml(s: XSheet): string {
  const widths = s.columns.map((c, i) => c.width ?? Math.min(60, Math.max(8, c.label.length + 2,
    ...s.rows.slice(0, 500).map((r) => (r[i] == null ? 0 : String(r[i]).length + 2)))));
  const head = `<row r="1">${s.columns.map((c, i) => `<c r="${colName(i)}1" t="inlineStr" s="1"><is><t xml:space="preserve">${esc(c.label)}</t></is></c>`).join('')}</row>`;
  const body = s.rows.map((r, ri) => `<row r="${ri + 2}">${s.columns.map((c, i) => cell(`${colName(i)}${ri + 2}`, r[i], c.type ?? 'auto', false)).join('')}</row>`);
  const totalRow = s.totals ? `<row r="${s.rows.length + 2}">${s.columns.map((c, i) => cell(`${colName(i)}${s.rows.length + 2}`, s.totals![i], c.type ?? 'auto', true)).join('')}</row>` : '';
  const last = `${colName(Math.max(0, s.columns.length - 1))}${s.rows.length + 1}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${head}${body.join('')}${totalRow}</sheetData>
${s.columns.length ? `<autoFilter ref="A1:${last}"/>` : ''}
</worksheet>`;
}

/** Excel limits sheet names to 31 characters without []:*?/\ and requires them to be unique. */
function sheetNames(sheets: XSheet[]) {
  const used = new Set<string>();
  return sheets.map((s, i) => {
    let n = s.name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || `Sheet${i + 1}`;
    for (let k = 2; used.has(n.toLowerCase()); k++) n = `${n.slice(0, 28)} ${k}`;
    used.add(n.toLowerCase());
    return n;
  });
}

export function xlsx(sheets: XSheet[]): Buffer {
  const names = sheetNames(sheets);
  const files: [string, string][] = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
<definedNames>${sheets.map((s, i) => (s.columns.length ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(names[i]!.replace(/'/g, "''"))}'!$A$1:$${colName(s.columns.length - 1)}$${s.rows.length + 1}</definedName>` : '')).join('')}</definedNames></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', STYLES_XML],
    ...sheets.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ];
  return zip(files.map(([n, c]) => [n, Buffer.from(c, 'utf8')]));
}

// ------------------------------------------------------------ ZIP (deflate), enough for OOXML packages
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function zip(entries: [string, Buffer][]): Buffer {
  const parts: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  const DOS_TIME = 0, DOS_DATE = (2024 - 1980) << 9 | 1 << 5 | 1;   // fixed timestamp: identical input gives an identical file
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8'); const packed = deflateRawSync(data); const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, packed);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(DOS_TIME, 12); cd.writeUInt16LE(DOS_DATE, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(packed.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}
