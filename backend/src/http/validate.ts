import type { Request } from 'express';
import { z, ZodTypeAny } from 'zod';
import { DomainError } from '../common/errors/domain-error';

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  throw new DomainError('VALIDATION_FAILED', 'Validation failed', 400, r.error.issues.map((i) => `${i.path.join('.') || '(request)'}: ${i.message}`));
}

export const body = <S extends ZodTypeAny>(schema: S, req: Request) => parse(schema, req.body ?? {});
export const query = <S extends ZodTypeAny>(schema: S, req: Request) => parse(schema, req.query);
const uuidSchema = z.string().uuid();
/** Validated path parameter. */
export const param = (req: Request, name = 'id'): string => parse(uuidSchema, req.params[name]);
export const ctx = (req: Request) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });
export const me = (req: Request) => req.user!;
