import { argon2 as argon2Cb, createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

/** RFC 9106's second recommendation for memory, one lane so that a sign-in costs one worker thread. About 100 ms on a laptop core; product constants. */
export const ARGON2 = { memory: 65536, passes: 3, parallelism: 1, tagLength: 32 } as const;

function argon2id(password: string, salt: Buffer, p: { memory: number; passes: number; parallelism: number; tagLength: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => argon2Cb('argon2id', { message: password, nonce: salt, ...p }, (err, key) => (err ? reject(err) : resolve(key))));
}

function scrypt(pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(pw, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
const CURRENT_PREFIX = `$argon2id$v=19$m=${ARGON2.memory},t=${ARGON2.passes},p=${ARGON2.parallelism}$`;
const DUMMY_SALT = Buffer.alloc(16, 0x5a);

/** New hashes are Argon2id in the PHC string format. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `${CURRENT_PREFIX}${b64(salt)}$${b64(await argon2id(password, salt, ARGON2))}`;
}

/**
 * Verifies against Argon2id, or scrypt for a hash not yet upgraded. With no hash to check (unknown user, invitation not accepted) the same
 * Argon2id work runs on a fixed salt and the answer is false, so the time taken does not say whether the account exists. A not-yet-upgraded
 * hash can take a different time: that says only that an account is old, and goes away at its next sign-in.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const phc = stored ? PHC.exec(stored) : null;
  if (phc) {
    const expected = Buffer.from(phc[5]!, 'base64');
    const actual = await argon2id(password, Buffer.from(phc[4]!, 'base64'), {
      memory: Number(phc[1]),
      passes: Number(phc[2]),
      parallelism: Number(phc[3]),
      tagLength: expected.length,
    });
    return timingSafeEqual(expected, actual);
  }
  const parts = stored?.split('$') ?? [];
  if (parts.length === 6 && parts[0] === 'scrypt') {
    const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
    const expected = Buffer.from(hash, 'base64');
    const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * 1024 * 1024 });
    return timingSafeEqual(expected, actual);
  }
  await argon2id(password, DUMMY_SALT, ARGON2);
  return false;
}

/** A stored hash that is not Argon2id at the current cost: replaced when the password is next proved right. */
export const needsRehash = (stored: string) => !stored.startsWith(CURRENT_PREFIX);

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
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
        try {
          return open(key, parts[1]!, parts[2]!, parts[3]!);
        } catch {
          /* the next loaded key may be the one */
        }
      }
      throw new Error('No loaded key opens this ciphertext');
    }
    throw new Error('Unsupported ciphertext');
  }
  /** Keyed hash for short-lived secrets too small to hash plainly, such as a six-digit code. Rotating the key only ends codes in flight. */
  mac(purpose: string, value: string): string {
    const key = Buffer.from(hkdfSync('sha256', this.keys.get(this.activeKeyId)!, Buffer.alloc(0), `hrms:${purpose}`, 32));
    return createHmac('sha256', key).update(value).digest('hex');
  }
  /** Whether a stored value is not yet sealed with the active key. */
  isStale(token: string) {
    return !token.startsWith(`v2.${this.activeKeyId}.`);
  }
}

function open(key: Buffer, iv: string, tag: string, data: string) {
  // Without this GCM takes a shortened tag, and a four-byte tag can be guessed.
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'), { authTagLength: 16 });
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

let current: FieldCipher | null = null;
/** The process's cipher, for code that has no request: payroll services, reports, jobs. Set once at startup. */
export function setDataCipher(c: FieldCipher) {
  current = c;
}
export function dataCipher(): FieldCipher {
  if (!current) throw new Error('The data cipher is not loaded');
  return current;
}
export const sealJson = (v: unknown) => dataCipher().encrypt(JSON.stringify(v));
export const openJson = <T>(token: string) => JSON.parse(dataCipher().decrypt(token)) as T;
