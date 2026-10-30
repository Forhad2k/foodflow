import { Prisma, Role, UserStatus } from '@prisma/client';
import { conflict, forbidden, unauthorized } from '../common/errors/domain-error';
import { randomBytes, randomUUID } from 'crypto';
import { signAccessToken } from './access-token';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/errors/domain-error';
import { hashPassword, needsRehash, verifyPassword } from '../common/utils/password';
import { generateOpaqueToken, sha256 } from '../common/utils/tokens';
import type { RequestContext } from '../common/types';
import type { Env } from '../config/env';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from '../schemas/auth';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const RESET_TTL_MINUTES = 30;
/** A just-rotated token presented again within this window is treated as a benign race (two tabs), not theft. */
const ROTATION_GRACE_MS = 10_000;

export interface AuthResult {
  user: PublicUser;
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface PublicUser {
  id: string;
  email: string;
  role: Role;
  fullName: string;
}
export class AuthService {
  private dummyHash?: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: Env,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  /** Verified against when the email is unknown, so response time does not reveal which emails exist. */
  private getDummyHash(): Promise<string> {
    return (this.dummyHash ??= hashPassword(randomBytes(16).toString('hex')));
  }

  async register(dto: RegisterDto, ctx: RequestContext): Promise<AuthResult> {
    const passwordHash = await hashPassword(dto.password);
    let user;
    try {
      user = await this.prisma.user.create({
        data: {
          email: dto.email,
          phone: dto.phone,
          role: dto.role,
          credential: { create: { passwordHash } },
          profile: { create: { fullName: dto.fullName } },
          // Riders start unapproved; they cannot receive real deliveries until an admin approves them.
          ...(dto.role === Role.RIDER && { riderProfile: { create: {} } }),
        },
        include: { profile: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw conflict('An account with these details already exists');
      }
      throw err;
    }
    await this.audit.log({ actorId: user.id, action: 'auth.register', entityType: 'User', entityId: user.id, ip: ctx.ip });
    return this.issueSession({ id: user.id, email: user.email, role: user.role, fullName: user.profile!.fullName }, ctx);
  }

  async login(email: string, password: string, ctx: RequestContext): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { credential: true, profile: true },
    });
    const now = new Date();

    if (user?.credential?.lockedUntil && user.credential.lockedUntil > now) {
      await verifyPassword(password, await this.getDummyHash()); // keep timing uniform
      throw new DomainError('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.', 429);
    }

    const ok = await verifyPassword(password, user?.credential?.passwordHash ?? (await this.getDummyHash()));
    if (!user || !user.credential || !ok) {
      if (user?.credential) await this.recordFailedLogin(user.id, user.credential.failedLoginCount);
      await this.audit.log({ actorId: user?.id, action: 'auth.login_failed', ip: ctx.ip });
      throw unauthorized('Invalid email or password');
    }
    if (user.status !== UserStatus.ACTIVE) throw forbidden('This account is not active');

    const credentialUpdate: Prisma.UserCredentialUpdateInput = { failedLoginCount: 0, lockedUntil: null };
    if (needsRehash(user.credential.passwordHash)) credentialUpdate.passwordHash = await hashPassword(password);
    await this.prisma.userCredential.update({ where: { userId: user.id }, data: credentialUpdate });

    return this.issueSession(
      { id: user.id, email: user.email, role: user.role, fullName: user.profile?.fullName ?? '' },
      ctx,
    );
  }

  /** Rotating refresh with reuse detection. */
  async refresh(rawToken: string | undefined, ctx: RequestContext): Promise<AuthResult> {
    if (!rawToken) throw unauthorized('No refresh token');
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: sha256(rawToken) },
      include: { user: { include: { profile: true } } },
    });
    if (!session) throw unauthorized('Invalid refresh token');

    if (session.revokedAt) {
      const recentlyRotated = session.replacedById && Date.now() - session.revokedAt.getTime() < ROTATION_GRACE_MS;
      if (!recentlyRotated) {
        // A retired token came back: assume it was stolen and kill the whole family.
        await this.prisma.session.updateMany({
          where: { familyId: session.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await this.audit.log({ actorId: session.userId, action: 'auth.refresh_reuse_detected', ip: ctx.ip });
      }
      throw unauthorized('Refresh token no longer valid');
    }
    if (session.expiresAt < new Date()) throw unauthorized('Refresh token expired');
    if (session.user.status !== UserStatus.ACTIVE) throw unauthorized('Account unavailable');

    return this.issueSession(
      {
        id: session.user.id,
        email: session.user.email,
        role: session.user.role,
        fullName: session.user.profile?.fullName ?? '',
      },
      ctx,
      { rotateFrom: session.id, familyId: session.familyId },
    );
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    await this.prisma.session.updateMany({
      where: { refreshTokenHash: sha256(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Always resolves the same way whether or not the email exists (no account enumeration). */
  async forgotPassword(email: string, ctx: RequestContext): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== UserStatus.ACTIVE) return;

    const token = generateOpaqueToken();
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } }),
      this.prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000) },
      }),
    ]);
    const base = this.config.APP_URL.replace(/\/$/, '');
    await this.mail.sendPasswordReset(user.email, `${base}/reset-password?token=${encodeURIComponent(token)}`);
    await this.audit.log({ actorId: user.id, action: 'auth.password_reset_requested', ip: ctx.ip });
  }

  async resetPassword(token: string, newPassword: string, ctx: RequestContext): Promise<void> {
    const record = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new DomainError('INVALID_RESET_TOKEN', 'Reset link is invalid or expired', 400);
    }
    const passwordHash = await hashPassword(newPassword);
    await this.prisma.$transaction(async (tx) => {
      // Atomic claim: only one concurrent request can consume the token.
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) throw new DomainError('INVALID_RESET_TOKEN', 'Reset link is invalid or expired', 400);
      await tx.userCredential.update({
        where: { userId: record.userId },
        data: { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null },
      });
      // Changing the password signs the user out everywhere.
      await tx.session.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    });
    await this.audit.log({ actorId: record.userId, action: 'auth.password_reset_completed', ip: ctx.ip });
  }

  // ───────────────────────────── internals ─────────────────────────────

  private async recordFailedLogin(userId: string, previousCount: number) {
    const count = previousCount + 1;
    const lock = count >= MAX_FAILED_LOGINS;
    await this.prisma.userCredential.update({
      where: { userId },
      data: {
        failedLoginCount: lock ? 0 : count,
        lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : undefined,
      },
    });
  }

  private async issueSession(
    user: PublicUser,
    ctx: RequestContext,
    rotation?: { rotateFrom: string; familyId: string },
  ): Promise<AuthResult> {
    const refreshToken = generateOpaqueToken();
    const sessionId = randomUUID();
    const refreshExpiresAt = new Date(Date.now() + this.config.REFRESH_TTL_DAYS * 86_400_000);

    await this.prisma.$transaction(async (tx) => {
      if (rotation) {
        // Atomic claim of the old session: of two concurrent refreshes only one wins.
        const retired = await tx.session.updateMany({
          where: { id: rotation.rotateFrom, revokedAt: null },
          data: { revokedAt: new Date(), replacedById: sessionId },
        });
        if (retired.count !== 1) throw unauthorized('Refresh token no longer valid');
      }
      await tx.session.create({
        data: {
          id: sessionId,
          userId: user.id,
          familyId: rotation?.familyId ?? randomUUID(),
          refreshTokenHash: sha256(refreshToken),
          userAgent: ctx.userAgent?.slice(0, 255),
          ip: ctx.ip,
          expiresAt: refreshExpiresAt,
        },
      });
    });

    const expiresIn = this.config.JWT_ACCESS_TTL_SECONDS;
    const accessToken = signAccessToken(this.config, { sub: user.id, sid: sessionId });
    return { user, accessToken, expiresIn, refreshToken, refreshExpiresAt };
  }
}
