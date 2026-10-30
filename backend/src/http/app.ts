import cookieParser from 'cookie-parser';
import cors from 'cors';
import { randomUUID } from 'crypto';
import express, { Express, Router } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { Role } from '@prisma/client';
import { rootLogger } from '../common/logger';
import type { Container } from '../container';
import { authenticate, errorHandler, limit, notFoundHandler, requireRole } from './middleware';
import { adminRouter } from './routes/admin';
import { authRouter } from './routes/auth';
import { addressesRouter, cartRouter, checkoutRouter, notificationsRouter, ordersRouter, supportRouter, usersRouter } from './routes/customer';
import { DevPaymentProvider } from '../payments/provider';
import { devSimulateSchema } from '../schemas/money';
import { parse } from './validate';
import { ownerRouter } from './routes/owner';
import { discoveryRouter, healthRouter } from './routes/public';
import { riderRouter } from './routes/rider';

/**
 * Pipeline: request-id/logging → helmet → CORS allow-list → JSON (100 kB) → cookies → global rate limit → routes → 404 → error handler.
 * Everything under /api/v1 is private by default: public routers are mounted explicitly, private ones sit behind
 * `authenticate` (401) and then `requireRole` (403).
 */
export function createApp(c: Container, opts: { rateLimit?: boolean } = {}): Express {
  const rate = opts.rateLimit ?? true;
  const app = express();
  if (c.env.TRUST_PROXY) app.set('trust proxy', 1); // correct client IPs behind a load balancer
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger: rootLogger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: { ignore: (req) => (req.url ?? '').startsWith('/health') },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: c.env.CORS_ORIGINS, // exact allow-list, never "*" with credentials
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Request-Id', 'Idempotency-Key'],
      exposedHeaders: ['X-Request-Id'],
    }),
  );
  // Payment callbacks need the EXACT bytes that were signed, so they get the raw body (before the JSON parser).
  app.post('/api/v1/payments/webhook', express.raw({ type: '*/*', limit: '100kb' }), async (req, res) => {
    res.json(await c.payments.handleWebhook(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), req.headers, req.ip));
  });
  // SIMULATED gateway for local development only (PAYMENT_PROVIDER=dev, never in production): lets a frontend "pay".
  const dev = c.payments.provider;
  if (dev instanceof DevPaymentProvider && c.env.NODE_ENV !== 'production') {
    app.get('/api/v1/dev/payments/:ref', (req, res) => res.json({ simulated: true, providerRef: req.params.ref, hint: 'POST {"outcome":"PAID"|"FAILED"} to this URL + /simulate' }));
    app.post('/api/v1/dev/payments/:ref/simulate', express.json(), async (req, res) => {
      const d = parse(devSimulateSchema, req.body ?? {});
      const ref = String(req.params.ref);
      dev.complete(ref, d.outcome, d.amountMinor);
      const raw = JSON.stringify({ eventId: randomUUID(), providerRef: ref });
      res.json({ simulated: true, ...(await c.payments.handleWebhook(Buffer.from(raw), { 'x-ff-signature': dev.sign(raw) }, req.ip)) });
    });
  }
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use('/health', healthRouter(c)); // before the global limiter: probes must never be throttled

  const api = Router();
  api.use(limit(rate, 120));
  const auth = authenticate(c);
  const only = (...roles: Role[]) => [auth, requireRole(...roles)];

  api.use('/auth', authRouter(c, rate));
  api.use(discoveryRouter(c)); // /cuisines, /restaurants: public
  api.use('/users', auth, usersRouter(c));
  api.use('/notifications', auth, notificationsRouter(c));
  api.use('/support', auth, supportRouter(c));
  api.use('/addresses', ...only(Role.CUSTOMER), addressesRouter(c));
  api.use('/cart', ...only(Role.CUSTOMER), cartRouter(c));
  api.use('/checkout', ...only(Role.CUSTOMER), checkoutRouter(c));
  api.use('/orders', ...only(Role.CUSTOMER), ordersRouter(c));
  api.use('/owner', ...only(Role.RESTAURANT_OWNER), ownerRouter(c));
  api.use('/rider', ...only(Role.RIDER), riderRouter(c, rate));
  api.use('/admin', ...only(Role.ADMIN), adminRouter(c));
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
