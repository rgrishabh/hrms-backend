import { LOG_REDACTED_FIELDS } from './policy/classification.js';

/**
 * L3 and L4 stay out of logs. Credentials and session material by path, classified fields by name at the top two levels of anything
 * logged (pino's wildcards reach no deeper; logging a whole domain object is not done here). A query string is cut from the logged URL, because no caller's parameters are worth the risk; the route is enough.
 */
const CREDENTIALS = ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-device-key"]', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'];
const paths = (f: string) => { const k = /^[A-Za-z_]\w*$/.test(f) ? `.${f}` : `["${f}"]`; return [f, `*${k}`]; };
export const LOG_REDACT_PATHS: string[] = [...CREDENTIALS, ...LOG_REDACTED_FIELDS.flatMap(paths), 'err.detail', 'err.where', 'err.parameters', 'err.internalQuery'];

export const pathOnly = (url: string | undefined) => (url ?? '').split('?')[0];

interface LoggedRequest { method?: string; url?: string; headers?: Record<string, unknown>; ip?: string; socket?: { remoteAddress?: string } }
export const logSerializers = {
  /** Without the body or query, and no database error detail: it quotes the row's values. */
  req: (r: LoggedRequest) => ({ method: r.method, url: pathOnly(r.url), host: typeof r.headers?.host === 'string' ? r.headers.host : undefined, remoteAddress: r.ip ?? r.socket?.remoteAddress }),
};
