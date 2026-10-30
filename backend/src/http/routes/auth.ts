import { CookieOptions, Response, Router } from 'express';
import type { AuthResult } from '../../auth/auth.service';
import type { Container } from '../../container';
import { forgotPasswordSchema, loginSchema, registerSchema, resetPasswordSchema } from '../../schemas/auth';
import { cookieCsrf, limit } from '../middleware';
import { body, ctx } from '../validate';

export const REFRESH_COOKIE = 'ff_rt';
const REFRESH_PATH = '/api/v1/auth'; // the cookie is only ever sent to /auth/*

export function authRouter(c: Container, rate: boolean) {
  const r = Router();
  const cookie = (): CookieOptions => ({ httpOnly: true, secure: c.env.COOKIE_SECURE, sameSite: c.env.COOKIE_SAMESITE, domain: c.env.COOKIE_DOMAIN, path: REFRESH_PATH });
  const respond = (res: Response, x: AuthResult) => {
    res.cookie(REFRESH_COOKIE, x.refreshToken, { ...cookie(), expires: x.refreshExpiresAt });
    return { user: x.user, accessToken: x.accessToken, expiresIn: x.expiresIn };
  };

  r.post('/register', limit(rate, 5), async (req, res) => {
    res.status(201).json(respond(res, await c.auth.register(body(registerSchema, req), ctx(req))));
  });
  r.post('/login', limit(rate, 10), async (req, res) => {
    const dto = body(loginSchema, req);
    res.status(200).json(respond(res, await c.auth.login(dto.email, dto.password, ctx(req))));
  });
  /** Cookie-authenticated → CSRF-protected. Rotates the refresh token. */
  r.post('/refresh', cookieCsrf(c), limit(rate, 30), async (req, res) => {
    try {
      res.json(respond(res, await c.auth.refresh(req.cookies?.[REFRESH_COOKIE], ctx(req))));
    } catch (err) {
      res.clearCookie(REFRESH_COOKIE, cookie());
      throw err;
    }
  });
  r.post('/logout', cookieCsrf(c), async (req, res) => {
    await c.auth.logout(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, cookie());
    res.status(204).end();
  });
  r.post('/forgot-password', limit(rate, 3), async (req, res) => {
    await c.auth.forgotPassword(body(forgotPasswordSchema, req).email, ctx(req));
    res.status(202).json({ message: 'If an account exists for that email, a reset link has been sent.' });
  });
  r.post('/reset-password', limit(rate, 5), async (req, res) => {
    const dto = body(resetPasswordSchema, req);
    await c.auth.resetPassword(dto.token, dto.password, ctx(req));
    res.status(204).end();
  });
  return r;
}
