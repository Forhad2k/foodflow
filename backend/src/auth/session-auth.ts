import { UserStatus } from '@prisma/client';
import { unauthorized } from '../common/errors/domain-error';
import type { AuthenticatedUser } from '../common/types';
import type { Container } from '../container';
import { verifyAccessToken } from './access-token';

/**
 * Turns an access token into the current user, or throws 401. Used by BOTH the HTTP middleware and the Socket.IO
 * handshake. The user and session are re-read from the database every time, so role changes, suspensions and
 * logouts take effect immediately. Role is never trusted from the token.
 */
export async function resolveSession(c: Pick<Container, 'prisma' | 'env'>, token: string): Promise<AuthenticatedUser> {
  const claims = verifyAccessToken(c.env, token);
  if (!claims) throw unauthorized('Invalid or expired token');
  const [user, session] = await Promise.all([
    c.prisma.user.findUnique({ where: { id: claims.sub }, select: { id: true, role: true, email: true, status: true } }),
    c.prisma.session.findUnique({ where: { id: claims.sid }, select: { userId: true, revokedAt: true, expiresAt: true } }),
  ]);
  if (!user || user.status !== UserStatus.ACTIVE) throw unauthorized('Account unavailable');
  if (!session || session.userId !== user.id || session.revokedAt || session.expiresAt < new Date()) throw unauthorized('Session ended');
  return { id: user.id, role: user.role, email: user.email, sessionId: claims.sid };
}
