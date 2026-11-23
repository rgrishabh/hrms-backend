import { describe, it, expect } from 'vitest';
import { newRecoveryCodes } from '../src/core/auth/totp.js';

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

describe('recovery codes', () => {
  it('keep the format stored codes were issued in', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/);
  });

  // Reducing a byte modulo 31 makes the first 8 letters 9/8 as likely as the other 23: 1.125 between the two.
  // Unbiased, at about 38,700 of each letter, the spread stays near 1.02, so 1.06 is many deviations from either.
  it('draw every letter equally often', () => {
    const counts = new Map<string, number>();
    for (const code of newRecoveryCodes(100_000)) {
      for (const ch of code.replaceAll('-', '')) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    expect(counts.size).toBe(ALPHABET.length);
    const seen = [...counts.values()];
    expect(Math.max(...seen) / Math.min(...seen)).toBeLessThan(1.06);
  });
});
