import cookieParser from 'cookie-parser';
import request from 'supertest';
import { signAccessToken } from '../src/auth/access-token';
import { validateEnv } from '../src/config/env';
import { createContainer } from '../src/container';
import { createApp } from '../src/http/app';

const env = validateEnv({
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db', JWT_ACCESS_SECRET: 'test-secret-test-secret-test-secret-123',
  CORS_ORIGINS: 'http://localhost:3000', APP_URL: 'http://localhost:3000', LOG_LEVEL: 'silent', JOBS_ENABLED: 'false', NODE_ENV: 'test',
});
void cookieParser;

describe('HTTP wiring (DB stubbed)', () => {
  let app: ReturnType<typeof createApp>;
  const users = new Map<string, { id: string; role: string; email: string; status: string }>();
  const sessions = new Map<string, { userId: string; revokedAt: Date | null; expiresAt: Date }>();

  const prismaStub = {
    $queryRaw: async () => [{ '?column?': 1 }],
    user: { findUnique: async ({ where }: any) => users.get(where.id) ?? null },
    session: { findUnique: async ({ where }: any) => sessions.get(where.id) ?? null },
    auditLog: { create: async () => ({}) },
  };

  beforeAll(async () => {
    app = createApp(createContainer({ prisma: prismaStub as any, env }), { rateLimit: false });
    users.set('u-customer', { id: 'u-customer', role: 'CUSTOMER', email: 'c@x.com', status: 'ACTIVE' });
    users.set('u-rider', { id: 'u-rider', role: 'RIDER', email: 'r@x.com', status: 'ACTIVE' });
    sessions.set('s-u-rider', { userId: 'u-rider', revokedAt: null, expiresAt: new Date(Date.now() + 3_600_000) });
    users.set('u-owner', { id: 'u-owner', role: 'RESTAURANT_OWNER', email: 'o@x.com', status: 'ACTIVE' });
    users.set('u-admin', { id: 'u-admin', role: 'ADMIN', email: 'a@x.com', status: 'ACTIVE' });
    for (const id of ['u-owner', 'u-admin']) sessions.set(`s-${id}`, { userId: id, revokedAt: null, expiresAt: new Date(Date.now() + 3_600_000) });
    users.set('u-suspended', { id: 'u-suspended', role: 'CUSTOMER', email: 's@x.com', status: 'SUSPENDED' });
    for (const id of ['u-customer', 'u-suspended']) {
      sessions.set(`s-${id}`, { userId: id, revokedAt: null, expiresAt: new Date(Date.now() + 3_600_000) });
    }
    sessions.set('s-revoked', { userId: 'u-customer', revokedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) });
  });


  const token = (sub: string, sid: string) => signAccessToken(env, { sub, sid });

  it('health is public', async () => {
    await request(app).get('/health/live').expect(200, { status: 'ok' });
    await request(app).get('/health/ready').expect(200);
  });

  it('protected routes require a bearer token and use the standard error envelope', async () => {
    const res = await request(app).get('/api/v1/users/me').expect(401);
    expect(res.body.error).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects garbage, expired-style and wrongly-signed tokens', async () => {
    await request(app).get('/api/v1/users/me').set('Authorization', 'Bearer nope').expect(401);
    const forged = signAccessToken({ ...env, JWT_ACCESS_SECRET: 'a-completely-different-secret-value-1234' }, { sub: 'u-customer', sid: 's-u-customer' });
    await request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${forged}`).expect(401);
  });

  it('rejects suspended users and revoked sessions even with a valid signature', async () => {
    await request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${token('u-suspended', 's-u-suspended')}`).expect(401);
    await request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${token('u-customer', 's-revoked')}`).expect(401);
  });

  it('refuses a session id that belongs to another user', async () => {
    await request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${token('u-customer', 's-u-suspended')}`).expect(401);
  });

  describe('auth endpoints', () => {
    it('validates registration input and never lets ADMIN self-register', async () => {
      const bad = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: 'not-an-email', password: 'short', fullName: 'A', role: 'ADMIN', extra: 1 })
        .expect(400);
      expect(bad.body.error.code).toBe('VALIDATION_FAILED');
      const details: string[] = bad.body.error.details;
      expect(details.join(' ')).toMatch(/email/);
      expect(details.join(' ')).toMatch(/role/);
      expect(details.join(' ')).toMatch(/Unrecognized key/); // strict schemas reject unknown fields
    });

    it('refresh and logout are CSRF-protected', async () => {
      await request(app).post('/api/v1/auth/refresh').expect(403); // no custom header
      await request(app)
        .post('/api/v1/auth/refresh')
        .set('Origin', 'https://evil.example')
        .set('X-Requested-With', 'FoodFlow')
        .expect(403); // origin not allow-listed
      await request(app)
        .post('/api/v1/auth/refresh')
        .set('Origin', 'http://localhost:3000')
        .set('X-Requested-With', 'FoodFlow')
        .expect(401); // passes CSRF, then fails: no cookie
      await request(app).post('/api/v1/auth/logout').expect(403);
    });
  });

  describe('customer commerce endpoints', () => {
    const customer = () => `Bearer ${token('u-customer', 's-u-customer')}`;
    const rider = () => `Bearer ${token('u-rider', 's-u-rider')}`;
    const http = () => request(app);

    it('restaurant browsing is public but requires a valid location', async () => {
      await http().get('/api/v1/restaurants').expect(400);
      await http().get('/api/v1/restaurants?lat=999&lng=90').expect(400);
      await http().get('/api/v1/restaurants?lat=abc&lng=90').expect(400);
      await http().get('/api/v1/restaurants?lat=23.79&lng=90.40&sort=bogus').expect(400);
      await http().get('/api/v1/restaurants?lat=23.79&lng=90.40&limit=1000').expect(400);
    });

    it('customer-only routes reject anonymous users (401) and other roles (403)', async () => {
      for (const [method, path] of [['get', '/api/v1/cart'], ['get', '/api/v1/addresses'], ['get', '/api/v1/orders'], ['post', '/api/v1/checkout/quote']] as const) {
        await http()[method](path).expect(401);
        await http()[method](path).set('Authorization', rider()).expect(403);
      }
    });

    it('riders cannot place or cancel orders, or touch carts', async () => {
      await http().post('/api/v1/orders').set('Authorization', rider()).send({}).expect(403);
      await http().post('/api/v1/orders/6f1d6f3e-2d6b-4c8e-9a53-1f6a0b9c2d11/cancel').set('Authorization', rider()).expect(403);
      await http().post('/api/v1/cart/items').set('Authorization', rider()).send({}).expect(403);
    });

    it('validates cart input (quantity bounds, ids, unknown fields)', async () => {
      const id = '6f1d6f3e-2d6b-4c8e-9a53-1f6a0b9c2d11';
      await http().post('/api/v1/cart/items').set('Authorization', customer()).send({ menuItemId: 'nope', quantity: 1 }).expect(400);
      await http().post('/api/v1/cart/items').set('Authorization', customer()).send({ menuItemId: id, quantity: 0 }).expect(400);
      await http().post('/api/v1/cart/items').set('Authorization', customer()).send({ menuItemId: id, quantity: 100 }).expect(400);
      await http().post('/api/v1/cart/items').set('Authorization', customer()).send({ menuItemId: id, quantity: 1, price: 1 }).expect(400); // client-supplied price is rejected, not ignored
    });

    it('validates addresses (coordinate ranges)', async () => {
      const good = { label: 'Home', line1: 'House 1, Road 2', city: 'Dhaka', lat: 23.79, lng: 90.40 };
      await http().post('/api/v1/addresses').set('Authorization', customer()).send({ ...good, lat: 91 }).expect(400);
      await http().post('/api/v1/addresses').set('Authorization', customer()).send({ ...good, lng: -181 }).expect(400);
      await http().post('/api/v1/addresses').set('Authorization', customer()).send({ ...good, lat: 'x' }).expect(400);
    });

    it('placing an order demands a well-formed Idempotency-Key and a valid body', async () => {
      const body = { addressId: '6f1d6f3e-2d6b-4c8e-9a53-1f6a0b9c2d11', paymentMethod: 'CASH_ON_DELIVERY' };
      const missing = await http().post('/api/v1/orders').set('Authorization', customer()).send(body).expect(400);
      expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      await http().post('/api/v1/orders').set('Authorization', customer()).set('Idempotency-Key', 'short').send(body).expect(400);
      await http().post('/api/v1/orders').set('Authorization', customer()).set('Idempotency-Key', 'valid-key-12345').send({ ...body, totalMinor: 1 }).expect(400); // client totals are not accepted
      await http().post('/api/v1/orders').set('Authorization', customer()).set('Idempotency-Key', 'valid-key-12345').send({ ...body, contactPhone: '017123' }).expect(400);
    });

    it('online payment is refused until it is actually implemented', async () => {
      const res = await http()
        .post('/api/v1/orders').set('Authorization', customer()).set('Idempotency-Key', 'valid-key-12345')
        .send({ addressId: '6f1d6f3e-2d6b-4c8e-9a53-1f6a0b9c2d11', paymentMethod: 'ONLINE' })
        .expect(422);
      expect(res.body.error.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
    });
  });

  describe('owner & admin endpoints', () => {
    const as = (id: string) => `Bearer ${token(id, `s-${id}`)}`;
    const http = () => request(app);
    const R = '6f1d6f3e-2d6b-4c8e-9a53-1f6a0b9c2d11';
    const owner = () => as('u-owner');

    it('owner routes are for restaurant owners only: anonymous 401; customer, rider and admin 403', async () => {
      const routes: [string, string][] = [
        ['get', '/api/v1/owner/restaurants'], ['post', '/api/v1/owner/restaurants'], ['get', `/api/v1/owner/restaurants/${R}/menu`],
        ['get', `/api/v1/owner/restaurants/${R}/orders`], ['put', `/api/v1/owner/restaurants/${R}/hours`], ['get', `/api/v1/owner/restaurants/${R}/stats`],
      ];
      for (const [method, path] of routes) {
        await (http() as any)[method](path).expect(401);
        for (const id of ['u-customer', 'u-rider', 'u-admin']) await (http() as any)[method](path).set('Authorization', as(id)).send({}).expect(403);
      }
    });

    it('admin routes are for admins only (owners cannot approve their own restaurant)', async () => {
      const routes: [string, string][] = [
        ['get', '/api/v1/admin/restaurants'], ['get', `/api/v1/admin/restaurants/${R}`], ['post', `/api/v1/admin/restaurants/${R}/approve`],
        ['post', `/api/v1/admin/restaurants/${R}/reinstate`], ['patch', `/api/v1/admin/restaurants/${R}/commission`],
      ];
      for (const [method, path] of routes) {
        await (http() as any)[method](path).expect(401);
        for (const id of ['u-customer', 'u-rider', 'u-owner']) await (http() as any)[method](path).set('Authorization', as(id)).send({}).expect(403);
      }
    });

    it('owners cannot set commission or approval fields when creating/updating a restaurant', async () => {
      const good = { name: 'Test Kitchen', phone: '+8801712345678', addressLine: 'House 1, Road 2', city: 'Dhaka', lat: 23.79, lng: 90.4, cuisineIds: [R] };
      for (const extra of [{ commissionBps: 0 }, { approvalStatus: 'APPROVED' }, { ownerId: R }, { isPaused: false }]) {
        await http().post('/api/v1/owner/restaurants').set('Authorization', owner()).send({ ...good, ...extra }).expect(400);
        await http().patch(`/api/v1/owner/restaurants/${R}`).set('Authorization', owner()).send(extra).expect(400);
      }
      await http().post('/api/v1/owner/restaurants').set('Authorization', owner()).send({ ...good, phone: '017' }).expect(400);
      await http().post('/api/v1/owner/restaurants').set('Authorization', owner()).send({ ...good, cuisineIds: [] }).expect(400);
      await http().post('/api/v1/owner/restaurants').set('Authorization', owner()).send({ ...good, lat: 100 }).expect(400);
    });

    it('validates hours, zones and menu input', async () => {
      const base = `/api/v1/owner/restaurants/${R}`;
      await http().put(`${base}/hours`).set('Authorization', owner()).send({ hours: [{ dayOfWeek: 9, opensAtMin: 600, closesAtMin: 900 }] }).expect(400);
      await http().put(`${base}/hours`).set('Authorization', owner()).send({ hours: 'always' }).expect(400);
      await http().post(`${base}/zones`).set('Authorization', owner()).send({ name: 'A', type: 'RADIUS' }).expect(400); // radius required
      await http().post(`${base}/zones`).set('Authorization', owner()).send({ name: 'A', type: 'RADIUS', radiusMeters: 5 }).expect(400);
      await http().post(`${base}/zones`).set('Authorization', owner()).send({ name: 'A', type: 'POLYGON' }).expect(400); // polygon required
      await http().post(`${base}/zones`).set('Authorization', owner()).send({ name: 'A', type: 'CIRCLE' }).expect(400);
      await http().post(`${base}/menu/items`).set('Authorization', owner()).send({ categoryId: R, name: 'x', basePriceMinor: -5 }).expect(400);
      await http().post(`${base}/menu/items`).set('Authorization', owner()).send({ categoryId: R, name: 'x', basePriceMinor: '100' }).expect(400);
      await http().post(`${base}/menu/items`).set('Authorization', owner()).send({ categoryId: 'nope', name: 'x', basePriceMinor: 5 }).expect(400);
      await http().put(`${base}/menu/items/${R}/variants`).set('Authorization', owner()).send({ variants: [{ name: 'S', priceMinor: 1.5 }] }).expect(400);
      await http().put(`${base}/menu/items/${R}/addon-groups`).set('Authorization', owner()).send({ groups: [{ name: 'G', minSelect: 0, maxSelect: 0, addons: [] }] }).expect(400);
      await http().get('/api/v1/owner/restaurants/not-a-uuid').set('Authorization', owner()).expect(400);
    });

    it('order actions need a reason where the business rules demand one', async () => {
      const base = `/api/v1/owner/restaurants/${R}/orders/${R}`;
      await http().post(`${base}/reject`).set('Authorization', owner()).send({}).expect(400);
      await http().post(`${base}/reject`).set('Authorization', owner()).send({ reason: 'x' }).expect(400);
      await http().post(`${base}/cancel`).set('Authorization', owner()).send({}).expect(400);
      await http().post(`${base}/accept`).set('Authorization', owner()).send({ prepMinutes: 2 }).expect(400);
      await http().post(`${base}/accept`).set('Authorization', owner()).send({ prepMinutes: 500 }).expect(400);
    });

    it('admin actions validate reasons and commission bounds', async () => {
      const base = `/api/v1/admin/restaurants/${R}`;
      await http().post(`${base}/reject`).set('Authorization', as('u-admin')).send({}).expect(400);
      await http().post(`${base}/suspend`).set('Authorization', as('u-admin')).send({ reason: 'x' }).expect(400);
      await http().patch(`${base}/commission`).set('Authorization', as('u-admin')).send({ commissionBps: 9999 }).expect(400);
      await http().patch(`${base}/commission`).set('Authorization', as('u-admin')).send({ commissionBps: -1 }).expect(400);
      await http().get('/api/v1/admin/restaurants?status=BOGUS').set('Authorization', as('u-admin')).expect(400);
    });
  });

  describe('money, reviews, support and admin routes', () => {
    const as = (id: string) => `Bearer ${token(id, `s-${id}`)}`;
    const http = () => request(app);
    const R = '6f1d6f3e-2d6b-4c8e-9a53-1f6a0b9c2d11';

    it('the payment webhook is public but refuses everything when online payment is off', async () => {
      await http().post('/api/v1/payments/webhook').set('Content-Type', 'application/json').send('{"eventId":"e","providerRef":"r"}').expect(404);
      await http().post('/api/v1/dev/payments/ffpay_x/simulate').send({ outcome: 'PAID' }).expect(404); // the simulator is not mounted
    });

    it('customer-only money routes reject other roles; support is open to every signed-in role', async () => {
      for (const [method, path] of [['post', `/api/v1/orders/${R}/review`], ['post', `/api/v1/orders/${R}/refund-requests`], ['get', `/api/v1/orders/${R}/refunds`]] as const) {
        await (http() as any)[method](path).expect(401);
        for (const id of ['u-rider', 'u-owner', 'u-admin']) await (http() as any)[method](path).set('Authorization', as(id)).send({}).expect(403);
      }
      await http().get('/api/v1/support/tickets').expect(401);
      await http().post('/api/v1/support/tickets').expect(401);
    });

    it('admin money/support/platform routes are admin-only', async () => {
      const routes: [string, string][] = [
        ['get', '/api/v1/admin/refunds'], ['post', `/api/v1/admin/refunds/${R}/review`], ['get', '/api/v1/admin/payouts'], ['post', '/api/v1/admin/payouts/generate'],
        ['get', '/api/v1/admin/reconciliation'], ['get', '/api/v1/admin/coupons'], ['post', '/api/v1/admin/coupons'], ['get', '/api/v1/admin/support/tickets'],
        ['get', '/api/v1/admin/users'], ['post', `/api/v1/admin/users/${R}/status`], ['get', '/api/v1/admin/stats'], ['get', '/api/v1/admin/audit-logs'],
        ['get', '/api/v1/admin/settings'], ['put', '/api/v1/admin/settings'], ['post', '/api/v1/admin/service-areas'], ['post', '/api/v1/admin/promotions/broadcast'],
      ];
      for (const [method, path] of routes) {
        await (http() as any)[method](path).expect(401);
        for (const id of ['u-customer', 'u-rider', 'u-owner']) await (http() as any)[method](path).set('Authorization', as(id)).send({}).expect(403);
      }
    });

    it('owner and rider money routes are scoped to their roles', async () => {
      await http().get('/api/v1/rider/earnings').set('Authorization', as('u-owner')).expect(403);
      await http().get('/api/v1/rider/payouts').set('Authorization', as('u-customer')).expect(403);
      await http().get('/api/v1/owner/payouts').set('Authorization', as('u-rider')).expect(403);
      await http().get(`/api/v1/owner/restaurants/${R}/coupons`).set('Authorization', as('u-customer')).expect(403);
      await http().get(`/api/v1/owner/restaurants/${R}/earnings`).set('Authorization', as('u-admin')).expect(403);
    });

    it('validates money inputs strictly', async () => {
      const cust = as('u-customer');
      await http().post(`/api/v1/orders/${R}/review`).set('Authorization', cust).send({ restaurantRating: 0 }).expect(400);
      await http().post(`/api/v1/orders/${R}/review`).set('Authorization', cust).send({ restaurantRating: 3.5 }).expect(400);
      await http().post(`/api/v1/orders/${R}/review`).set('Authorization', cust).send({ restaurantRating: 5, hidden: true }).expect(400);
      await http().post(`/api/v1/orders/${R}/refund-requests`).set('Authorization', cust).send({ amountMinor: -5, reason: 'valid reason' }).expect(400);
      await http().post(`/api/v1/orders/${R}/refund-requests`).set('Authorization', cust).send({ reason: 'x' }).expect(400);
      await http().post('/api/v1/support/tickets').set('Authorization', cust).send({ category: 'NOPE', subject: 'Hello there', description: 'A description that is long enough' }).expect(400);
      await http().post('/api/v1/support/tickets').set('Authorization', cust).send({ category: 'OTHER', subject: 'Hi', description: 'short' }).expect(400);
      const admin = as('u-admin');
      await http().post('/api/v1/admin/payouts/generate').set('Authorization', admin).send({ periodStart: 'yesterday' }).expect(400);
      await http().post('/api/v1/admin/coupons').set('Authorization', admin).send({ code: 'a b', type: 'FIXED_AMOUNT', value: 100, startsAt: '2026-01-01', endsAt: '2026-02-01' }).expect(400);
      await http().post('/api/v1/admin/users/' + R + '/status').set('Authorization', admin).send({ status: 'DELETED' }).expect(400);
      await http().put('/api/v1/admin/settings').set('Authorization', admin).send({ key: 'x' }).expect(400); // key too short
      await http().put('/api/v1/admin/settings').set('Authorization', admin).send({ key: 'no.such.setting', value: 1 }).expect(404); // unknown settings are refused before any query
      await http().get('/api/v1/admin/reconciliation').set('Authorization', admin).expect(400);
      await http().get('/api/v1/admin/audit-logs?limit=9999').set('Authorization', admin).expect(400);
    });
  });
});
