import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * A handler must never call reply.send() inside a database transaction: Fastify sends the
 * response immediately, before COMMIT, so a client can read stale data right after a 201 (or be
 * told "created" when the commit then fails). Inside a.tx(), set the status and RETURN the body.
 */
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });

describe('responses are sent after the transaction commits', () => {
  it('no reply.code(201).send(...) anywhere in the handlers', () => {
    const offenders = files(path.join(__dirname, '..', 'src')).filter((f) => /reply\.code\(201\)\.send\(/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
