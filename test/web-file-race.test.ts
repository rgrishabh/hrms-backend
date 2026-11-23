import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const swap = vi.hoisted(() => ({ run: (): void => undefined }));

// Replaces the file at the moment the loader asks what it is, the gap a race would need.
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  const racing = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R => {
    swap.run();
    return fn(...a);
  };
  return { ...fs, statSync: racing(fs.statSync as (...a: unknown[]) => unknown), fstatSync: racing(fs.fstatSync as (...a: unknown[]) => unknown) };
});

const { registerBrandAssets } = await import('../src/core/http/web.js');

describe('loading files from disk', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'web-race-'));
    writeFileSync(path.join(dir, 'logo.svg'), 'checked');
    swap.run = () => undefined;
  });

  it('keeps the file it checked, if another takes its name before the read', () => {
    const other = path.join(mkdtempSync(path.join(tmpdir(), 'web-race-other-')), 'logo.svg');
    writeFileSync(other, 'swapped');
    swap.run = () => {
      swap.run = () => undefined;
      renameSync(other, path.join(dir, 'logo.svg'));
    };
    expect(registerBrandAssets(dir, []).get('/brand/logo.svg')?.toString()).toBe('checked');
  });

  it('still reads directories, and brand files are only those at the top', () => {
    mkdirSync(path.join(dir, 'nested'));
    writeFileSync(path.join(dir, 'nested', 'deep.svg'), 'deep');
    const files = registerBrandAssets(dir, []);
    expect([...files.keys()]).toEqual(['/brand/logo.svg']);
  });
});
