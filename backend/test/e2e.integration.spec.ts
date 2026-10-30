import request from 'supertest';
import { hashPassword } from '../src/common/utils/password';
import { createApp } from '../src/http/app';
import { buildServices, describeIt, factories, setupDatabase, TestEnv } from './support/integration';

jest.setTimeout(180_000);

/**
 * The whole product over real HTTP: Express app + real services + real PostgreSQL.
 * Customer, restaurant owner, rider and admin each use only the public API.
 */
describeIt('end-to-end over HTTP (Express + PostgreSQL)', () => {
  let env: TestEnv;
  let c: ReturnType<typeof buildServices>;
  let http: ReturnType<typeof request>;
  let f: ReturnType<typeof factories>;
  const FW = { 'X-Requested-With': 'FoodFlow' };
  const R = { lat: 23.7925, lng: 90.4078 };

  beforeAll(async () => {
    env = await setupDatabase();
    c = buildServices(env.prisma);
    f = factories(env.prisma);
    http = request(createApp(c, { rateLimit: false }));
  });
  afterAll(async () => env.close());

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const register = async (role: string, i: number) => {
    const res = await http.post('/api/v1/auth/register').send({ email: `${role.toLowerCase()}${i}@e2e.test`, password: 'a-long-password-1', fullName: `E2E ${role} ${i}`, phone: `+88017000${String(i).padStart(5, '0')}`, role }).expect(201);
    return { id: res.body.user.id as string, token: res.body.accessToken as string };
  };

  it('register → set up a restaurant and a rider → approve → order → cook → dispatch → deliver', async () => {
    // ── people ──
    const customer = await register('CUSTOMER', 1);
    const owner = await register('RESTAURANT_OWNER', 2);
    const rider = await register('RIDER', 3);
    const adminUser = await f.user('ADMIN');
    await env.prisma.userCredential.create({ data: { userId: adminUser.id, passwordHash: await hashPassword('admin-password-123') } });
    const adminLogin = await http.post('/api/v1/auth/login').send({ email: adminUser.email, password: 'admin-password-123' }).expect(200);
    const admin = { token: adminLogin.body.accessToken as string };
    await http.post('/api/v1/auth/register').send({ email: 'x@e2e.test', password: 'a-long-password-1', fullName: 'Sneaky', role: 'ADMIN' }).expect(400); // nobody self-registers as admin

    // ── restaurant owner builds a restaurant ──
    const cuisine = await env.prisma.cuisineType.create({ data: { name: 'E2E Grill', slug: 'e2e-grill' } });
    const created = await http.post('/api/v1/owner/restaurants').set(auth(owner.token)).send({
      name: 'E2E Kitchen', phone: '+8801700000009', addressLine: 'Gulshan 2', city: 'Dhaka', lat: R.lat, lng: R.lng, cuisineIds: [cuisine.id], minOrderMinor: 10000, baseDeliveryFeeMinor: 5000,
    }).expect(201);
    const rid = created.body.id as string;
    expect(created.body.approvalStatus).toBe('PENDING');
    const mine = () => `/api/v1/owner/restaurants/${rid}`;

    // not live yet: the admin cannot approve an unfinished restaurant, and customers cannot see it
    const early = await http.post(`/api/v1/admin/restaurants/${rid}/approve`).set(auth(admin.token)).expect(422);
    expect(early.body.error).toMatchObject({ code: 'RESTAURANT_NOT_READY', details: { missing: expect.arrayContaining(['Set opening hours']) } });
    await http.get(`/api/v1/restaurants/${rid}`).expect(404);

    await http.put(`${mine()}/hours`).set(auth(owner.token)).send({ hours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, opensAtMin: 0, closesAtMin: 1440 })) }).expect(200);
    await http.post(`${mine()}/zones`).set(auth(owner.token)).send({ name: 'Local', type: 'RADIUS', radiusMeters: 4000 }).expect(201);
    const poly = await http.post(`${mine()}/zones`).set(auth(owner.token)).send({ name: 'Bowtie', type: 'POLYGON', polygon: [[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]] });
    expect(poly.status).toBe(422); // self-intersecting area is refused (needs PostGIS in the real DB)
    expect(poly.body.error.code).toBe('INVALID_POLYGON');
    const cat = await http.post(`${mine()}/menu/categories`).set(auth(owner.token)).send({ name: 'Mains' }).expect(201);
    const item = await http.post(`${mine()}/menu/items`).set(auth(owner.token)).send({ categoryId: cat.body.id, name: 'Smash Burger', basePriceMinor: 30000, stockQuantity: 20 }).expect(201);
    await http.put(`${mine()}/menu/items/${item.body.id}/variants`).set(auth(owner.token)).send({ variants: [{ name: 'Single', priceMinor: 30000 }, { name: 'Double', priceMinor: 45000 }] }).expect(200);
    expect((await http.get(mine()).set(auth(owner.token)).expect(200)).body.readiness).toEqual({ ready: true, missing: [] });

    // an owner can't approve themselves; the admin can
    await http.post(`/api/v1/admin/restaurants/${rid}/approve`).set(auth(owner.token)).expect(403);
    await http.post(`/api/v1/admin/restaurants/${rid}/approve`).set(auth(admin.token)).expect(200, { id: rid, approvalStatus: 'APPROVED' });

    // ── rider onboarding ──
    await http.put('/api/v1/rider/status').set(auth(rider.token)).send({ isOnline: true, lat: R.lat, lng: R.lng }).expect(403); // not approved yet
    await http.put('/api/v1/rider/vehicle').set(auth(rider.token)).send({ vehicleType: 'BICYCLE' }).expect(200);
    await http.put('/api/v1/rider/documents').set(auth(rider.token)).send({ type: 'NATIONAL_ID', storageKey: 'riders/not-mine/id.jpg' }).expect(422);
    await http.put('/api/v1/rider/documents').set(auth(rider.token)).send({ type: 'NATIONAL_ID', storageKey: `riders/${rider.id}/id.jpg` }).expect(200);
    await http.put('/api/v1/rider/documents').set(auth(rider.token)).send({ type: 'SELFIE', storageKey: `riders/${rider.id}/me.jpg` }).expect(200);
    const detail = await http.get(`/api/v1/admin/riders/${rider.id}`).set(auth(admin.token)).expect(200);
    expect(JSON.stringify(detail.body)).not.toMatch(/lastLat|lastLng/); // no coordinates in the admin view
    for (const d of detail.body.documents) await http.post(`/api/v1/admin/riders/${rider.id}/documents/${d.id}/review`).set(auth(admin.token)).send({ approve: true }).expect(200);
    await http.post(`/api/v1/admin/riders/${rider.id}/approve`).set(auth(admin.token)).expect(200);
    await http.put('/api/v1/rider/status').set(auth(rider.token)).send({ isOnline: true, lat: R.lat + 0.004, lng: R.lng }).expect(200, { isOnline: true });

    // ── customer discovers, builds a cart, checks out ──
    const addr = await http.post('/api/v1/addresses').set(auth(customer.token)).send({ label: 'Home', line1: 'House 7, Road 3', city: 'Dhaka', lat: 23.7937, lng: 90.4066 }).expect(201);
    const found = await http.get(`/api/v1/restaurants?lat=23.7937&lng=90.4066&cuisine=e2e-grill`).expect(200);
    expect(found.body.items.map((r: any) => r.id)).toEqual([rid]);
    const page = await http.get(`/api/v1/restaurants/${rid}?lat=23.7937&lng=90.4066`).expect(200);
    expect(page.body.deliverability).toMatchObject({ deliverable: true, deliveryFeeMinor: 5000 });
    expect(JSON.stringify(page.body)).not.toMatch(/stockQuantity|"commissionBps"/);
    const double = page.body.menu[0].items[0].variants.find((v: any) => v.name === 'Double');

    await http.post('/api/v1/cart/items').set(auth(customer.token)).send({ menuItemId: item.body.id, variantId: double.id, quantity: 2, price: 1 }).expect(400); // client prices are rejected, not ignored
    const cart = await http.post('/api/v1/cart/items').set(auth(customer.token)).send({ menuItemId: item.body.id, variantId: double.id, quantity: 2 }).expect(201);
    expect(cart.body.subtotalMinor).toBe(90000);
    const quote = await http.post('/api/v1/checkout/quote').set(auth(customer.token)).send({ addressId: addr.body.id }).expect(200);
    expect(quote.body).toMatchObject({ canCheckout: true, totals: { subtotalMinor: 90000, deliveryFeeMinor: 5000, serviceFeeMinor: 1000, totalMinor: 96000 }, paymentMethods: ['CASH_ON_DELIVERY'] });

    const body = { addressId: addr.body.id, paymentMethod: 'CASH_ON_DELIVERY' };
    await http.post('/api/v1/orders').set(auth(customer.token)).send(body).expect(400); // Idempotency-Key required
    await http.post('/api/v1/orders').set(auth(customer.token)).set('Idempotency-Key', 'e2e-key-0001').send({ ...body, paymentMethod: 'ONLINE' }).expect(422);
    const placed = await http.post('/api/v1/orders').set(auth(customer.token)).set('Idempotency-Key', 'e2e-key-0001').send(body).expect(201);
    const replay = await http.post('/api/v1/orders').set(auth(customer.token)).set('Idempotency-Key', 'e2e-key-0001').send(body).expect(200);
    expect(replay.body.id).toBe(placed.body.id);
    const oid = placed.body.id as string;
    expect(placed.body).toMatchObject({ status: 'PLACED', totals: { totalMinor: 96000 } });
    await http.get(`/api/v1/orders/${oid}`).set(auth(owner.token)).expect(403); // owners use their own endpoints
    await http.get(`/api/v1/orders/${oid}`).set(auth(rider.token)).expect(403);

    // ── kitchen ──
    const ro = `${mine()}/orders/${oid}`;
    const queue = await http.get(`${mine()}/orders`).set(auth(owner.token)).expect(200);
    expect(queue.body.items.map((o: any) => o.id)).toEqual([oid]);
    expect(JSON.stringify(queue.body)).not.toMatch(/House 7|\+88017/);
    await http.post(`${ro}/ready`).set(auth(owner.token)).expect(409); // cannot skip steps
    await http.post(`${ro}/accept`).set(auth(owner.token)).send({ prepMinutes: 25 }).expect(200);
    await c.dispatch.sweep(); // (the background job in production; the accept also kicks dispatch immediately)

    // ── rider receives and accepts the offer ──
    let offers: any[] = [];
    for (let i = 0; i < 20 && offers.length === 0; i++) {
      offers = (await http.get('/api/v1/rider/offers').set(auth(rider.token)).expect(200)).body;
      if (!offers.length) await new Promise((r) => setTimeout(r, 100));
    }
    expect(offers).toHaveLength(1);
    expect(JSON.stringify(offers[0])).not.toMatch(/House 7|\+88017|E2E CUSTOMER/);
    const accepted = await http.post(`/api/v1/rider/offers/${offers[0].offerId}/accept`).set(auth(rider.token)).expect(200);
    expect(accepted.body).toMatchObject({ orderId: oid, restaurant: { addressLine: 'Gulshan 2' }, cashToCollectMinor: 96000 });
    expect(accepted.body.customer.address).toBeUndefined(); // not before pickup

    // ── customer and rider coordinate from the order page ──
    expect((await http.get(`/api/v1/orders/${oid}/tracking`).set(auth(customer.token)).expect(200)).body).toMatchObject({ orderId: oid, location: null });
    await http.post(`/api/v1/orders/${oid}/chat/messages`).set(auth(customer.token)).send({ body: 'Gate 3, please call' }).expect(201);
    await http.get(`/api/v1/orders/${oid}/chat/messages`).set(auth(owner.token)).expect(403); // the restaurant is not in the chat
    const riderChat = await http.get(`/api/v1/rider/deliveries/${oid}/chat/messages`).set(auth(rider.token)).expect(200);
    expect(riderChat.body.messages.map((m: any) => m.body)).toEqual(['Gate 3, please call']);
    await http.post(`/api/v1/rider/deliveries/${oid}/chat/messages`).set(auth(rider.token)).send({ body: 'On my way' }).expect(201);
    expect((await http.get('/api/v1/notifications').set(auth(customer.token)).expect(200)).body.items.map((n: any) => n.title)).toEqual(expect.arrayContaining(['Order placed', 'Order accepted', 'Rider assigned']));

    await http.post(`${ro}/preparing`).set(auth(owner.token)).expect(200);
    await http.post(`/api/v1/orders/${oid}/cancel`).set(auth(customer.token)).send({ reason: 'changed my mind' }).expect(403); // too late once cooking started
    await http.post(`${ro}/ready`).set(auth(owner.token)).expect(200);
    expect((await http.get(`/api/v1/orders/${oid}`).set(auth(customer.token)).expect(200)).body.status).toBe('RIDER_ASSIGNED');

    // ── delivery ──
    await http.post(`/api/v1/rider/deliveries/${oid}/delivered`).set(auth(rider.token)).expect(409); // cannot skip pickup
    const picked = await http.post(`/api/v1/rider/deliveries/${oid}/pickup`).set(auth(rider.token)).expect(200);
    expect(picked.body.customer).toMatchObject({ phone: expect.stringMatching(/^\+88017/), address: { line1: 'House 7, Road 3' } });
    await http.post(`/api/v1/rider/deliveries/${oid}/on-the-way`).set(auth(rider.token)).expect(200);
    await http.post(`/api/v1/rider/deliveries/${oid}/delivered`).set(auth(rider.token)).expect(200);

    const final = await http.get(`/api/v1/orders/${oid}`).set(auth(customer.token)).expect(200);
    expect(final.body.status).toBe('DELIVERED');
    expect(final.body.payments[0]).toMatchObject({ status: 'SUCCESSFUL', amountMinor: 96000 });
    expect(final.body.timeline.map((t: any) => t.to)).toEqual(['PLACED', 'RESTAURANT_ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'RIDER_ASSIGNED', 'PICKED_UP', 'ON_THE_WAY', 'DELIVERED']);
    expect(final.body.customerActions).toEqual([]);
    const stats = await http.get(`${mine()}/stats`).set(auth(owner.token)).expect(200);
    expect(stats.body).toMatchObject({ ordersDelivered: 1, grossSalesMinor: 90000, commissionMinor: 13500, netMinor: 76500 }); // 15% of the food subtotal
    expect((await http.get('/api/v1/rider/deliveries/history').set(auth(rider.token)).expect(200)).body.total).toBe(1);

    // ── the chat closes with the order; the customer reviews; earnings exist ──
    await http.post(`/api/v1/orders/${oid}/chat/messages`).set(auth(customer.token)).send({ body: 'thanks' }).expect(409);
    expect((await http.get(`/api/v1/orders/${oid}/chat/messages`).set(auth(customer.token)).expect(200)).body).toMatchObject({ room: { open: false } });
    await http.post(`/api/v1/orders/${oid}/review`).set(auth(customer.token)).send({ restaurantRating: 5, riderRating: 5, comment: 'Perfect' }).expect(201);
    await http.post(`/api/v1/orders/${oid}/review`).set(auth(customer.token)).send({ restaurantRating: 1 }).expect(409); // one review per order
    expect((await http.get(`/api/v1/restaurants/${rid}/reviews`).expect(200)).body).toMatchObject({ rating: { average: 5, count: 1 } });
    expect((await http.get('/api/v1/rider/earnings').set(auth(rider.token)).expect(200)).body).toMatchObject({ total: 1, unpaidEarningsMinor: 4000, cashToRemitMinor: 96000 });
    expect((await http.get(`${mine()}/earnings`).set(auth(owner.token)).expect(200)).body).toMatchObject({ total: 1, unpaidNetMinor: 76500 });
    expect((await env.prisma.menuItem.findUniqueOrThrow({ where: { id: item.body.id } })).stockQuantity).toBe(18);
    expect(await env.prisma.auditLog.count({ where: { action: { in: ['restaurant.approve', 'rider.approve'] } } })).toBe(2);
  });

  describe('sessions & cookies', () => {
    it('refresh rotates the cookie, a replayed old cookie kills the whole session family, and logout works', async () => {
      const agent = request.agent(createApp(c, { rateLimit: false }));
      const reg = await agent.post('/api/v1/auth/register').send({ email: 'cookie@e2e.test', password: 'a-long-password-1', fullName: 'Cookie Monster', role: 'CUSTOMER' }).expect(201);
      const firstCookie = (reg.headers['set-cookie'] as unknown as string[])[0];
      expect(firstCookie).toMatch(/ff_rt=.+; Path=\/api\/v1\/auth; Expires=.+; HttpOnly; SameSite=Lax/);

      await agent.post('/api/v1/auth/refresh').expect(403); // CSRF header missing
      await agent.post('/api/v1/auth/refresh').set('Origin', 'https://evil.example').set(FW).expect(403);
      const refreshed = await agent.post('/api/v1/auth/refresh').set('Origin', 'http://localhost:3000').set(FW).expect(200);
      expect(refreshed.body.accessToken).toBeTruthy();
      expect((refreshed.headers['set-cookie'] as unknown as string[])[0]).not.toBe(firstCookie);

      // the stolen, already-rotated cookie is replayed (after the 10 s race grace)
      await env.prisma.session.updateMany({ where: { revokedAt: { not: null } }, data: { revokedAt: new Date(Date.now() - 60_000) } });
      const thief = request(createApp(c, { rateLimit: false }));
      await thief.post('/api/v1/auth/refresh').set('Cookie', firstCookie.split(';')[0]).set(FW).expect(401);
      await agent.post('/api/v1/auth/refresh').set(FW).expect(401); // the legitimate cookie died with the family
      await agent.get('/api/v1/users/me').set(auth(refreshed.body.accessToken)).expect(401); // and so did its access token

      const login = await agent.post('/api/v1/auth/login').send({ email: 'cookie@e2e.test', password: 'a-long-password-1' }).expect(200);
      await agent.post('/api/v1/auth/logout').set(FW).expect(204);
      await agent.post('/api/v1/auth/refresh').set(FW).expect(401);
      await agent.get('/api/v1/users/me').set(auth(login.body.accessToken)).expect(401);
    });

    it('login is throttled, and 5 wrong passwords lock the account without revealing which emails exist', async () => {
      const limited = request(createApp(c, { rateLimit: true }));
      const codes: number[] = [];
      for (let i = 0; i < 11; i++) codes.push((await limited.post('/api/v1/auth/login').send({ email: 'nobody@e2e.test', password: 'wrong-password-1' })).status);
      expect(codes.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(codes[10]).toBe(429);

      const open = request(createApp(c, { rateLimit: false }));
      await open.post('/api/v1/auth/register').send({ email: 'lock@e2e.test', password: 'a-long-password-1', fullName: 'Lock Me', role: 'CUSTOMER' }).expect(201);
      for (let i = 0; i < 5; i++) await open.post('/api/v1/auth/login').send({ email: 'lock@e2e.test', password: 'wrong-password-1' }).expect(401);
      const locked = await open.post('/api/v1/auth/login').send({ email: 'lock@e2e.test', password: 'a-long-password-1' }).expect(429);
      expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
      const unknown = await open.post('/api/v1/auth/login').send({ email: 'ghost@e2e.test', password: 'a-long-password-1' }).expect(401);
      expect(unknown.body.error.message).toBe('Invalid email or password');
    });
  });
});
