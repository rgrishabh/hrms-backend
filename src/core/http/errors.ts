export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Authentication required') => new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'You do not have permission to perform this action') => new AppError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found') => new AppError(404, 'not_found', msg);
export const conflict = (msg: string, details?: unknown) => new AppError(409, 'conflict', msg, details);
/** The module is on but needs setting up first: an overtime setting, a registered device, a configured store. */
export const featureNotConfigured = (key: string, reason: string) =>
  new AppError(409, 'feature_not_configured', `'${key}' is on but not set up yet: ${reason}`, { feature: key, reason });
