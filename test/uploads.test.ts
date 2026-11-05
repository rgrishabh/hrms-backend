import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { problem, Client, createTenant, flags, makeApp, multipart, ownerQuery, type TenantFixture } from './helpers.js';
import { ClamdScanner, setScanner, getScanner } from '../src/core/storage/clamav.js';
import { LocalStore, setStore } from '../src/core/storage/index.js';
import { detectFile } from '../src/core/storage/sniff.js';
import { ImageStructureError, stripJpeg, stripPng, stripWebp } from '../src/core/storage/strip.js';
import { loadEnv } from '../src/config/env.js';
import { TEST_APP_URL, TEST_BRAND } from './env.js';
import { GPS_MARK, ICC, JPEG_WITH_METADATA, PNG_WITH_METADATA, TINY_JPEG, TINY_PNG, WEBP_WITH_METADATA, exif } from './images.js';

/** The standard antivirus test string: harmless, and every scanner flags it. Assembled here so that this file is not itself flagged. */
const EICAR = `X5O!P%@AP[4\\PZX54(P^)7CC)7}$${'EICAR'}-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*`;

/** A clamd that speaks INSTREAM for real: parses the frames, and answers by what it reassembled. */
type Behaviour = 'scan' | 'error' | 'hang' | 'garbage' | 'close' | 'size-limit';
function fakeClamd(behaviour: () => Behaviour = () => 'scan') {
  const received: Buffer[] = [];
  const open = new Set<Socket>();
  const server: Server = createServer((socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    let buf: Buffer = Buffer.alloc(0); let started = false; const parts: Buffer[] = [];
    socket.on('error', () => undefined);
    socket.on('data', (d: Buffer) => {
      const b = behaviour();
      if (b === 'hang') return;
      if (b === 'close') { socket.destroy(); return; }
      buf = Buffer.concat([buf, d]);
      if (!started) {
        const end = buf.indexOf(0);
        if (end < 0) return;
        if (buf.toString('latin1', 0, end) !== 'zINSTREAM') { socket.end('UNKNOWN COMMAND\0'); return; }
        buf = buf.subarray(end + 1); started = true;
      }
      if (b === 'size-limit') { socket.end('INSTREAM size limit exceeded. ERROR\0'); return; }
      while (buf.length >= 4) {
        const n = buf.readUInt32BE(0);
        if (n === 0) {
          const all = Buffer.concat(parts);
          received.push(all);
          if (b === 'error') socket.end('stream: lstat() failed. ERROR\0');
          else if (b === 'garbage') socket.end('\0');
          else socket.end(all.includes(EICAR) ? 'stream: Win.Test.EICAR_HDB-1 FOUND\0' : 'stream: OK\0');
          return;
        }
        if (buf.length < 4 + n) return;
        parts.push(buf.subarray(4, 4 + n)); buf = buf.subarray(4 + n);
      }
    });
  });
  return new Promise<{ port: number; received: Buffer[]; close: () => Promise<void> }>((resolve) => server.listen(0, '127.0.0.1', () => {
    const a = server.address() as { port: number };
    resolve({ port: a.port, received, close: () => new Promise((r) => { server.close(() => r()); for (const c of open) c.destroy(); }) });
  }));
}

describe('clamd INSTREAM client', () => {
  it('sends the whole file in frames, across chunk boundaries, and reads a clean answer', async () => {
    const d = await fakeClamd();
    const big = Buffer.alloc(300 * 1024, 7);
    expect(await new ClamdScanner('127.0.0.1', d.port).scan(big)).toEqual({ clean: true });
    expect(d.received[0]!.equals(big)).toBe(true);
    await d.close();
  });

  it('EICAR comes back with its signature', async () => {
    const d = await fakeClamd();
    expect(await new ClamdScanner('127.0.0.1', d.port).scan(Buffer.from(EICAR))).toEqual({ clean: false, signature: 'Win.Test.EICAR_HDB-1' });
    await d.close();
  });

  it.each(['error', 'garbage', 'close', 'size-limit'] as const)('%s is never read as clean', async (b) => {
    const d = await fakeClamd(() => b);
    await expect(new ClamdScanner('127.0.0.1', d.port).scan(Buffer.alloc(100, 1))).rejects.toThrow(/clamd/);
    await d.close();
  });

  it('a silent clamd times out, and nothing listening is an error', async () => {
    const d = await fakeClamd(() => 'hang');
    await expect(new ClamdScanner('127.0.0.1', d.port, 100).scan(Buffer.alloc(10))).rejects.toThrow(/timed out/);
    await d.close();
    await expect(new ClamdScanner('127.0.0.1', d.port).scan(Buffer.alloc(10))).rejects.toThrow(/unreachable/);
  });
});

describe('startup', () => {
  const prod = { NODE_ENV: 'production', DATABASE_URL: TEST_APP_URL, DATABASE_SSL: 'disable', DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), ...TEST_BRAND };
  it('production with documents on refuses to start without CLAMAV_HOST', () => {
    expect(() => loadEnv({ ...prod, FEATURE_DOCUMENTS: 'true' })).toThrow(/CLAMAV_HOST is required/);
    expect(loadEnv({ ...prod, FEATURE_DOCUMENTS: 'true', CLAMAV_HOST: 'clamav' }).CLAMAV_PORT).toBe(3310);
    expect(loadEnv({ ...prod, FEATURE_DOCUMENTS: 'true', CLAMAV_HOST: 'clamav', CLAMAV_PORT: '3311' }).CLAMAV_PORT).toBe(3311);
  });
  it('production with documents off starts without it, and elsewhere it is optional', () => {
    expect(loadEnv({ ...prod, FEATURE_DOCUMENTS: 'false' }).CLAMAV_HOST).toBeUndefined();
    expect(() => loadEnv({ ...prod, NODE_ENV: 'development' })).not.toThrow();
  });
});

describe('uploads through the app', () => {
  let app: FastifyInstance; let T: TenantFixture; let hr: Client; let d: Awaited<ReturnType<typeof fakeClamd>>; let behaviour: Behaviour = 'scan';
  let category = ''; let root = '';
  const send = (name: string, content: Buffer, title = 'Scanned file') => {
    const m = multipart({ categoryId: category, title, employeeId: T.users.employee!.employeeId! }, { name, content });
    return hr.req('POST', '/api/v1/documents', m.body, m.headers);
  };
  const PDF = Buffer.from('%PDF-1.7\nplain\n%%EOF\n');
  const count = async () => (await ownerQuery<{ n: number }>(`SELECT count(*)::int AS n FROM documents WHERE tenant_id=$1`, [T.id]))[0]!.n;

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'hrms-uploads-'));
    d = await fakeClamd(() => behaviour);
    setStore(new LocalStore(root));
    app = await makeApp({ ...flags('default,attendance.selfie,core.policies,recruitment,expenses'), CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(d.port) }, { storeOverride: true });
    T = await createTenant();
    hr = await Client.login(app, T.host, T.users.hr!.email);
    const r = await hr.post('/api/v1/documents/categories', { code: 'SCAN', name: 'Scanned' });
    category = r.json().id;
  });
  afterAll(async () => { await app.close(); await d.close(); setStore(null); rmSync(root, { recursive: true, force: true }); });

  it('a clean file is scanned as it arrived, and stored', async () => {
    const r = await send('ok.pdf', PDF);
    expect(r.statusCode, r.body).toBe(201);
    expect(d.received.at(-1)!.equals(PDF)).toBe(true);
  });

  it('EICAR inside an allowed type is refused, nothing is stored, and the block is on the audit log', async () => {
    const before = await count();
    const r = await send('invoice.pdf', Buffer.from(`%PDF-1.7\n${EICAR}\n%%EOF\n`));
    expect(r.statusCode).toBe(422);
    expect(problem(r).code).toBe('malware_detected');
    expect(r.body).not.toContain('EICAR');
    expect(await count()).toBe(before);
    const [row] = await ownerQuery<{ change_metadata: { signature: string } }>(`SELECT change_metadata FROM audit_logs WHERE tenant_id=$1 AND action='upload.malware_blocked'`, [T.id]);
    expect(row!.change_metadata.signature).toBe('Win.Test.EICAR_HDB-1');
  });

  it('EICAR as a plain file does not get as far as the scanner: the content check refuses it first', async () => {
    const seen = d.received.length;
    const r = await send('eicar.pdf', Buffer.from(EICAR));
    expect(r.statusCode).toBe(415);
    expect(d.received.length).toBe(seen);
  });

  it.each(['error', 'close', 'garbage', 'size-limit'] as const)('clamd answering %s: the upload is refused and nothing is stored', async (b) => {
    const before = await count();
    behaviour = b;
    try {
      const r = await send('x.pdf', PDF);
      expect(r.statusCode).toBe(503);
      expect(problem(r).code).toBe('scanner_unavailable');
    } finally { behaviour = 'scan'; }
    expect(await count()).toBe(before);
  });

  it('production with no scanner refuses uploads, whichever module they belong to', async () => {
    const was = getScanner();
    setScanner(null, true);
    try { expect(problem((await send('x.pdf', PDF))).code).toBe('scanner_unavailable'); } finally { setScanner(was, false); }
  });

  it('no scanner outside production: stored without scanning', async () => {
    const was = getScanner();
    setScanner(null, false);
    try { expect((await send('x.pdf', PDF)).statusCode).toBe(201); } finally { setScanner(was, false); }
  });

  it('a stored image has lost its metadata; size and hash are of what was stored', async () => {
    const r = await send('photo.jpg', JPEG_WITH_METADATA, 'Photo');
    expect(r.statusCode, r.body).toBe(201);
    const [row] = await ownerQuery<{ storage_key: string; size_bytes: number; content_type: string }>(`SELECT storage_key, size_bytes, content_type FROM documents WHERE id=$1`, [r.json().id]);
    const stored = readFileSync(path.join(root, row!.storage_key));
    expect(stored.includes(GPS_MARK)).toBe(false);
    expect(stored.length).toBe(row!.size_bytes);
    expect(row!.content_type).toBe('image/jpeg');
    // The scanner saw the original.
    expect(d.received.at(-1)!.includes(GPS_MARK)).toBe(true);
    expect((await hr.get(`/api/v1/documents/${r.json().id}/download`)).statusCode).toBe(200); // the integrity check agrees
  });

  it('a file claiming to be an image that does not hold together is refused', async () => {
    const r = await send('bad.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]));
    expect(r.statusCode).toBe(415);
  });

  it('every upload route goes through the scanner', async () => {
    const seen = () => d.received.length;
    // Selfie.
    const emp = await Client.login(app, T.host, T.users.employee!.email);
    await ownerQuery(`INSERT INTO tenant_settings (tenant_id, setting_key, setting_value) VALUES ($1,'attendance.selfie_retention_days','90') ON CONFLICT DO NOTHING`, [T.id]);
    const m = multipart({}, { name: 'me.png', content: TINY_PNG });
    let n = seen();
    const selfie = await emp.req('POST', '/api/v1/attendance/selfies', m.body, m.headers);
    expect(selfie.statusCode, selfie.body).toBe(201);
    expect(seen()).toBe(n + 1);
    // Candidate resume.
    n = seen();
    const c = multipart({ firstName: 'Cand', email: `cand@${T.host}`, source: 'referral', consent: 'true', consentNote: 'Consent given' }, { name: 'cv.pdf', content: PDF });
    const cand = await hr.req('POST', '/api/v1/recruitment/candidates', c.body, c.headers);
    expect(cand.statusCode, cand.body).toBe(201);
    expect(seen()).toBe(n + 1);
  });
});

describe('no upload goes around the checks', () => {
  it('whatever stores a file a person sent has been through prepareUpload', () => {
    const root = 'src/modules';
    const users = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts')).map((f) => path.join(root, f)).filter((f) => /\.put\(key,/.test(readFileSync(f, 'utf8')));
    expect(users.sort()).toEqual(['attendance/routes.ts', 'documents/routes.ts', 'expenses/routes.ts', 'policies/routes.ts', 'recruitment/routes.ts', 'tenant/company.ts'].map((f) => path.join(root, f)));
    for (const f of users) expect(readFileSync(f, 'utf8'), f).toMatch(/await prepareUpload\(req, a,/);
  });
});

describe('magic bytes', () => {
  it('the content decides, whatever the name or the declared type', () => {
    expect(detectFile(TINY_PNG, 'photo.pdf')).toMatchObject({ contentType: 'image/png' });
    expect(detectFile(Buffer.from('<html><script>x</script>'), 'file.pdf')).toHaveProperty('error');
    expect(detectFile(Buffer.from('MZ\x90\0'), 'report.pdf')).toHaveProperty('error');
    expect(detectFile(Buffer.from('%PDF-1.7 /JavaScript (x)'), 'a.pdf')).toHaveProperty('error');
  });
});

describe('metadata stripping', () => {
  it('JPEG: Exif, XMP, IPTC, comments and what follows the image go; JFIF, colour profile and the image stay', () => {
    const out = stripJpeg(JPEG_WITH_METADATA);
    expect(out.includes(GPS_MARK)).toBe(false);
    expect(out.includes('Photoshop')).toBe(false);
    expect(out.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(out.subarray(-2).toString('hex')).toBe('ffd9');
    expect(out.includes('JFIF')).toBe(true);
    expect(out.includes(ICC)).toBe(true);
    expect(out.includes(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]))).toBe(true);
  });

  it('JPEG: the orientation survives on its own, so a phone photo stays upright', () => {
    const out = stripJpeg(JPEG_WITH_METADATA);
    const at = out.indexOf(Buffer.from('Exif\0\0', 'latin1'));
    expect(at).toBeGreaterThan(0);
    // Exif header, little-endian TIFF, the first directory right after it: one entry, the orientation tag, the value from the original.
    expect(out.toString('latin1', at + 6, at + 8)).toBe('II');
    expect(out.readUInt16LE(at + 14)).toBe(1);
    expect(out.readUInt16LE(at + 16)).toBe(0x0112);
    expect(out.readUInt16LE(at + 24)).toBe(6);
    expect(stripJpeg(stripJpeg(JPEG_WITH_METADATA)).equals(out)).toBe(true);
  });

  it('JPEG: nothing to strip changes nothing, and no Exif means none added', () => {
    expect(stripJpeg(TINY_JPEG).equals(TINY_JPEG)).toBe(true);
    expect(stripJpeg(TINY_JPEG).includes('Exif')).toBe(false);
    expect(exif(1).includes('Exif')).toBe(true);
  });

  it('PNG: text, Exif and time chunks and what follows IEND go', () => {
    const out = stripPng(PNG_WITH_METADATA);
    expect(out.includes(GPS_MARK)).toBe(false);
    for (const t of ['tEXt', 'eXIf', 'iTXt', 'tIME']) expect(out.includes(t)).toBe(false);
    for (const t of ['IHDR', 'IDAT', 'IEND']) expect(out.includes(t)).toBe(true);
    expect(stripPng(TINY_PNG).equals(TINY_PNG)).toBe(true);
  });

  it('WebP: Exif and XMP go, their flags are cleared, and the RIFF size is right', () => {
    const out = stripWebp(WEBP_WITH_METADATA);
    expect(out.includes(GPS_MARK)).toBe(false);
    expect(out.includes('EXIF')).toBe(false);
    expect(out.includes('XMP ')).toBe(false);
    expect(out[20]! & 0x0c).toBe(0);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(out.includes('VP8L')).toBe(true);
  });

  it.each([
    ['JPEG with a truncated segment', () => stripJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1]))],
    ['JPEG with no end', () => stripJpeg(Buffer.from([0xff, 0xd8]))],
    ['JPEG with junk between segments', () => stripJpeg(Buffer.from([0xff, 0xd8, 1, 2, 3, 4]))],
    ['PNG with a chunk past the end', () => stripPng(Buffer.concat([TINY_PNG.subarray(0, 8), Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 0x44, 0x41, 0x54, 0, 0, 0, 0])]))],
    ['PNG with no IEND', () => stripPng(TINY_PNG.subarray(0, 8))],
    ['WebP with a bad size', () => stripWebp(Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0xff, 0xff, 0, 0]), Buffer.from('WEBP', 'latin1')]))],
  ])('refuses %s', (_n, fn) => { expect(fn).toThrow(ImageStructureError); });
});
