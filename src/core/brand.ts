import type { Env } from '../config/env.js';

/**
 * Formats that follow the deployment's brand settings, for text the server writes: approval summaries, notifications,
 * emails, errors. Process-wide, like the email brand: one deployment per process.
 */
let locale = 'en-IN';
let currency = 'INR';
export function setBrandFormats(env: Pick<Env, 'BRAND_LOCALE' | 'BRAND_CURRENCY'>) {
  locale = env.BRAND_LOCALE;
  currency = env.BRAND_CURRENCY;
}

/** An amount in the deployment's currency and locale. Fractions show only if the amount has them. */
export function money(amount: number | string | { toString(): string }): string {
  const n = Number(amount.toString());
  return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }).format(n);
}
