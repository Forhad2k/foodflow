import { randomUUID } from 'crypto';
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { io as connectClient, Socket } from 'socket.io-client';
import request from 'supertest';
import { signAccessToken } from '../src/auth/access-token';
import { createApp } from '../src/http/app';
import { RealtimeGateway } from '../src/realtime/gateway';
import { OwnerOrdersService } from '../src/restaurants/owner-orders.service';
import { OrderStatus, PaymentMethod, VehicleType } from '@prisma/client';
import { buildServices, describeIt, factories, setupDatabase, TestEnv, testEnv } from './support/integration';

jest.setTimeout(240_000);

const R = { lat: 23.7925, lng: 90.4078 };
const NEAR = { lat: R.lat + 0.0045, lng: R.lng };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeIt('realtime: notifications, tracking and chat over real Socket.IO + PostgreSQL', () => {
  let env: TestEnv;
  let c: ReturnType<typeof buildServices>;
  let f: ReturnType<typeof factories>;
  let server: HttpServer;
  let gateway: RealtimeGateway;
  let url: string;
  let owners: OwnerOrdersService;
  const sockets: Socket[] = [];
  let n = 0;

  beforeAll(async () => {
    env = await setupDatabase();
    c = buildServices(env.prisma);
    f = factories(env.prisma);
    owners = new OwnerOrdersService(env.prisma, c.access, c.transitions);
    server = createServer(createApp(c, { rateLimit: false }));
    gateway = new RealtimeGateway(c, server);
    await c.fanout.start();
    await new Promise<void>((r) => server.listen(0, r));
    url = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    sockets.forEach((s) => s.close());
    await c.fanout.stop();
    await gateway.close();
    await env.close();
  });
  afterEach(async () => {
    await setSetting('tracking.updateIntervalSeconds', 4);
    await setSetting('chat.messagesPerMinute', 20);
  });

  // ───────────── helpers ─────────────
  const setSetting = async (key: string, value: unknown) => {
    await env.prisma.platformSetting.upsert({ where: { key }, update: { value: value as never }, create: { key, value: value as never } });
    c.settings.invalidate();
  };
  const session = async (userId: string) => {
    const sid = randomUUID();
    await env.prisma.session.create({ data: { id: sid, userId, familyId: randomUUID(), refreshTokenHash: `${sid}-${randomUUID()}`, expiresAt: new Date(Date.now() + 3_600_000) } });
    return { sid, token: signAccessToken(testEnv, { sub: userId, sid }) };
  };
  const connect = async (token: string): Promise<Socket> => {
    const s = connectClient(url, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(s);
    await new Promise<void>((res, rej) => { s.once('connect', () => res()); s.once('connect_error', (e) => rej(e)); });
    return s;
  };
  const ask = (s: Socket, event: string, payload: unknown): Promise<any> => new Promise((res) => s.timeout(5000).emit(event, payload, (err: unknown, ack: unknown) => res(err ? { ok: false, error: { code: 'TIMEOUT' } } : ack)));
  /** Records every payload of `event` so tests can assert what did and did not arrive. */
  const record = (s: Socket, event: string) => { const got: any[] = []; s.on(event, (p) => got.push(p)); return got; };
  const until = async (cond: () => boolean, ms = 4000) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await sleep(25); return cond(); };
  const user = async (role: 'CUSTOMER' | 'RESTAURANT_OWNER' | 'RIDER' | 'ADMIN') => { const u = await f.user(role); const s = await session(u.id); return { ...u, ...s }; };

  const makeRider = async () => {
    const u = await user('RIDER');
    await env.prisma.riderProfile.update({ where: { userId: u.id }, data: { approvalStatus: 'APPROVED', vehicleType: VehicleType.MOTORCYCLE, isOnline: true, lastLat: NEAR.lat, lastLng: NEAR.lng, lastLocationAt: new Date() } });
    return u;
  };
  /** A cooking order with a rider who has already accepted it. */
  const scenario = async (o: { accept?: boolean } = {}) => {
    const owner = await user('RESTAURANT_OWNER');
    const { restaurant, items } = await f.restaurant(owner.id, { lat: R.lat, lng: R.lng });
    const customer = await user('CUSTOMER');
    const address = await f.address(customer.id, 23.7937, 90.4066);
    await c.carts.addItem(customer.id, { menuItemId: items[0].id, quantity: 1 });
    const { order } = await c.orders.placeOrder(customer.id, { addressId: address.id, paymentMethod: PaymentMethod.CASH_ON_DELIVERY }, `rt-${Date.now()}-${n++}`);
    await owners.accept(owner.id, restaurant.id, order.id, {});
    await owners.startPreparing(owner.id, restaurant.id, order.id);
    let rider: Awaited<ReturnType<typeof makeRider>> | undefined;
    if (o.accept !== false) {
      rider = await makeRider();
      await c.dispatch.offerNext(order.id);
      const offer = await env.prisma.deliveryAssignment.findFirstOrThrow({ where: { orderId: order.id, status: 'OFFERED' } });
      await c.riders.accept(rider.id, offer.id);
    }
    return { owner, restaurant, customer, order, rider };
  };
  const quiet = async () => { await env.prisma.riderProfile.updateMany({ data: { isOnline: false } }); };

  // ───────────── connection security ─────────────
  describe('connecting', () => {
    it('needs a valid token for a live session', async () => {
      await expect(new Promise((res, rej) => { const s = connectClient(url, { transports: ['websocket'], forceNew: true, reconnection: false }); sockets.push(s); s.once('connect', () => res(undefined)); s.once('connect_error', (e) => rej(e.message)); })).rejects.toBe('UNAUTHORIZED');
      await expect(connect('garbage')).rejects.toBeTruthy();
      const forged = signAccessToken({ ...testEnv, JWT_ACCESS_SECRET: 'x'.repeat(40) }, { sub: randomUUID(), sid: randomUUID() });
      await expect(connect(forged)).rejects.toBeTruthy();
      const u = await user('CUSTOMER');
      await env.prisma.session.update({ where: { id: u.sid }, data: { revokedAt: new Date() } });
      await expect(connect(u.token)).rejects.toBeTruthy(); // logged-out session
    });

    it('a logout or suspension cuts an already-connected socket off on its next action', async () => {
      const u = await user('CUSTOMER');
      const s = await connect(u.token);
      expect((await ask(s, 'notifications:sync', {})).ok).toBe(true);
      const expired = record(s, 'auth:expired');
      await env.prisma.session.update({ where: { id: u.sid }, data: { revokedAt: new Date() } });
      const ack = await ask(s, 'notifications:sync', {});
      expect(ack).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
      expect(await until(() => expired.length > 0)).toBe(true);
      expect(await until(() => !s.connected)).toBe(true);

      const v = await user('CUSTOMER');
      const s2 = await connect(v.token);
      await env.prisma.user.update({ where: { id: v.id }, data: { status: 'SUSPENDED' } });
      expect((await ask(s2, 'notifications:sync', {})).ok).toBe(false);
    });

    it('bad payloads get a clean error, never a crash; floods are throttled', async () => {
      const s = await connect((await user('CUSTOMER')).token);
      expect(await ask(s, 'chat:send', { orderId: 'nope', body: 'x', clientMessageId: 'short' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      expect(await ask(s, 'chat:send', 'not an object')).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      expect(await ask(s, 'chat:send', { orderId: randomUUID(), body: 'x', clientMessageId: 'abcdefgh', extra: 1 })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      const acks = await Promise.all(Array.from({ length: 130 }, () => ask(s, 'notifications:sync', {})));
      expect(acks.some((a) => a.error?.code === 'RATE_LIMITED')).toBe(true);
      expect(s.connected).toBe(true);
    });
  });

  // ───────────── notifications ─────────────
  describe('notifications', () => {
    it('are created in the same transaction as the change, pushed on commit, and visible only to their owner', async () => {
      await quiet();
      const owner = await user('RESTAURANT_OWNER');
      const { restaurant, items } = await f.restaurant(owner.id);
      const customer = await user('CUSTOMER');
      const stranger = await user('CUSTOMER');
      const address = await f.address(customer.id, 23.7937, 90.4066);
      const [ownerSock, custSock, strangerSock] = await Promise.all([connect(owner.token), connect(customer.token), connect(stranger.token)]);
      const forOwner = record(ownerSock, 'notification');
      const forCustomer = record(custSock, 'notification');
      const forStranger = record(strangerSock, 'notification');

      await c.carts.addItem(customer.id, { menuItemId: items[0].id, quantity: 1 });
      const { order } = await c.orders.placeOrder(customer.id, { addressId: address.id, paymentMethod: PaymentMethod.CASH_ON_DELIVERY }, `nt-${Date.now()}`);
      expect(await until(() => forOwner.length > 0 && forCustomer.length > 0)).toBe(true);
      expect(forOwner[0]).toMatchObject({ title: 'New order', unreadCount: 1, data: { orderId: order.id } });
      expect(forCustomer[0]).toMatchObject({ title: 'Order placed' });

      await owners.accept(owner.id, restaurant.id, order.id, {});
      expect(await until(() => forCustomer.some((x) => x.title === 'Order accepted'))).toBe(true);

      // a refused change leaves no notification behind
      const before = await env.prisma.notification.count({ where: { userId: customer.id } });
      await expect(owners.markReady(owner.id, restaurant.id, order.id)).rejects.toMatchObject({ code: 'INVALID_ORDER_TRANSITION' });
      expect(await env.prisma.notification.count({ where: { userId: customer.id } })).toBe(before);

      await sleep(150);
      expect(forStranger).toHaveLength(0);
      expect((await ask(custSock, 'notifications:sync', {})).unreadCount).toBe(2);
    });

    it('can be listed, counted and marked read over REST, only by their owner', async () => {
      const s = await scenario({ accept: false });
      const http = request(server);
      const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
      const list = await http.get('/api/v1/notifications').set(auth(s.customer.token)).expect(200);
      expect(list.body.items.map((x: any) => x.title)).toEqual(expect.arrayContaining(['Order placed', 'Order accepted', 'Preparing your food']));
      expect(list.body.unreadCount).toBe(list.body.total);
      expect((await http.get('/api/v1/notifications/unread-count').set(auth(s.customer.token)).expect(200)).body.unreadCount).toBe(list.body.total);
      const first = list.body.items[0].id;
      const other = await user('CUSTOMER');
      await http.post(`/api/v1/notifications/${first}/read`).set(auth(other.token)).expect(404); // someone else's
      const read = await http.post(`/api/v1/notifications/${first}/read`).set(auth(s.customer.token)).expect(200);
      expect(read.body.unreadCount).toBe(list.body.total - 1);
      expect((await http.get('/api/v1/notifications?unread=true').set(auth(s.customer.token)).expect(200)).body.items.some((x: any) => x.id === first)).toBe(false);
      expect((await http.post('/api/v1/notifications/read-all').set(auth(s.customer.token)).expect(200)).body.unreadCount).toBe(0);
      await http.get('/api/v1/notifications').expect(401);
      await http.get('/api/v1/notifications?limit=500').set(auth(s.customer.token)).expect(400);
    });

    it('a rider is told about an offer and the customer and restaurant about the assigned rider', async () => {
      await quiet();
      const rider = await makeRider();
      const riderSock = await connect(rider.token);
      const forRider = record(riderSock, 'notification');
      const owner = await user('RESTAURANT_OWNER');
      const { restaurant, items } = await f.restaurant(owner.id, { lat: R.lat, lng: R.lng });
      const customer = await user('CUSTOMER');
      const address = await f.address(customer.id, 23.7937, 90.4066);
      const custSock = await connect(customer.token);
      const forCust = record(custSock, 'notification');
      await c.carts.addItem(customer.id, { menuItemId: items[0].id, quantity: 1 });
      const { order } = await c.orders.placeOrder(customer.id, { addressId: address.id, paymentMethod: PaymentMethod.CASH_ON_DELIVERY }, `of-${Date.now()}`);
      await owners.accept(owner.id, restaurant.id, order.id, {});
      await c.dispatch.offerNext(order.id);
      expect(await until(() => forRider.some((x) => x.title === 'New delivery offer'))).toBe(true);
      const offerId = forRider.find((x) => x.title === 'New delivery offer').data.offerId;
      await c.riders.accept(rider.id, offerId);
      expect(await until(() => forCust.some((x) => x.title === 'Rider assigned'))).toBe(true);
    });
  });

  // ───────────── live tracking ─────────────
  describe('live tracking', () => {
    it('only the order’s customer, its assigned rider and admins can watch; location flows with an ETA', async () => {
      await quiet();
      const s = await scenario();
      const stranger = await user('CUSTOMER');
      const otherRider = await makeRider();
      const admin = await user('ADMIN');
      const [cust, rid, strg, owner, other, adm] = await Promise.all([connect(s.customer.token), connect(s.rider!.token), connect(stranger.token), connect(s.owner.token), connect(otherRider.token), connect(admin.token)]);

      expect(await ask(cust, 'tracking:subscribe', { orderId: s.order.id })).toMatchObject({ ok: true, location: null, staleAfterSeconds: 30 });
      expect((await ask(rid, 'tracking:subscribe', { orderId: s.order.id })).ok).toBe(true);
      expect((await ask(adm, 'tracking:subscribe', { orderId: s.order.id })).ok).toBe(true);
      for (const sock of [strg, owner, other]) expect(await ask(sock, 'tracking:subscribe', { orderId: s.order.id })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });

      const seenCust = record(cust, 'tracking:location');
      const seenStranger = record(strg, 'tracking:location');
      const seenOwner = record(owner, 'tracking:location');
      const ack = await ask(rid, 'rider:location', { orderId: s.order.id, lat: NEAR.lat, lng: NEAR.lng, accuracyM: 8, headingDeg: 90, speedMps: 6 });
      expect(ack.ok).toBe(true);
      expect(await until(() => seenCust.length === 1)).toBe(true);
      expect(seenCust[0]).toMatchObject({ orderId: s.order.id, lat: NEAR.lat, destination: 'RESTAURANT', etaSource: 'estimate', headingDeg: 90 });
      expect(seenCust[0].etaMinutes).toBeGreaterThanOrEqual(1);
      await sleep(150);
      expect(seenStranger).toHaveLength(0);
      expect(seenOwner).toHaveLength(0);

      // late joiners get the last known position
      const late = await connect(s.customer.token);
      expect((await ask(late, 'tracking:subscribe', { orderId: s.order.id })).location).toMatchObject({ lat: NEAR.lat, stale: false });
      expect((await request(server).get(`/api/v1/orders/${s.order.id}/tracking`).set({ Authorization: `Bearer ${s.customer.token}` }).expect(200)).body.location.lat).toBe(NEAR.lat);
      await request(server).get(`/api/v1/orders/${s.order.id}/tracking`).set({ Authorization: `Bearer ${stranger.token}` }).expect(404);
    });

    it('rejects bad, foreign, too-frequent and teleporting updates; the destination switches after pickup', async () => {
      await quiet();
      const s = await scenario();
      const intruder = await makeRider();
      const rid = await connect(s.rider!.token);
      const bad = await connect(intruder.token);
      const loc = (o: object = {}) => ({ orderId: s.order.id, lat: NEAR.lat, lng: NEAR.lng, ...o });

      expect(await ask(rid, 'rider:location', loc({ lat: 91 }))).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      expect(await ask(rid, 'rider:location', loc({ lng: -181 }))).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      expect(await ask(rid, 'rider:location', loc({ speedMps: 500 }))).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      expect(await ask(bad, 'rider:location', loc())).toMatchObject({ ok: false, error: { code: 'TRACKING_NOT_ACTIVE' } }); // not their delivery
      expect(await ask(rid, 'rider:location', loc({ orderId: randomUUID() }))).toMatchObject({ ok: false, error: { code: 'TRACKING_NOT_ACTIVE' } });
      expect((await ask(rid, 'rider:location', loc())).ok).toBe(true);
      expect(await ask(rid, 'rider:location', loc())).toMatchObject({ ok: false, error: { code: 'TOO_FREQUENT' } }); // default interval 4 s → min gap 2 s

      await setSetting('tracking.updateIntervalSeconds', 0);
      expect(await ask(rid, 'rider:location', loc({ lat: NEAR.lat + 0.2 }))).toMatchObject({ ok: false, error: { code: 'IMPLAUSIBLE_LOCATION' } });
      expect((await ask(rid, 'rider:location', loc({ lat: NEAR.lat + 0.0005 }))).ok).toBe(true);

      const cust = await connect(s.customer.token);
      const seen = record(cust, 'tracking:location');
      await ask(cust, 'tracking:subscribe', { orderId: s.order.id });
      await owners.markReady(s.owner.id, s.restaurant.id, s.order.id);
      await c.riders.step(s.rider!.id, s.order.id, OrderStatus.PICKED_UP);
      await ask(rid, 'rider:location', loc({ lat: NEAR.lat + 0.001 }));
      expect(await until(() => seen.length === 1)).toBe(true);
      expect(seen[0].destination).toBe('CUSTOMER'); // heading to the customer now

      expect(await env.prisma.riderLocationUpdate.count({ where: { riderId: s.rider!.id } })).toBe(3); // rejected updates were never stored
    });

    it('warns about a silent rider, recovers, reports a dropped connection, and ends when the delivery does', async () => {
      await quiet();
      await setSetting('tracking.updateIntervalSeconds', 0);
      const s = await scenario();
      const rid = await connect(s.rider!.token);
      const cust = await connect(s.customer.token);
      const stale = record(cust, 'tracking:stale');
      const fresh = record(cust, 'tracking:fresh');
      const gone = record(cust, 'tracking:rider_disconnected');
      const ended = record(cust, 'tracking:ended');
      await ask(cust, 'tracking:subscribe', { orderId: s.order.id });
      await ask(rid, 'tracking:subscribe', { orderId: s.order.id });
      await ask(rid, 'rider:location', { orderId: s.order.id, lat: NEAR.lat, lng: NEAR.lng });

      await gateway.tick(new Date(Date.now() + 120_000)); // two minutes of silence
      expect(await until(() => stale.length === 1)).toBe(true);
      await gateway.tick(new Date(Date.now() + 130_000));
      await sleep(100);
      expect(stale).toHaveLength(1); // warned once per episode, not every tick
      await ask(rid, 'rider:location', { orderId: s.order.id, lat: NEAR.lat + 0.0003, lng: NEAR.lng });
      expect(await until(() => fresh.length === 1)).toBe(true);

      rid.close(); // the rider's app dies
      expect(await until(() => gone.length === 1)).toBe(true);

      await owners.markReady(s.owner.id, s.restaurant.id, s.order.id);
      for (const to of [OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY, OrderStatus.DELIVERED]) await c.riders.step(s.rider!.id, s.order.id, to);
      await gateway.tick();
      expect(await until(() => ended.length === 1)).toBe(true);
      expect(ended[0]).toMatchObject({ orderId: s.order.id, reason: 'DELIVERED' });
      expect(await ask(cust, 'tracking:subscribe', { orderId: s.order.id })).toMatchObject({ ok: false, error: { code: 'TRACKING_NOT_ACTIVE' } });
      const rid2 = await connect(s.rider!.token);
      expect(await ask(rid2, 'rider:location', { orderId: s.order.id, lat: NEAR.lat, lng: NEAR.lng })).toMatchObject({ ok: false, error: { code: 'TRACKING_NOT_ACTIVE' } });
    });

    it('when the rider is replaced, the old rider’s tracking ends and only the new rider can report', async () => {
      await quiet();
      await setSetting('tracking.updateIntervalSeconds', 0);
      const s = await scenario();
      const cust = await connect(s.customer.token);
      const oldRider = await connect(s.rider!.token);
      const ended = record(cust, 'tracking:ended');
      await ask(cust, 'tracking:subscribe', { orderId: s.order.id });
      await ask(oldRider, 'tracking:subscribe', { orderId: s.order.id });

      await c.dispatch.releaseDelivery(s.rider!.id, s.order.id, 'Flat tyre');
      await gateway.tick();
      expect(await until(() => ended.length === 1)).toBe(true);
      expect(ended[0].reason).toBe('REASSIGNED');
      expect(await ask(oldRider, 'rider:location', { orderId: s.order.id, lat: NEAR.lat, lng: NEAR.lng })).toMatchObject({ ok: false, error: { code: 'TRACKING_NOT_ACTIVE' } });
    });

    it('precise positions are deleted after the retention window', async () => {
      await quiet();
      await setSetting('tracking.updateIntervalSeconds', 0);
      const s = await scenario();
      const rid = await connect(s.rider!.token);
      await ask(rid, 'rider:location', { orderId: s.order.id, lat: NEAR.lat, lng: NEAR.lng });
      expect(await env.prisma.riderLocationUpdate.count({ where: { riderId: s.rider!.id } })).toBe(1);
      expect(await c.tracking.purgeOld(new Date())).toBe(0); // fresh rows stay
      expect(await c.tracking.purgeOld(new Date(Date.now() + 48 * 3_600_000))).toBeGreaterThanOrEqual(1);
      expect(await env.prisma.riderLocationUpdate.count({ where: { riderId: s.rider!.id } })).toBe(0);
    });
  });

  // ───────────── order chat ─────────────
  describe('order chat', () => {
    it('does not exist before a rider accepts, and is open only to that order’s customer and rider afterwards', async () => {
      await quiet();
      const early = await scenario({ accept: false });
      const earlyCust = await connect(early.customer.token);
      expect(await ask(earlyCust, 'chat:join', { orderId: early.order.id })).toMatchObject({ ok: false, error: { code: 'CHAT_NOT_AVAILABLE' } });

      const s = await scenario();
      const stranger = await user('CUSTOMER');
      const otherRider = await makeRider();
      const admin = await user('ADMIN');
      const join = (u: { token: string }) => connect(u.token).then((sock) => ask(sock, 'chat:join', { orderId: s.order.id }));
      expect(await join(s.customer)).toMatchObject({ ok: true, room: { open: true }, messages: [] });
      expect(await join(s.rider!)).toMatchObject({ ok: true });
      for (const u of [stranger, otherRider, s.owner, admin]) expect(await join(u)).toMatchObject({ ok: false, error: { code: 'CHAT_NOT_AVAILABLE' } }); // same answer as "no such chat"
    });

    it('delivers messages in real time with sent → delivered → read, de-duplicates retries, and cleans input', async () => {
      await quiet();
      const s = await scenario();
      const [cust, rid] = await Promise.all([connect(s.customer.token), connect(s.rider!.token)]);
      await ask(cust, 'chat:join', { orderId: s.order.id });
      const riderGets = record(rid, 'chat:message');
      const delivered = record(cust, 'chat:delivered');
      const readReceipts = record(cust, 'chat:read');

      // the rider has not joined the room yet: sent, but not delivered
      const first = await ask(cust, 'chat:send', { orderId: s.order.id, body: 'Gate 3, call me', clientMessageId: 'msg-000001' });
      expect(first).toMatchObject({ ok: true, duplicate: false, message: { senderRole: 'CUSTOMER', body: 'Gate 3, call me', deliveredAt: null, readAt: null } });
      expect(riderGets).toHaveLength(0);

      await ask(rid, 'chat:join', { orderId: s.order.id });
      const retry = await ask(cust, 'chat:send', { orderId: s.order.id, body: 'Gate 3, call me', clientMessageId: 'msg-000001' });
      expect(retry).toMatchObject({ ok: true, duplicate: true, message: { id: first.message.id } });
      const second = await ask(cust, 'chat:send', { orderId: s.order.id, body: '  Thanks\u0000 ', clientMessageId: 'msg-000002' });
      expect(second.message.body).toBe('Thanks');
      expect(await until(() => riderGets.length === 1)).toBe(true);
      expect(await until(() => delivered.length === 1)).toBe(true);
      expect(await env.prisma.chatMessage.count({ where: { room: { orderId: s.order.id } } })).toBe(2); // the retry did not duplicate

      expect(await ask(rid, 'chat:read', { orderId: s.order.id })).toMatchObject({ ok: true, marked: 2 });
      expect(await until(() => readReceipts.length === 1)).toBe(true);
      expect((await env.prisma.chatMessage.findUniqueOrThrow({ where: { id: second.message.id } })).readAt).not.toBeNull();
      const reply = await ask(rid, 'chat:send', { orderId: s.order.id, body: 'On my way', clientMessageId: 'msg-000003' });
      expect(reply.message.senderRole).toBe('RIDER');
    });

    it('enforces length, emptiness and a per-user rate limit', async () => {
      await quiet();
      const s = await scenario();
      const cust = await connect(s.customer.token);
      const send = (body: string, i: number) => ask(cust, 'chat:send', { orderId: s.order.id, body, clientMessageId: `lim-${String(i).padStart(6, '0')}` });
      expect(await send('   ', 1)).toMatchObject({ ok: false, error: { code: 'INVALID_MESSAGE' } });
      expect(await send('\u0001\u0002', 2)).toMatchObject({ ok: false, error: { code: 'INVALID_MESSAGE' } });
      expect(await send('x'.repeat(501), 3)).toMatchObject({ ok: false, error: { code: 'MESSAGE_TOO_LONG' } });
      expect((await send('x'.repeat(500), 4)).ok).toBe(true);
      await setSetting('chat.messagesPerMinute', 3);
      expect((await send('a', 5)).ok).toBe(true);
      expect((await send('b', 6)).ok).toBe(true); // 3rd message this minute
      expect(await send('c', 7)).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
    });

    it('a replaced rider is locked out on their next action and never receives another message; the new rider sees only what follows', async () => {
      await quiet();
      const s = await scenario();
      const [cust, a] = await Promise.all([connect(s.customer.token), connect(s.rider!.token)]);
      await ask(cust, 'chat:join', { orderId: s.order.id });
      await ask(a, 'chat:join', { orderId: s.order.id });
      await ask(cust, 'chat:send', { orderId: s.order.id, body: 'private note for rider A', clientMessageId: 'old-0000001' });

      await c.dispatch.releaseDelivery(s.rider!.id, s.order.id, 'Cannot continue');
      const b = await makeRider();
      await c.dispatch.offerNext(s.order.id);
      await c.riders.accept(b.id, (await env.prisma.deliveryAssignment.findFirstOrThrow({ where: { orderId: s.order.id, status: 'OFFERED' } })).id);

      const aGets = record(a, 'chat:message'); // rider A's socket is still connected and still in the Socket.IO room
      const bSock = await connect(b.token);
      const joined = await ask(bSock, 'chat:join', { orderId: s.order.id });
      expect(joined.messages).toEqual([]); // B does not see A's conversation
      const bGets = record(bSock, 'chat:message');

      await ask(cust, 'chat:send', { orderId: s.order.id, body: 'hello new rider', clientMessageId: 'new-0000001' });
      expect(await until(() => bGets.length === 1)).toBe(true);
      await sleep(200);
      expect(aGets).toHaveLength(0); // evicted before the broadcast
      expect(await ask(a, 'chat:send', { orderId: s.order.id, body: 'still here?', clientMessageId: 'old-0000002' })).toMatchObject({ ok: false, error: { code: 'CHAT_NOT_AVAILABLE' } });
      expect(await ask(a, 'chat:join', { orderId: s.order.id })).toMatchObject({ ok: false, error: { code: 'CHAT_NOT_AVAILABLE' } });
      const custView = await ask(cust, 'chat:join', { orderId: s.order.id });
      expect(custView.messages.map((m: any) => m.body)).toEqual(['private note for rider A', 'hello new rider']); // the customer sees the whole thread
    });

    it('after delivery nobody can write, participants can still read for the retention period, strangers never can, then it is purged', async () => {
      await quiet();
      const s = await scenario();
      const cust = await connect(s.customer.token);
      await ask(cust, 'chat:join', { orderId: s.order.id });
      await ask(cust, 'chat:send', { orderId: s.order.id, body: 'thank you!', clientMessageId: 'fin-0000001' });
      await owners.markReady(s.owner.id, s.restaurant.id, s.order.id);
      for (const to of [OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY, OrderStatus.DELIVERED]) await c.riders.step(s.rider!.id, s.order.id, to);

      expect(await ask(cust, 'chat:send', { orderId: s.order.id, body: 'one more', clientMessageId: 'fin-0000002' })).toMatchObject({ ok: false, error: { code: 'CHAT_CLOSED' } });
      const rid = await connect(s.rider!.token);
      expect(await ask(rid, 'chat:send', { orderId: s.order.id, body: 'one more', clientMessageId: 'fin-0000003' })).toMatchObject({ ok: false, error: { code: 'CHAT_CLOSED' } });
      const history = await ask(cust, 'chat:join', { orderId: s.order.id });
      expect(history).toMatchObject({ ok: true, room: { open: false } });
      expect(history.messages.map((m: any) => m.body)).toEqual(['thank you!']);
      expect((await ask(rid, 'chat:join', { orderId: s.order.id })).ok).toBe(true);
      const stranger = await connect((await user('CUSTOMER')).token);
      expect((await ask(stranger, 'chat:join', { orderId: s.order.id })).error.code).toBe('CHAT_NOT_AVAILABLE');

      await env.prisma.orderChatRoom.update({ where: { orderId: s.order.id }, data: { closedAt: new Date(Date.now() - 40 * 86_400_000) } });
      expect((await ask(cust, 'chat:join', { orderId: s.order.id })).error.code).toBe('CHAT_NOT_AVAILABLE'); // past retention
      expect(await c.chat.purgeExpired()).toBeGreaterThanOrEqual(1);
      expect(await env.prisma.chatMessage.count({ where: { room: { orderId: s.order.id } } })).toBe(0);
    });

    it('REST fallback follows the same rules and still delivers in real time', async () => {
      await quiet();
      const s = await scenario();
      const http = request(server);
      const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
      const rid = await connect(s.rider!.token);
      await ask(rid, 'chat:join', { orderId: s.order.id });
      const live = record(rid, 'chat:message');

      const sent = await http.post(`/api/v1/orders/${s.order.id}/chat/messages`).set(auth(s.customer.token)).send({ body: 'via REST' }).expect(201);
      expect(await until(() => live.length === 1)).toBe(true);
      expect(live[0].body).toBe('via REST');
      const hist = await http.get(`/api/v1/rider/deliveries/${s.order.id}/chat/messages`).set(auth(s.rider!.token)).expect(200);
      expect(hist.body.messages.map((m: any) => m.id)).toEqual([sent.body.id]);
      expect(hist.body.unread).toBe(1);
      await http.post(`/api/v1/rider/deliveries/${s.order.id}/chat/read`).set(auth(s.rider!.token)).expect(200, { marked: 1 });
      await http.post(`/api/v1/rider/deliveries/${s.order.id}/chat/messages`).set(auth(s.rider!.token)).send({ body: 'ok', clientMessageId: 'rest-000001' }).expect(201);
      await http.post(`/api/v1/rider/deliveries/${s.order.id}/chat/messages`).set(auth(s.rider!.token)).send({ body: 'ok', clientMessageId: 'rest-000001' }).expect(200); // retry

      const stranger = await user('CUSTOMER');
      await http.get(`/api/v1/orders/${s.order.id}/chat/messages`).set(auth(stranger.token)).expect(404);
      await http.post(`/api/v1/orders/${s.order.id}/chat/messages`).set(auth(stranger.token)).send({ body: 'hi' }).expect(404);
      await http.get(`/api/v1/orders/${s.order.id}/chat/messages`).set(auth(s.owner.token)).expect(403); // owners have no chat routes at all
      await http.get(`/api/v1/orders/${s.order.id}/chat/messages`).expect(401);
      await http.post(`/api/v1/orders/${s.order.id}/chat/messages`).set(auth(s.customer.token)).send({ body: 'x', extra: 1 }).expect(400);
    });

    it('a participant can report the other party’s message; admins review reports, never browse chats', async () => {
      await quiet();
      const s = await scenario();
      const admin = await user('ADMIN');
      const http = request(server);
      const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
      const msg = (await http.post(`/api/v1/orders/${s.order.id}/chat/messages`).set(auth(s.customer.token)).send({ body: 'rude words' }).expect(201)).body;

      await http.post(`/api/v1/orders/${s.order.id}/chat/messages/${msg.id}/report`).set(auth(s.customer.token)).send({ reason: 'my own message' }).expect(404); // cannot report yourself
      const report = (await http.post(`/api/v1/rider/deliveries/${s.order.id}/chat/messages/${msg.id}/report`).set(auth(s.rider!.token)).send({ reason: 'Abusive language' }).expect(201)).body;
      await http.post(`/api/v1/rider/deliveries/${s.order.id}/chat/messages/${msg.id}/report`).set(auth(s.rider!.token)).send({ reason: 'again' }).expect(409);
      await http.post(`/api/v1/rider/deliveries/${s.order.id}/chat/messages/${msg.id}/report`).set(auth(s.rider!.token)).send({ reason: 'x' }).expect(400);

      await http.get('/api/v1/admin/chat-reports').set(auth(s.customer.token)).expect(403);
      const list = await http.get('/api/v1/admin/chat-reports?status=OPEN').set(auth(admin.token)).expect(200);
      expect(list.body.items.find((r: any) => r.id === report.id)).toMatchObject({ reason: 'Abusive language', message: { body: 'rude words', room: { order: { orderNumber: s.order.orderNumber } } } });
      await http.post(`/api/v1/admin/chat-reports/${report.id}/review`).set(auth(admin.token)).send({ status: 'REVIEWED' }).expect(200);
      expect(await env.prisma.auditLog.count({ where: { actorId: admin.id, action: 'chat.report_reviewed' } })).toBe(1);
      await http.get(`/api/v1/orders/${s.order.id}/chat/messages`).set(auth(admin.token)).expect(403); // no browsing of conversations
    });
  });
});
