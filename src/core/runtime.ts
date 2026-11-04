import type { Env } from '../config/env.js';
import { buildPublicConfig, type PublicConfig } from '../config/installation.js';
import { setDeploymentDefaults, setDeploymentLimits } from './settings/service.js';
import { resolveEnabledModules, setEnabledModules, setEmailTransportConfigured, setStorageConfigured } from './features/state.js';
import { setMfaFloor } from './auth/mfa.js';
import { setEmailBrand } from './notify/service.js';
import { createMailer, getMailer, setMailer } from './notify/mailer.js';
import { createStore, getStore, setStore } from './storage/index.js';
import { registerAllApprovalHandlers } from './workflow/handlers.js';

export interface RuntimeOverrides {
  /** Tests: keep an injected mailer instead of building one from env. */
  mailerOverride?: boolean;
  storeOverride?: boolean;
}

export interface Runtime { publicConfig: PublicConfig }

type RuntimeLog = { info: (o: object, m?: string) => void };

/**
 * Everything both processes need before doing any work: the API (buildApp) and the worker (worker.ts).
 * Validates the module set, so an invalid configuration stops either process.
 */
export function initRuntime(env: Env, log: RuntimeLog, overrides: RuntimeOverrides = {}): Runtime {
  setEnabledModules(resolveEnabledModules(env.ENABLED_MODULES));
  setDeploymentLimits({ sessionTtlHours: env.SESSION_TTL_HOURS });
  setMfaFloor(env.MFA_ENFORCEMENT);
  setDeploymentDefaults({ 'general.timezone': env.ORGANIZATION_TIMEZONE, 'general.date_format': env.ORGANIZATION_DATE_FORMAT });
  const publicConfig = buildPublicConfig(env);
  setEmailBrand({ brandName: publicConfig.brand.name, productName: publicConfig.product.name, primaryColor: publicConfig.brand.primaryColor,
    supportEmail: publicConfig.brand.supportEmail, appUrl: env.APP_URL });
  // The API needs the mailer too: it decides whether to enqueue. Only the worker's scheduler ever sends.
  if (!overrides.mailerOverride) setMailer(createMailer(env, log));
  setEmailTransportConfigured(!!getMailer());
  if (!overrides.storeOverride) setStore(createStore(env));
  setStorageConfigured(!!getStore());
  registerAllApprovalHandlers();
  return { publicConfig };
}
