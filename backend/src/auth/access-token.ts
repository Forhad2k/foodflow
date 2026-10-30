import jwt from 'jsonwebtoken';
import type { Env } from '../config/env';

export interface AccessClaims {
  sub: string; // user id
  sid: string; // session id
}

/** Access tokens carry only identity + session; role and status are always re-read from the database. */
export function signAccessToken(env: Pick<Env, 'JWT_ACCESS_SECRET' | 'JWT_ACCESS_TTL_SECONDS'>, claims: AccessClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: env.JWT_ACCESS_TTL_SECONDS });
}

export function verifyAccessToken(env: Pick<Env, 'JWT_ACCESS_SECRET'>, token: string): AccessClaims | null {
  try {
    const p = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
    return typeof p === 'object' && typeof p.sub === 'string' && typeof (p as AccessClaims).sid === 'string' ? { sub: p.sub, sid: (p as AccessClaims).sid } : null;
  } catch {
    return null;
  }
}
