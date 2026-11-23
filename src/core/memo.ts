import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Settings and feature state, remembered for one request or one job run. A gated route used to read the same rows many times over.
 * Nothing outlives its scope, so another instance's change is seen by the next request; a write in this scope clears it.
 * Outside a scope (a test fixture, a script) nothing is remembered.
 */
const store = new AsyncLocalStorage<Map<string, unknown>>();

export const withMemo = <T>(memo: Map<string, unknown>, fn: () => T): T => store.run(memo, fn);
export const clearMemo = () => {
  store.getStore()?.clear();
};

export async function memoized<T>(key: string, load: () => Promise<T>): Promise<T> {
  const memo = store.getStore();
  if (!memo) return load();
  if (memo.has(key)) return memo.get(key) as T;
  const value = await load();
  memo.set(key, value);
  return value;
}
