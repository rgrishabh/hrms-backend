import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pino from 'pino';
import { LOG_REDACT_PATHS, logSerializers, pathOnly } from '../src/core/logging.js';
import { LOG_REDACTED_FIELDS } from '../src/core/policy/classification.js';
import { hasAmount, scrubAmounts } from '../src/core/policy/text.js';
import { makeApp, createTenant, flags, ownerQuery, inApp } from './helpers.js';
import { notifyUsers } from '../src/core/notify/service.js';
import { withTenant } from '../src/db/tx.js';

const walk = async (dir: string): Promise<string[]> => (await Promise.all((await readdir(dir, { withFileTypes: true })).map((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)])))).flat();

describe('L3 and L4 stay out of logs, errors, analytics and URLs', () => {
  const capture = () => {
    const lines: string[] = [];
    const log = pino({ redact: LOG_REDACT_PATHS, serializers: logSerializers }, new Writable({ write(c, _e, done) { lines.push(String(c)); done(); } }));
    return { log, lines };
  };

  it('redacts classified fields by name, wherever they sit in a logged object', () => {
    const { log, lines } = capture();
    const secret = 'S3CRET-VALUE';
    for (const f of LOG_REDACTED_FIELDS) { log.info({ [f]: secret }, 'top'); log.info({ body: { [f]: secret } }, 'nested'); }
    expect(lines.length).toBe(LOG_REDACTED_FIELDS.length * 2);
    expect(lines.join('')).not.toContain(secret);
  });

  it('a database error logs without the row it quotes', () => {
    const { log, lines } = capture();
    const err = Object.assign(new Error('duplicate key'), { detail: 'Key (phone)=(+91 9000000001) already exists.', where: 'x', parameters: ['ABCDE1234F'] });
    log.error({ err: { message: err.message, detail: err.detail, where: err.where, parameters: err.parameters } }, 'unhandled error');
    expect(lines.join('')).not.toMatch(/9000000001|ABCDE1234F/);
  });

  it('the logged URL has no query string', () => {
    const { log, lines } = capture();
    log.info({ req: { method: 'GET', url: '/api/v1/employees?search=9000000001', headers: { host: 'x', cookie: 'c' } } }, 'incoming');
    expect(lines.join('')).not.toContain('9000000001');
    expect(lines.join('')).not.toContain('cookie');
    expect(pathOnly('/a?b=c')).toBe('/a');
  });

  it('no route or query parameter carries L3 or L4', async () => {
    const files = (await walk(path.resolve('src/modules'))).filter((f) => f.endsWith('.ts'));
    const banned = /(?:req\.query[^;\n]*|Query[^;\n]*z\.object\([^)]*)\b(pan|aadhaar|accountNumber|account_number|salary|ctc|phone|dateOfBirth|date_of_birth|uan)\b/i;
    const hits: string[] = [];
    for (const f of files) for (const [i, line] of (await readFile(f, 'utf8')).split('\n').entries()) if (banned.test(line)) hits.push(`${f}:${i + 1}`);
    expect(hits).toEqual([]);
    const app = await makeApp(flags('default,payroll,payroll.statutory,loans,accounting_exports,reports.advanced'));
    expect(app.featureRoutes.filter((r) => /:(pan|aadhaar|account|salary|phone|uan)\b/i.test(r.url))).toEqual([]);
    await app.close();
  });

  it('the source has no console.log and does not interpolate figures into thrown errors', async () => {
    const files = (await walk(path.resolve('src'))).filter((f) => f.endsWith('.ts'));
    const hits: string[] = [];
    for (const f of files) for (const [i, line] of (await readFile(f, 'utf8')).split('\n').entries()) {
      // Command-line tools print to their operator; everything that runs in the API or the worker uses the logger.
      if (/console\.log\(/.test(line) && !path.dirname(f).endsWith(`${path.sep}db`)) hits.push(`${f}:${i + 1}`);
      if (/throw .*\$\{[^}]*\b(net|gross|outstanding|salary|ctc|pan|aadhaar)\b/i.test(line)) hits.push(`${f}:${i + 1}`);
    }
    expect(hits).toEqual([]);
  });

  it('text the server stores or sends never carries a figure', async () => {
    for (const t of ['Loan paid: ₹15,000', 'advance Rs. 1,500.50', 'INR 200', 'US$1,000.00', '1.000,50 €']) { expect(hasAmount(t), t).toBe(true); expect(scrubAmounts(t)).toContain('[amount removed]'); }
    expect(hasAmount('Payroll 2026-01 — review the register')).toBe(false);
    const app = await makeApp(flags('default'));
    const T = await createTenant();
    await inApp(app, () => withTenant(app.deps.pool, T.id, (db) => notifyUsers(db, T.id, [T.users.employee!.id], { kind: 'x', title: 'Loan paid: ₹15,000', body: 'Advance ₹2,000 paid' })));
    const [n] = await ownerQuery<{ title: string; body: string }>(`SELECT title, body FROM notifications WHERE tenant_id=$1 AND kind='x'`, [T.id]);
    expect(`${n!.title} ${n!.body}`).not.toMatch(/15,000|2,000/);
    await app.close();
  });
});
