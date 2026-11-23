import { Decimal } from 'decimal.js';

/** A money field from a request: a value that is not a number is a validation error for the caller to report, where `new Decimal` would throw and answer 500. */
export const decimalOrNaN = (v: number | string): Decimal => {
  try {
    return new Decimal(v);
  } catch {
    return new Decimal(NaN);
  }
};
