import type { Env } from '../config/env.js';
import { buildPublicConfig, type PublicConfig } from '../config/installation.js';
import { setDeploymentDefaults, setDeploymentLimits } from './settings/service.js';
import { setEmailTransportConfigured, setPushConfigured, setStorageConfigured } from './features/state.js';
import { setMfaFloor, type MfaLevel } from './auth/mfa.js';
import { createPushSender, getPushSender, setPushSender } from './notify/push.js';
import { setEmailBrand } from './notify/service.js';
import { createMailer, getMailer, setMailer } from './notify/mailer.js';
import { createStore, getStore, setStore } from './storage/index.js';
import { registerAllApprovalHandlers } from './workflow/handlers.js';

export interface RuntimeOverrides {
  /** Tests: keep an injected mailer instead of building one from env. */
  mailerOverride?: boolean;
  storeOverride?: boolean;
  pushOverride?: boolean;
}

export interface Runtime { publicConfig: PublicConfig; features: ReadonlySet<string> }

type RuntimeLog = { info: (o: object, m?: string) => void };

/** MFA_AVAILABLE and MFA_ENFORCED onto the existing floor. A minimal mapping: the auth flows behind them come with their own batch. */
const mfaFloorOf = (env: Pick<Env, 'MFA_AVAILABLE' | 'MFA_ENFORCED'>): MfaLevel => (env.MFA_AVAILABLE && env.MFA_ENFORCED ? 'all' : 'off');

/**
 * Everything both processes need before doing any work: the API (buildApp) and the worker (worker.ts).
 * Validates the module set, so an invalid configuration stops either process.
 */
export function initRuntime(env: Env, log: RuntimeLog, overrides: RuntimeOverrides = {}): Runtime {
  setDeploymentLimits({ sessionTtlHours: env.SESSION_TTL_HOURS });
  setMfaFloor(mfaFloorOf(env));
  setDeploymentDefaults({ 'general.timezone': env.ORGANIZATION_TIMEZONE, 'general.date_format': env.ORGANIZATION_DATE_FORMAT });
  const publicConfig = buildPublicConfig(env);
  setEmailBrand({ brandName: publicConfig.brand.name, productName: publicConfig.product.name, primaryColor: publicConfig.brand.primaryColor,
    supportEmail: publicConfig.brand.supportEmail, appUrl: env.APP_URL });
  // The API needs the mailer too: it decides whether to enqueue. Only the worker's scheduler ever sends.
  if (!overrides.mailerOverride) setMailer(createMailer(env, log));
  setEmailTransportConfigured(!!getMailer());
  if (!overrides.storeOverride) setStore(createStore(env));
  setStorageConfigured(!!getStore());
  if (!overrides.pushOverride) setPushSender(createPushSender(env));
  setPushConfigured(!!getPushSender());
  registerAllApprovalHandlers();
  return { publicConfig, features: env.enabledFeatures };
}
