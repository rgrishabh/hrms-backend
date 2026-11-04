import { AsyncLocalStorage } from 'node:async_hooks';

/** ORG_MANAGEMENT_MODE. Carried like the feature set: per process in production, per app in the test suite. */
export type ManagementMode = 'single' | 'single_hr' | 'multi';

const scope = new AsyncLocalStorage<ManagementMode>();
export const currentMode = (): ManagementMode => scope.getStore() ?? 'multi';
export function withMode<T>(mode: ManagementMode, fn: () => T): T { return scope.run(mode, fn); }
/** Single and single_hr: no role screens, one-step approvals, an owner who may decide their own. */
export const isCollapsedMode = (m: ManagementMode = currentMode()) => m !== 'multi';
