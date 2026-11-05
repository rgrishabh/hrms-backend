import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from './errors.js';

/** One field's problem in a validation failure. */
export interface ProblemFieldError {
  path: string;
  message: string;
}

/** RFC 7807: the only error shape the API returns. Object `details` of an AppError become extension members. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  errors: ProblemFieldError[];
  [extension: string]: unknown;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
export const problemType = (code: string) => `urn:hrms:problem:${code}`;

const TITLES: Readonly<Record<number, string>> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  405: 'Method not allowed',
  406: 'Not acceptable',
  408: 'Request timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length required',
  413: 'Payload too large',
  414: 'URI too long',
  415: 'Unsupported media type',
  416: 'Range not satisfiable',
  422: 'Unprocessable content',
  429: 'Too many requests',
  431: 'Request header fields too large',
  500: 'Internal server error',
  501: 'Not implemented',
  502: 'Bad gateway',
  503: 'Service unavailable',
  504: 'Gateway timeout',
};
const titleOf = (status: number) => TITLES[status] ?? (status >= 500 ? 'Server error' : 'Request error');

/** What a framework or plugin 4xx says. Its own message can quote the request body (JSON parse errors do), so it is never passed on. */
const FRAMEWORK_4XX: Readonly<Record<number, { code: string; detail: string }>> = {
  400: { code: 'bad_request', detail: 'The request could not be read.' },
  404: { code: 'not_found', detail: 'Not found' },
  405: { code: 'method_not_allowed', detail: 'This method is not allowed here.' },
  406: { code: 'not_acceptable', detail: 'That format is not available.' },
  408: { code: 'request_timeout', detail: 'The request took too long.' },
  411: { code: 'length_required', detail: 'The request needs a content length.' },
  413: { code: 'payload_too_large', detail: 'The request or file is too large.' },
  414: { code: 'uri_too_long', detail: 'The address is too long.' },
  415: { code: 'unsupported_media_type', detail: 'That content type is not accepted.' },
  431: { code: 'headers_too_large', detail: 'The request headers are too large.' },
};
const RESERVED = new Set(['type', 'title', 'status', 'detail', 'instance', 'code', 'errors']);

interface ProblemInput {
  status: number;
  code: string;
  detail: string;
  errors?: ProblemFieldError[];
  extensions?: Record<string, unknown>;
}

function isFieldErrors(v: unknown): v is ProblemFieldError[] {
  return (
    Array.isArray(v) &&
    v.every((x) => typeof x === 'object' && x !== null && typeof (x as ProblemFieldError).path === 'string' && typeof (x as ProblemFieldError).message === 'string')
  );
}

/** The body for an error. `instance` names this occurrence by request id: the reference the logs carry, and nothing from the address. */
export function problemOf(requestId: string, p: ProblemInput): Problem {
  const extensions = Object.fromEntries(Object.entries(p.extensions ?? {}).filter(([k]) => !RESERVED.has(k)));
  return {
    ...extensions,
    type: problemType(p.code),
    title: titleOf(p.status),
    status: p.status,
    detail: p.detail,
    instance: `urn:uuid:${requestId}`,
    code: p.code,
    errors: p.errors ?? [],
  };
}

function inputOf(err: unknown): ProblemInput | null {
  if (err instanceof AppError) {
    const d = err.details;
    if (isFieldErrors(d)) return { status: err.status, code: err.code, detail: err.message, errors: d };
    if (Array.isArray(d)) return { status: err.status, code: err.code, detail: err.message, errors: d.map((m) => ({ path: '', message: String(m) })) };
    if (d && typeof d === 'object' && !Array.isArray(d)) return { status: err.status, code: err.code, detail: err.message, extensions: d as Record<string, unknown> };
    return { status: err.status, code: err.code, detail: err.message };
  }
  if (err instanceof ZodError) {
    return { status: 400, code: 'validation_failed', detail: 'Some fields are invalid', errors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  }
  const e = err as { statusCode?: number; code?: string };
  if (e.statusCode === 429) return { status: 429, code: 'rate_limited', detail: 'Too many requests. Please slow down.' };
  // Database rules: said in words, with no constraint, table or value in the answer.
  if (e.code === '23505') return { status: 409, code: 'duplicate', detail: 'A record with these details already exists' };
  if (e.code === '23P01') return { status: 409, code: 'conflict', detail: 'This overlaps an existing record' };
  if (e.code === '23503') return { status: 400, code: 'invalid_reference', detail: 'A referenced record does not exist' };
  if (e.code === '23514') return { status: 400, code: 'constraint_violation', detail: 'The values violate a data rule' };
  // Class 22 is bad data from the request: a NUL in text, a number or date out of range. Never a fault of ours, and never with the value in the answer.
  if (typeof e.code === 'string' && e.code.startsWith('22')) return { status: 400, code: 'invalid_value', detail: 'A value in this request cannot be stored or compared' };
  if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
    const known = FRAMEWORK_4XX[e.statusCode] ?? { code: 'bad_request', detail: 'The request could not be processed.' };
    return { status: e.statusCode, ...known };
  }
  return null;
}

export function sendProblem(req: FastifyRequest, reply: FastifyReply, p: ProblemInput) {
  // An export that failed part way has already said it is a file.
  reply.removeHeader('content-disposition');
  return reply.code(p.status).type(PROBLEM_CONTENT_TYPE).send(problemOf(req.id, p));
}

/** The one error handler. Anything it does not recognize is logged and answered with nothing but the request's reference. */
export function problemErrorHandler(err: unknown, req: FastifyRequest, reply: FastifyReply) {
  const input = inputOf(err);
  if (input) return sendProblem(req, reply, input);
  req.log.error({ err }, 'unhandled error');
  return sendProblem(req, reply, { status: 500, code: 'internal', detail: `Something went wrong. Reference: ${req.id}` });
}

export const notFoundProblem = (req: FastifyRequest, reply: FastifyReply) => sendProblem(req, reply, { status: 404, code: 'not_found', detail: 'Not found' });
