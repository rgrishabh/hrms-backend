/**
 * Free text the server writes into notifications, email and approval summaries must not carry money: those copies are
 * stored in plaintext and sent to people who may not be cleared for the figure. This catches what a caller forgets.
 */
const AMOUNT = /(?:₹|\bRs\.?|\bINR|\bUSD|\bEUR|\bGBP|US\$|\$|€|£|¥)\s?\d[\d,.\u00a0\u202f]*|\d[\d,.\u00a0\u202f]*\s?(?:₹|€|£)/gi;
export const AMOUNT_REMOVED = '[amount removed]';
export const scrubAmounts = (text: string) => text.replace(AMOUNT, AMOUNT_REMOVED);
export const hasAmount = (text: string) => { AMOUNT.lastIndex = 0; return AMOUNT.test(text); };
