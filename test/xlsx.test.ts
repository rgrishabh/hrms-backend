import { describe, it, expect } from 'vitest';
import { xlsx } from '../src/core/http/xlsx.js';
import { readXlsx } from './helpers.js';

describe('xlsx writer', () => {
  const book = readXlsx(xlsx([{
    name: 'Headcount: by dept/branch [2026]',
    columns: [{ label: 'Code', type: 'text' }, { label: 'Note', type: 'text' }, { label: 'Joined', type: 'date' }, { label: 'Salary', type: 'money' }, { label: 'Att %', type: 'percent' }, { label: 'Any' }],
    rows: [['0042', '=HYPERLINK("http://x")', '2024-03-15', '52500.50', 97.5, '12.5'], ['E2', 'A & B <c>\u0007', null, 1000, null, 'n/a']],
    totals: ['Total', null, null, 53500.5, null, null],
  }]));
  const sheet = book['xl/worksheets/sheet1.xml']!;

  it('is a complete package with a valid sheet name', () => {
    expect(Object.keys(book).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
    expect(book['xl/workbook.xml']).toContain('<sheet name="Headcount  by dept branch  2026" sheetId="1"');
  });
  it('keeps text as text: leading zeros, formula-looking text, escaped markup, no control characters', () => {
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">0042</t>');
    expect(sheet).toContain('=HYPERLINK(&quot;http://x&quot;)');
    expect(sheet).not.toContain('<f>');
    expect(sheet).toContain('A &amp; B &lt;c&gt;</t>');
  });
  it('types numbers, money, percentages and dates; totals are bold', () => {
    expect(sheet).toContain('<c r="C2" s="5"><v>45366</v></c>');      // 15 March 2024 as an Excel date serial
    expect(sheet).toContain('<c r="D2" s="3"><v>52500.5</v></c>');
    expect(sheet).toContain('<c r="E2" s="4"><v>97.5</v></c>');
    expect(sheet).toContain('<c r="F2"><v>12.5</v></c>');
    expect(sheet).toContain('<c r="F3" t="inlineStr"><is><t xml:space="preserve">n/a</t>');
    expect(sheet).toContain('<c r="D4" s="7"><v>53500.5</v></c>');
    expect(sheet).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(sheet).toContain('<autoFilter ref="A1:F3"/>');
  });
});
