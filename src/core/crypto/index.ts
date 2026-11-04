import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DUMMY_HASH = `scrypt$32768$8$1$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(32).toString('base64')}`;

function scrypt(pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(pw, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  // Always do the work so response timing does not reveal whether the account exists.
  const parts = (stored ?? DUMMY_HASH).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length,
    { N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * 1024 * 1024 });
  return stored !== null && timingSafeEqual(expected, actual);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex'); const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

export const keyIdOf = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 12);

/**
 * Field-level encryption, AES-256-GCM. Each ciphertext names the key it was sealed with (`v2.<keyId>.<iv>.<tag>.<data>`),
 * so a rotation can run while old values are still readable. `v1` tokens predate key ids: they are tried against every
 * loaded key until `rotate-keys` has rewritten them. Synchronous on purpose: the key is unwrapped once at startup (keys.ts).
 */
export class FieldCipher {
  private keys = new Map<string, Buffer>();
  readonly activeKeyId: string;
  constructor(base64Key: string, previousBase64Keys: readonly string[] = []) {
    const load = (b64: string) => {
      const key = Buffer.from(b64, 'base64');
      if (key.length !== 32) throw new Error('Field encryption key must be 32 bytes');
      this.keys.set(keyIdOf(key), key);
      return keyIdOf(key);
    };
    this.activeKeyId = load(base64Key);
    previousBase64Keys.forEach(load);
  }
  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.keys.get(this.activeKeyId)!, iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v2', this.activeKeyId, iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
  }
  decrypt(token: string): string {
    const parts = token.split('.');
    if (parts[0] === 'v2' && parts.length === 5) {
      const key = this.keys.get(parts[1]!);
      if (!key) throw new Error(`Ciphertext uses key ${parts[1]}, which is not loaded`);
      return open(key, parts[2]!, parts[3]!, parts[4]!);
    }
    if (parts[0] === 'v1' && parts.length === 4) {
      for (const key of this.keys.values()) {
        try { return open(key, parts[1]!, parts[2]!, parts[3]!); } catch { /* the next loaded key may be the one */ }
      }
      throw new Error('No loaded key opens this ciphertext');
    }
    throw new Error('Unsupported ciphertext');
  }
  /** Whether a stored value is not yet sealed with the active key. */
  isStale(token: string) { return !token.startsWith(`v2.${this.activeKeyId}.`); }
}

function open(key: Buffer, iv: string, tag: string, data: string) {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

let current: FieldCipher | null = null;
/** The process's cipher, for code that has no request: payroll services, reports, jobs. Set once at startup. */
export function setDataCipher(c: FieldCipher) { current = c; }
export function dataCipher(): FieldCipher {
  if (!current) throw new Error('The data cipher is not loaded');
  return current;
}
export const sealJson = (v: unknown) => dataCipher().encrypt(JSON.stringify(v));
export const openJson = <T>(token: string) => JSON.parse(dataCipher().decrypt(token)) as T;
