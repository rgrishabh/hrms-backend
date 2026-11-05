/**
 * CSV for spreadsheets: RFC 4180 quoting, CRLF rows, and cells that a spreadsheet would run as a formula are prefixed with '. A plain negative number is data, and stays a number.
 * Leading white space and the full-width forms count, because some spreadsheet locales read past or fold them. A semicolon is quoted because it is the separator in those same locales.
 */
export const csvCell = (v: unknown) => {
  let s = v == null ? '' : String(v);
  if (/^[\s\u3000]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/.test(s) && !/^-\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  else if (/^[\t\r\n]/.test(s)) s = `'${s}`;
  return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const csv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
