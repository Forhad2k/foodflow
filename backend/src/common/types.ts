import type { Role } from '@prisma/client';

export interface AuthenticatedUser {
  id: string;
  role: Role;
  email: string;
  sessionId: string;
}

export interface RequestContext {
  ip?: string;
  userAgent?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}
