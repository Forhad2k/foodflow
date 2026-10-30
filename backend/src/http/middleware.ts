import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { Prisma, Role } from '@prisma/client';
import { ZodError } from 'zod';
import { resolveSession } from '../auth/session-auth';
import { forbidden, unauthorized, DomainError } from '../common/errors/domain-error';
import { createLogger } from '../common/logger';
import type { Container } from '../container';

const logger = createLogger('http');

/** Verifies the bearer token and the live session (see auth/session-auth.ts). */
export const authenticate = (c: Container): RequestHandler => async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized('Missing bearer token');
  req.user = await resolveSession(c, header.slice(7));
  next();
};

export const requireRole = (...roles: Role[]): RequestHandler => (req, _res, next) => {
  if (!req.user || !roles.includes(req.user.role)) throw forbidden('Insufficient role');
  next();
};

/**
 * CSRF defence for endpoints that authenticate with the refresh-token cookie:
 * an Origin header (when present) must be allow-listed, and a custom header is required: browsers cannot attach
 * custom headers cross-origin without a CORS preflight, which our allow-list rejects for foreign origins.
 */
export const cookieCsrf = (c: Container): RequestHandler => (req, _res, next) => {
  const origin = req.headers.origin;
  if (origin && !c.env.CORS_ORIGINS.includes(origin)) throw forbidden('Origin not allowed');
  if (req.headers['x-requested-with'] !== 'FoodFlow') throw forbidden('Missing CSRF header');
  next();
};

/** Per-route limiter (in-memory store: use rate-limit-redis when running several instances). */
export const limit = (enabled: boolean, max: number, windowMs = 60_000): RequestHandler =>
  enabled
    ? rateLimit({
        windowMs, limit: max, standardHeaders: true, legacyHeaders: false,
        handler: (req, res) => {
          res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down.', requestId: req.id } });
        },
      })
    : (_req, _res, next) => next();

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.id } });
};

/**
 * Every error leaves the API in one shape: { error: { code, message, details?, requestId } }.
 * Unknown errors are logged in full but returned as a generic 500 (no stack traces, no SQL).
 */
export const errorHandler: ErrorRequestHandler = (err: unknown, req: Request, res: Response, _next: NextFunction) => {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong';
  let details: unknown;

  if (err instanceof DomainError) {
    ({ httpStatus: status, code, message, details } = err);
  } else if (err instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_FAILED';
    message = 'Validation failed';
    details = err.issues.map((i) => `${i.path.join('.') || '(request)'}: ${i.message}`);
  } else if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    status = 409; code = 'UNIQUE_CONSTRAINT'; message = 'A record with these values already exists';
  } else if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
    status = 404; code = 'NOT_FOUND'; message = 'Record not found';
  } else if ((err as { type?: string })?.type === 'entity.parse.failed') {
    status = 400; code = 'INVALID_JSON'; message = 'Request body is not valid JSON';
  } else if ((err as { type?: string })?.type === 'entity.too.large') {
    status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Request body is too large';
  } else {
    logger.error(err instanceof Error ? `${req.method} ${req.originalUrl}: ${err.stack}` : String(err));
  }
  res.status(status).json({ error: { code, message, ...(details !== undefined && { details }), requestId: req.id } });
};
