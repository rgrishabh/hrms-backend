import { connect } from 'node:net';
import type { Env } from '../../config/env.js';

/**
 * A client for clamd's INSTREAM command on `node:net`: `zINSTREAM\0`, then chunks each led by a 4-byte big-endian length, then a zero length.
 * clamd answers `stream: OK`, `stream: <signature> FOUND`, or an error. Anything other than a clean answer is not clean: an error, a timeout or a
 * connection that drops throws, and the upload is refused. clamd's own `StreamMaxLength` (25 MB by default) must be at least `STORAGE_MAX_FILE_MB`,
 * or larger files are refused with an error.
 */
export type ScanResult = { clean: true } | { clean: false; signature: string };
export interface Scanner {
  scan(data: Buffer): Promise<ScanResult>;
}

const CHUNK = 64 * 1024;
const TIMEOUT_MS = 30_000;

export class ClamdScanner implements Scanner {
  constructor(
    private host: string,
    private port: number,
    private timeoutMs = TIMEOUT_MS,
  ) {}

  scan(data: Buffer): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      let reply = '';
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        socket.destroy();
        fn();
      };
      const parse = () => {
        const text = reply.replace(/\0/g, '').trim();
        const found = /^stream: (.+) FOUND$/.exec(text);
        if (found) finish(() => resolve({ clean: false, signature: found[1]! }));
        else if (text === 'stream: OK') finish(() => resolve({ clean: true }));
        else finish(() => reject(new Error(`clamd answered: ${text.slice(0, 200) || 'nothing'}`)));
      };
      socket.setTimeout(this.timeoutMs, () => finish(() => reject(new Error('clamd timed out'))));
      socket.on('error', (e) => finish(() => reject(new Error(`clamd is unreachable: ${e.message}`))));
      socket.on('data', (d) => {
        reply += d.toString('latin1');
        if (reply.includes('\0') || reply.includes('\n')) parse();
      });
      socket.on('end', parse);
      socket.on('connect', () => {
        void (async () => {
          const write = (b: Buffer) =>
            new Promise<void>((ok) => {
              if (socket.write(b)) ok();
              else socket.once('drain', ok);
            });
          await write(Buffer.from('zINSTREAM\0', 'latin1'));
          for (let at = 0; at < data.length && !done; at += CHUNK) {
            const part = data.subarray(at, at + CHUNK);
            const head = Buffer.alloc(4);
            head.writeUInt32BE(part.length);
            await write(head);
            await write(part);
          }
          if (!done) await write(Buffer.alloc(4));
        })();
      });
    });
  }
}

let scanner: Scanner | null = null;
let required = false;
export const setScanner = (s: Scanner | null, mustScan: boolean) => {
  scanner = s;
  required = mustScan;
};
export const getScanner = () => scanner;
/** Production never stores a file it could not scan. */
export const scanRequired = () => required;

export function createScanner(env: Pick<Env, 'CLAMAV_HOST' | 'CLAMAV_PORT'>): Scanner | null {
  return env.CLAMAV_HOST ? new ClamdScanner(env.CLAMAV_HOST, env.CLAMAV_PORT) : null;
}
