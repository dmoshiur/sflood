import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Shared HTTP helpers: consistent JSON errors and safe async handlers. */

export function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

export function ok(res: Response, body: unknown, status = 200) {
  res.status(status).json(body);
}

export function fail(res: Response, status: number, error: string, extra: Record<string, unknown> = {}) {
  res.status(status).json({ error, ...extra });
}

export function badRequest(res: Response, message: string) { fail(res, 400, message); }
export function unauthorized(res: Response, message = 'Sign in to continue.') { fail(res, 401, message); }
export function forbidden(res: Response, message = 'You do not have access to this resource.') { fail(res, 403, message); }
export function notFound(res: Response, message = 'Not found.') { fail(res, 404, message); }

export function zodError(res: Response, issues: Array<{ message?: string }>, fallback = 'The request body is invalid.') {
  fail(res, 400, issues[0]?.message || fallback);
}

export function clientIp(req: Request): string {
  const forwarded = req.get('x-forwarded-for');
  if (forwarded && req.app?.get('trust proxy')) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip || req.socket.remoteAddress || '0.0.0.0';
}

/** Express 5 route params can be string or string[]; normalise to a string. */
export function routeParam(req: Request, key: string): string {
  const value = (req.params as Record<string, unknown>)[key];
  if (Array.isArray(value)) return String(value[0] ?? '');
  return value === undefined || value === null ? '' : String(value);
}

export function firstIssue(error: unknown): string {
  const issues = (error as { issues?: Array<{ message?: string }> })?.issues;
  return issues?.[0]?.message || 'The request body is invalid.';
}
