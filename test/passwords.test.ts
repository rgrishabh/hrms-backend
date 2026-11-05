import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { Client, createTenant, makeApp, ownerQuery, PASSWORD, type TenantFixture } from './helpers.js';
import { ARGON2, hashPassword, needsRehash, verifyPassword } from '../src/core/crypto/index.js';
import { isBreached, passwordProblems } from '../src/core/auth/password-policy.js';

const scrypt = promisify(scryptCb) as (p: string, s: Buffer, l: number, o: object) => Promise<Buffer>;
/** A hash as the previous release wrote it. */
const legacyHash = async (password: string) => {
  const salt = randomBytes(16);
  return ['scrypt', 32768, 8, 1, salt.toString('base64'), (await scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('base64')].join('$');
};

describe('hashing', () => {
  it('new hashes are Argon2id at the current cost, salted, and verify', async () => {
    const [a, b] = await Promise.all([hashPassword('correct horse battery'), hashPassword('correct horse battery')]);
    expect(a).toMatch(new RegExp(`^\\$argon2id\\$v=19\\$m=${ARGON2.memory},t=${ARGON2.passes},p=${ARGON2.parallelism}\\$`));
    expect(a).not.toBe(b);
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('wrong horse battery', a)).toBe(false);
    expect(needsRehash(a)).toBe(false);
  });

  it('a scrypt hash still verifies, and is marked for upgrade; a weaker Argon2id one too', async () => {
    const old = await legacyHash('old password here');
    expect(await verifyPassword('old password here', old)).toBe(true);
    expect(await verifyPassword('not the password', old)).toBe(false);
    expect(needsRehash(old)).toBe(true);
    expect(needsRehash(`$argon2id$v=19$m=19456,t=2,p=1$${'A'.repeat(22)}$${'A'.repeat(43)}`)).toBe(true);
  });

  it('no hash, or a broken one, is false', async () => {
    expect(await verifyPassword('anything at all', null)).toBe(false);
    expect(await verifyPassword('anything at all', 'garbage')).toBe(false);
    expect(await verifyPassword('anything at all', 'scrypt$1$2')).toBe(false);
  });

  it('the dummy for an unknown user costs what a real verification costs', async () => {
    const real = await hashPassword('correct horse battery');
    const time = async (stored: string | null) => {
      const samples: number[] = [];
      for (let i = 0; i < 7; i++) { const t = performance.now(); await verifyPassword('some guess at it', stored); samples.push(performance.now() - t); }
      return samples.sort((x, y) => x - y)[3]!;
    };
    const [known, unknown] = [await time(real), await time(null)];
    expect(Math.abs(known - unknown) / known, `known ${known} ms, unknown ${unknown} ms`).toBeLessThan(0.35);
  }, 20000);
});

describe('policy', () => {
  const c = { minLength: 12, email: 'priya.sharma@acme-labs.test', displayName: 'Priya Sharma' };
  it.each([
    ['short', 'Sh0rt!pass', 'too_short'],
    ['breached, whatever the case', 'PassWord1234', 'breached'],
    ['breached with a tail', 'qwertyuiopas!!', 'breached'],
    ['the local part of the email', 'priya.sharma-2026-x', 'personal'],
    ['a name', 'xx-Sharma-winter-77', 'personal'],
    ['the company in the domain', 'acme-labs-winter-77', 'personal'],
    ['one character', 'aaaaaaaaaaaaaaaa', 'too_simple'],
    ['a repeated block', 'abc1abc1abc1abc1', 'too_simple'],
  ])('refuses %s', (_n, pw, problem) => { expect(passwordProblems(pw, c)).toContain(problem); });

  it('takes a passphrase with no digit or capital, and a random string', () => {
    expect(passwordProblems('marble kettle orbit lantern', c)).toEqual([]);
    expect(passwordProblems('v7#Kq2!mZp9@xL', c)).toEqual([]);
  });

  it('a higher minimum from the organization counts; a lower one does not', () => {
    expect(passwordProblems('marble kettle orbit', { ...c, minLength: 24 })).toContain('too_short');
    expect(passwordProblems('v7#Kq2!mZp9', { ...c, minLength: 6 })).toContain('too_short');
  });

  it('the list is bundled and the check makes no network call', () => {
    const called: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = ((u: string) => { called.push(String(u)); return real(u); }) as typeof fetch;
    try { expect(isBreached('password1234')).toBe(true); expect(isBreached('marble kettle orbit lantern')).toBe(false); } finally { globalThis.fetch = real; }
    expect(called).toEqual([]);
    for (const file of ['src/core/auth/password-policy.ts']) expect(readFileSync(file, 'utf8')).not.toMatch(/node:(https?|net|dns)|fetch\(/);
  });
});

describe('through the app', () => {
  let app: FastifyInstance; let T: TenantFixture;
  beforeAll(async () => { app = await makeApp(); T = await createTenant(); });
  afterAll(async () => { await app.close(); });

  it('a scrypt account signs in and comes out with Argon2id, and the old password still works after', async () => {
    const user = T.users.employee!;
    await ownerQuery(`UPDATE users SET password_hash=$2 WHERE id=$1`, [user.id, await legacyHash(PASSWORD)]);
    await Client.login(app, T.host, user.email);
    const [row] = await ownerQuery<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id=$1`, [user.id]);
    expect(row!.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(PASSWORD, row!.password_hash)).toBe(true);
    await Client.login(app, T.host, user.email);
  });

  it('a wrong password leaves a scrypt hash as it is', async () => {
    const user = T.users.other!;
    const old = await legacyHash(PASSWORD);
    await ownerQuery(`UPDATE users SET password_hash=$2 WHERE id=$1`, [user.id, old]);
    expect((await new Client(app, T.host).post('/api/v1/auth/login', { email: user.email, password: 'not-the-password-1' })).statusCode).toBe(401);
    expect((await ownerQuery<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id=$1`, [user.id]))[0]!.password_hash).toBe(old);
  });

  it('changing a password goes through the policy, and says what is wrong', async () => {
    const c = await Client.login(app, T.host, T.users.manager!.email);
    const leaked = await c.post('/api/v1/auth/password', { currentPassword: PASSWORD, newPassword: 'password1234' });
    expect(leaked.statusCode).toBe(400);
    expect(leaked.json().error).toMatchObject({ code: 'weak_password', details: { problems: expect.arrayContaining(['breached']) } });
    const ok = await c.post('/api/v1/auth/password', { currentPassword: PASSWORD, newPassword: 'marble kettle orbit lantern' });
    expect(ok.statusCode, ok.body).toBe(200);
  });
});
