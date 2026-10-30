import { randomUUID } from 'crypto';
import request from 'supertest';
import { OrderStatus, PaymentMethod, VehicleType } from '@prisma/client';
import { signAccessToken } from '../src/auth/access-token';
import { createApp } from '../src/http/app';
import { DevPaymentProvider } from '../src/payments/provider';
import { OwnerOrdersService } from '../src/restaurants/owner-orders.service';
import { buildServices, describeIt, factories, onlineEnv, setupDatabase, TestEnv } from './support/integration';

jest.setTimeout(300_000);

const R = { lat: 23.7925, lng: 90.4078 };
const NEAR = { lat: R.lat + 0.0045, lng: R.lng };
const COD = PaymentMethod.CASH_ON_DELIVERY;
const ONLINE = PaymentMethod.ONLINE;
const settle = async (ps: Promise<any>[]) => (await Promise.allSettled(ps)).map((r) => (r.status === 'fulfilled' ? { ok: true as const, value: r.value } : { ok: false as const, code: r.reason?.code }));

describeIt('payments, refunds, earnings, reviews, coupons, support and admin tools (real PostgreSQL)', () => {
  let env: TestEnv;
  let c: ReturnType<typeof buildServices>;
  let f: ReturnType<typeof factories>;
  let dev: DevPaymentProvider;
  let http: ReturnType<typeof request>;
  let owners: OwnerOrdersService;
  let n = 0;

  beforeAll(async () => {
    env = await setupDatabase();
    c = buildServices(env.prisma, onlineEnv);
    f = factories(env.prisma);
    dev = c.payments.provider as DevPaymentProvider;
    http = request(createApp(c, { rateLimit: false }));
    owners = new OwnerOrdersService(env.prisma, c.access, c.transitions);
  });
  afterAll(async () => env.close());
  beforeEach(async () => { await env.prisma.riderProfile.updateMany({ data: { isOnline: false } }); });

  // ───────── helpers ─────────
  const prisma = () => env.prisma;
  const key = () => `money-${Date.now()}-${n++}`;
  const login = async (userId: string) => {
    const sid = randomUUID();
    await prisma().session.create({ data: { id: sid, userId, familyId: randomUUID(), refreshTokenHash: `${sid}-${randomUUID()}`, expiresAt: new Date(Date.now() + 3_600_000) } });
    return { Authorization: `Bearer ${signAccessToken(onlineEnv, { sub: userId, sid })}` };
  };
  const world = async (o: { price?: number; stock?: number | null; minOrder?: number } = {}) => {
    const owner = await f.user('RESTAURANT_OWNER');
    const { restaurant, items } = await f.restaurant(owner.id, { lat: R.lat, lng: R.lng, items: [{ name: 'Burger', price: o.price ?? 30000, stock: o.stock ?? null }] });
    return { owner, restaurant, item: items[0] };
  };
  const shopper = async (w: { item: { id: string } }, o: { couponCode?: string; qty?: number } = {}) => {
    const customer = await f.user('CUSTOMER', { name: 'Nusrat Jahan' });
    const address = await f.address(customer.id, 23.7937, 90.4066);
    await c.carts.addItem(customer.id, { menuItemId: w.item.id, quantity: o.qty ?? 1 });
    if (o.couponCode) await c.carts.setCoupon(customer.id, o.couponCode);
    return { customer, address };
  };
  const place = async (s: { customer: { id: string }; address: { id: string } }, method: PaymentMethod = COD) => (await c.orders.placeOrder(s.customer.id, { addressId: s.address.id, paymentMethod: method }, key())).order;
  const refOf = async (orderId: string) => (await prisma().payment.findFirstOrThrow({ where: { orderId, method: ONLINE } })).providerRef!;
  const webhook = (ref: string, o: { eventId?: string; secret?: string; tamper?: boolean; noSig?: boolean } = {}) => {
    const body = JSON.stringify({ eventId: o.eventId ?? randomUUID(), providerRef: ref });
    const sig = o.secret ? new DevPaymentProvider(o.secret, '').sign(body) : dev.sign(body);
    const req = http.post('/api/v1/payments/webhook').set('Content-Type', 'application/json');
    if (!o.noSig) req.set('x-ff-signature', sig);
    return req.send(o.tamper ? body.replace(ref, ref + 'x') : body);
  };
  const paid = async (orderId: string) => { const ref = await refOf(orderId); dev.complete(ref, 'PAID'); return webhook(ref); };
  const status = async (id: string) => (await prisma().order.findUniqueOrThrow({ where: { id } })).status;
  const stock = async (itemId: string) => (await prisma().menuItem.findUniqueOrThrow({ where: { id: itemId } })).stockQuantity;
  const payment = (orderId: string) => prisma().payment.findFirstOrThrow({ where: { orderId } });
  const makeRider = async () => {
    const u = await f.user('RIDER');
    await prisma().riderProfile.update({ where: { userId: u.id }, data: { approvalStatus: 'APPROVED', vehicleType: VehicleType.MOTORCYCLE, isOnline: true, lastLat: NEAR.lat, lastLng: NEAR.lng, lastLocationAt: new Date() } });
    return u;
  };
  /** Drives an already-PLACED order to DELIVERED. */
  const deliver = async (w: { owner: { id: string }; restaurant: { id: string } }, orderId: string) => {
    await owners.accept(w.owner.id, w.restaurant.id, orderId, {});
    await owners.startPreparing(w.owner.id, w.restaurant.id, orderId);
    await owners.markReady(w.owner.id, w.restaurant.id, orderId);
    await prisma().riderProfile.updateMany({ data: { isOnline: false } }); // exactly one rider is eligible: the new one
    const rider = await makeRider();
    await c.dispatch.offerNext(orderId);
    const offer = await prisma().deliveryAssignment.findFirstOrThrow({ where: { orderId, status: 'OFFERED' } });
    expect(offer.riderId).toBe(rider.id);
    await c.riders.accept(rider.id, offer.id);
    for (const to of [OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY, OrderStatus.DELIVERED]) await c.riders.step(rider.id, orderId, to);
    return rider;
  };

  // ───────────────────────── online payment ─────────────────────────
  describe('online payment', () => {
    it('is offered only when a gateway exists; the order is invisible to the restaurant until the gateway confirms payment', async () => {
      const w = await world({ stock: 5 });
      const s = await shopper(w);
      const quote = await http.post('/api/v1/checkout/quote').set(await login(s.customer.id)).send({ addressId: s.address.id }).expect(200);
      expect(quote.body.paymentMethods).toEqual(['CASH_ON_DELIVERY', 'ONLINE']);

      const order = await place(s, ONLINE);
      expect(order.status).toBe('PENDING_PAYMENT');
      expect((order as any).payment.redirectUrl).toMatch(/\/api\/v1\/dev\/payments\/ffpay_/);
      expect(await stock(w.item.id)).toBe(4); // reserved while the customer pays
      expect(await prisma().notification.count({ where: { userId: w.owner.id } })).toBe(0);
      expect((await c.ownerOrders.list(w.owner.id, w.restaurant.id, {})).total).toBe(0);
      const pay = await payment(order.id);
      expect(pay).toMatchObject({ status: 'PENDING', method: ONLINE, provider: 'dev', amountMinor: order.totals.totalMinor });
      expect(pay.providerRef).toMatch(/^ffpay_[\w-]{20,}$/); // opaque, unguessable reference

      const res = await paid(order.id);
      expect(res.body).toMatchObject({ processed: true, duplicate: false });
      expect(await status(order.id)).toBe('PLACED');
      expect(await payment(order.id)).toMatchObject({ status: 'SUCCESSFUL', paidAt: expect.any(Date) });
      expect((await prisma().notification.findMany({ where: { userId: w.owner.id } })).map((x) => x.title)).toEqual(['New order']);
      expect((await prisma().notification.findMany({ where: { userId: s.customer.id } })).map((x) => x.title)).toEqual(expect.arrayContaining(['Payment received']));
      expect((await c.ownerOrders.list(w.owner.id, w.restaurant.id, {})).total).toBe(1);
    });

    it('nothing the client does can mark an order paid: only an authenticated callback that the gateway then confirms', async () => {
      const w = await world();
      const s = await shopper(w);
      const order = await place(s, ONLINE);
      const ref = await refOf(order.id);
      await webhook(ref, { noSig: true }).expect(401);
      await webhook(ref, { secret: 'attacker-secret-attacker-secret-1234567' }).expect(401);
      await webhook(ref, { tamper: true }).expect(401);
      // a correctly signed callback while the gateway still says "pending" changes nothing
      await webhook(ref).expect(200);
      expect(await status(order.id)).toBe('PENDING_PAYMENT');
      // a signed callback for an unknown reference is acknowledged and ignored
      await webhook('ffpay_doesnotexist').expect(200);
      expect(await status(order.id)).toBe('PENDING_PAYMENT');
      expect(await prisma().auditLog.count({ where: { action: 'payment.webhook_rejected' } })).toBeGreaterThanOrEqual(3);
      await http.get(`/api/v1/orders/${order.id}`).set(await login(s.customer.id)).expect(200).then((r) => expect(r.body.status).toBe('PENDING_PAYMENT'));
    });

    it('duplicate and simultaneous callbacks place the order exactly once', async () => {
      const w = await world();
      const s = await shopper(w);
      const order = await place(s, ONLINE);
      const ref = await refOf(order.id);
      dev.complete(ref, 'PAID');
      const same = randomUUID();
      expect((await webhook(ref, { eventId: same }).expect(200)).body.duplicate).toBe(false);
      expect((await webhook(ref, { eventId: same }).expect(200)).body.duplicate).toBe(true);

      const w2 = await world();
      const s2 = await shopper(w2);
      const o2 = await place(s2, ONLINE);
      const ref2 = await refOf(o2.id);
      dev.complete(ref2, 'PAID');
      const results = await Promise.all(Array.from({ length: 6 }, () => webhook(ref2)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(await prisma().payment.count({ where: { orderId: o2.id, status: 'SUCCESSFUL' } })).toBe(1);
      expect(await prisma().orderStatusHistory.count({ where: { orderId: o2.id, toStatus: 'PLACED' } })).toBe(1);
      expect(await prisma().notification.count({ where: { userId: w2.owner.id, title: 'New order' } })).toBe(1);
    });

    it('a wrong amount is refused and flagged; a decline releases stock and the coupon', async () => {
      const code = `PAYF${Date.now() % 100000}`;
      await f.coupon({ code, usageLimitTotal: 1 });
      const w = await world({ stock: 3 });
      const s = await shopper(w, { couponCode: code });
      const o = await place(s, ONLINE);
      expect(o.totals.discountMinor).toBe(5000);
      expect(await prisma().couponRedemption.count({ where: { orderId: o.id } })).toBe(1);
      const ref = await refOf(o.id);
      dev.complete(ref, 'FAILED');
      await webhook(ref).expect(200);
      expect(await status(o.id)).toBe('PAYMENT_FAILED');
      expect(await payment(o.id)).toMatchObject({ status: 'FAILED' });
      expect(await stock(w.item.id)).toBe(3);
      expect(await prisma().couponRedemption.count({ where: { orderId: o.id } })).toBe(0);
      expect((await prisma().notification.findMany({ where: { userId: s.customer.id } })).some((x) => x.title === 'Payment failed')).toBe(true);

      const w2 = await world({ stock: 3 });
      const s2 = await shopper(w2);
      const o2 = await place(s2, ONLINE);
      const ref2 = await refOf(o2.id);
      dev.complete(ref2, 'PAID', o2.totals.totalMinor - 1000); // the gateway reports less money than we asked for
      await webhook(ref2).expect(200);
      expect(await status(o2.id)).toBe('PAYMENT_FAILED');
      expect((await payment(o2.id)).failureReason).toMatch(/AMOUNT_MISMATCH/);
      expect(await stock(w2.item.id)).toBe(3);
      expect(await prisma().auditLog.count({ where: { action: 'payment.amount_mismatch', entityId: (await payment(o2.id)).id } })).toBe(1);
    });

    it('recovers a lost callback by asking the gateway, and cancels payments that never complete', async () => {
      const w = await world({ stock: 4 });
      const s = await shopper(w);
      const lost = await place(s, ONLINE);
      dev.complete(await refOf(lost.id), 'PAID'); // the customer paid, but the callback never arrived
      expect(await status(lost.id)).toBe('PENDING_PAYMENT');
      await c.payments.reconcilePending(new Date(Date.now() + 120_000));
      expect(await status(lost.id)).toBe('PLACED');

      const s2 = await shopper(w);
      const abandoned = await place(s2, ONLINE);
      expect(await stock(w.item.id)).toBe(2);
      await c.payments.reconcilePending(new Date(Date.now() + 10 * 60_000)); // still inside the 30-minute window
      expect(await status(abandoned.id)).toBe('PENDING_PAYMENT');
      await c.payments.reconcilePending(new Date(Date.now() + 40 * 60_000));
      expect(await status(abandoned.id)).toBe('CANCELLED');
      expect(await payment(abandoned.id)).toMatchObject({ status: 'CANCELLED' });
      expect(await stock(w.item.id)).toBe(3);
    });

    it('money that arrives after the order was cancelled is refunded automatically', async () => {
      const w = await world();
      const s = await shopper(w);
      const o = await place(s, ONLINE);
      await c.orders.cancel(s.customer.id, o.id, {}); // the customer gave up while paying
      expect(await status(o.id)).toBe('CANCELLED');
      await paid(o.id).then((r) => expect(r.status).toBe(200));
      expect(await payment(o.id)).toMatchObject({ status: 'SUCCESSFUL' });
      const refund = await prisma().refund.findFirstOrThrow({ where: { orderId: o.id } });
      expect(refund).toMatchObject({ status: 'APPROVED', amountMinor: o.totals.totalMinor });
      await c.refunds.processPending();
      expect(await prisma().refund.findUniqueOrThrow({ where: { id: refund.id } })).toMatchObject({ status: 'PROCESSED', providerRef: expect.stringMatching(/^ffref_/) });
      expect(await payment(o.id)).toMatchObject({ status: 'REFUNDED' });
      expect((await prisma().notification.findMany({ where: { userId: s.customer.id } })).some((x) => x.title === 'Refund issued')).toBe(true);
    });
  });

  // ───────────────────────── refunds ─────────────────────────
  describe('refunds', () => {
    it('a paid order the restaurant rejects is refunded in full, once, even if payout is triggered concurrently', async () => {
      const w = await world();
      const s = await shopper(w);
      const o = await place(s, ONLINE);
      await paid(o.id);
      await owners.reject(w.owner.id, w.restaurant.id, o.id, 'Out of stock');
      const refund = await prisma().refund.findFirstOrThrow({ where: { orderId: o.id } });
      expect(refund).toMatchObject({ status: 'APPROVED', amountMinor: o.totals.totalMinor, requestedById: null });
      const res = await settle(Array.from({ length: 5 }, () => c.refunds.process(refund.id)));
      expect(res.every((r) => r.ok)).toBe(true);
      expect(await prisma().refund.count({ where: { orderId: o.id, status: 'PROCESSED' } })).toBe(1);
      expect(await prisma().refund.count({ where: { orderId: o.id } })).toBe(1);
      expect(await payment(o.id)).toMatchObject({ status: 'REFUNDED' });
      expect(await prisma().notification.count({ where: { userId: s.customer.id, title: 'Refund issued' } })).toBe(1);
    });

    it('a cash order that is cancelled needs no refund', async () => {
      const w = await world();
      const s = await shopper(w);
      const o = await place(s, COD);
      await c.orders.cancel(s.customer.id, o.id, {});
      expect(await prisma().refund.count({ where: { orderId: o.id } })).toBe(0);
      expect(await payment(o.id)).toMatchObject({ status: 'CANCELLED' });
    });

    it('customer requests after delivery are reviewed by an admin; partial refunds add up and can never exceed what was paid', async () => {
      const admin = await f.user('ADMIN');
      const w = await world({ price: 50000 });
      const s = await shopper(w);
      const o = await place(s, ONLINE);
      await paid(o.id);
      const total = o.totals.totalMinor;
      await expect(c.refunds.request(s.customer.id, o.id, { reason: 'Missing item' })).rejects.toMatchObject({ code: 'NOT_REFUNDABLE' }); // not delivered yet
      await deliver(w, o.id);

      const stranger = await f.user('CUSTOMER');
      await expect(c.refunds.request(stranger.id, o.id, { reason: 'x'.repeat(5) })).rejects.toMatchObject({ status: 404 });
      await expect(c.refunds.request(s.customer.id, o.id, { amountMinor: total + 1, reason: 'Too much' })).rejects.toMatchObject({ code: 'INVALID_REFUND_AMOUNT' });
      const first = await c.refunds.request(s.customer.id, o.id, { amountMinor: 20000, reason: 'Missing drink' });
      await expect(c.refunds.request(s.customer.id, o.id, { reason: 'again' })).rejects.toMatchObject({ code: 'REFUND_ALREADY_REQUESTED' });

      await expect(c.refunds.review(admin.id, first.id, { approve: false })).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
      const done = await c.refunds.review(admin.id, first.id, { approve: true, amountMinor: 15000, note: 'Approved a smaller amount' });
      expect(done).toMatchObject({ status: 'PROCESSED', amountMinor: 15000 });
      expect(await payment(o.id)).toMatchObject({ status: 'SUCCESSFUL' }); // partial: still counts as paid
      await expect(c.refunds.review(admin.id, first.id, { approve: true })).rejects.toMatchObject({ code: 'INVALID_REFUND_TRANSITION' }); // final

      const second = await c.refunds.request(s.customer.id, o.id, { reason: 'The rest, please' });
      expect(second.amountMinor).toBe(total - 15000);
      await c.refunds.review(admin.id, second.id, { approve: true });
      expect(await payment(o.id)).toMatchObject({ status: 'REFUNDED' });
      await expect(c.refunds.request(s.customer.id, o.id, { reason: 'more?' })).rejects.toMatchObject({ code: 'ALREADY_REFUNDED' });
      const declined = await prisma().refund.findFirstOrThrow({ where: { orderId: o.id }, orderBy: { requestedAt: 'asc' } });
      void declined;
      expect(await prisma().auditLog.count({ where: { actorId: admin.id, action: 'refund.approve' } })).toBe(2);
    });

    it('refunds for cash orders are recorded by an admin; a rejected request tells the customer why; the window closes', async () => {
      const admin = await f.user('ADMIN');
      const w = await world();
      const s = await shopper(w);
      const o = await place(s, COD);
      await deliver(w, o.id);
      expect(await payment(o.id)).toMatchObject({ status: 'SUCCESSFUL', method: COD }); // cash collected at the door

      const req = await c.refunds.request(s.customer.id, o.id, { reason: 'Cold food' });
      const approved = await c.refunds.review(admin.id, req.id, { approve: true });
      expect(approved.status).toBe('APPROVED'); // cash: nothing to send through a gateway
      await expect(c.refunds.markProcessed(admin.id, req.id, 'bKash TRX 99887766')).resolves.toMatchObject({ status: 'PROCESSED' });
      const online = await prisma().refund.findFirst({ where: { payment: { method: ONLINE } } });
      if (online) await expect(c.refunds.markProcessed(admin.id, online.id, 'x-ref')).rejects.toMatchObject({ code: 'GATEWAY_REFUND' });

      const w2 = await world();
      const s2 = await shopper(w2);
      const o2 = await place(s2, COD);
      await deliver(w2, o2.id);
      const r2 = await c.refunds.request(s2.customer.id, o2.id, { reason: 'Not happy' });
      await c.refunds.review(admin.id, r2.id, { approve: false, note: 'The photo shows the order was complete' });
      expect((await prisma().notification.findMany({ where: { userId: s2.customer.id } })).some((x) => x.title === 'Refund declined' && x.body.includes('complete'))).toBe(true);

      await prisma().order.update({ where: { id: o2.id }, data: { deliveredAt: new Date(Date.now() - 10 * 86_400_000) } });
      await expect(c.refunds.request(s2.customer.id, o2.id, { reason: 'late' })).rejects.toMatchObject({ code: 'REFUND_WINDOW_CLOSED' });
    });
  });

  // ───────────────────────── earnings, payouts, reconciliation ─────────────────────────
  describe('earnings, payouts and reconciliation', () => {
    it('delivery creates the earnings atomically: commission on food, rider share of the delivery fee, cash the rider owes; coupons are funded by who offered them', async () => {
      const w = await world({ price: 30000 });
      const s = await shopper(w);
      const o = await place(s, COD);
      const rider = await deliver(w, o.id);
      const re = await prisma().restaurantEarning.findUniqueOrThrow({ where: { orderId: o.id } });
      expect(re).toMatchObject({ grossMinor: 30000, commissionMinor: 4500, netMinor: 25500, payoutId: null });
      expect(await prisma().riderEarning.findUniqueOrThrow({ where: { orderId: o.id } })).toMatchObject({ riderId: rider.id, amountMinor: 4000, cashCollectedMinor: 36000 });

      // restaurant-funded coupon: comes out of the restaurant's net. Platform coupon: does not.
      const own = `OWN${Date.now() % 100000}`;
      const platform = `PLT${Date.now() % 100000}`;
      await c.coupons.create({ id: w.owner.id, role: 'OWNER' }, { restaurantId: w.restaurant.id }, { code: own, type: 'FIXED_AMOUNT', value: 5000, startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86_400_000), usageLimitTotal: 10 });
      await f.coupon({ code: platform, value: 5000 });
      const sOwn = await shopper(w, { couponCode: own });
      const oOwn = await place(sOwn, COD);
      await deliver(w, oOwn.id);
      expect((await prisma().restaurantEarning.findUniqueOrThrow({ where: { orderId: oOwn.id } })).netMinor).toBe(20500); // 30000 − 4500 − 5000
      const sPlt = await shopper(w, { couponCode: platform });
      const oPlt = await place(sPlt, COD);
      await deliver(w, oPlt.id);
      expect((await prisma().restaurantEarning.findUniqueOrThrow({ where: { orderId: oPlt.id } })).netMinor).toBe(25500);

      // owner-created coupon is valid only at its own restaurant
      const other = await world();
      const sOther = await shopper(other, { couponCode: own });
      expect((await c.checkout.compute(prisma(), sOther.customer.id, { addressId: sOther.address.id })).issues.map((i) => i.code)).toContain('COUPON_WRONG_RESTAURANT');
    });

    it('payouts bundle unpaid earnings per payee; a rider who collected more cash than they earned owes the platform; paying twice is refused', async () => {
      const admin = await f.user('ADMIN');
      const w = await world();
      const o = await place(await shopper(w), COD);
      const rider = await deliver(w, o.id);
      const o2 = await place(await shopper(w), COD);
      await deliver(w, o2.id).then(async (r2) => { void r2; });

      const ownerView = await c.payouts.restaurantEarnings(w.restaurant.id, {});
      expect(ownerView).toMatchObject({ total: 2, unpaidNetMinor: 51000, includedInPayoutsMinor: 0 });
      const riderView = await c.payouts.riderEarnings(rider.id, {});
      expect(riderView).toMatchObject({ total: 1, unpaidEarningsMinor: 4000, cashToRemitMinor: 36000, netUnpaidMinor: -32000 });

      await expect(c.payouts.generate(admin.id, new Date(Date.now() - 3_600_000), new Date(Date.now() + 3_600_000))).rejects.toMatchObject({ code: 'INVALID_PERIOD' }); // must end in the past
      const gen = await c.payouts.generate(admin.id, new Date(Date.now() - 3_600_000), new Date());
      const mine = gen.payouts.find((p) => p.payeeId === w.owner.id)!;
      expect(mine).toMatchObject({ payeeRole: 'RESTAURANT_OWNER', amountMinor: 51000 });
      expect(gen.payouts.find((p) => p.payeeId === rider.id)).toMatchObject({ payeeRole: 'RIDER', amountMinor: -32000 }); // the rider owes the platform
      expect((await c.payouts.restaurantEarnings(w.restaurant.id, {})).includedInPayoutsMinor).toBe(51000);
      expect(await prisma().restaurantEarning.count({ where: { restaurantId: w.restaurant.id, payoutId: null } })).toBe(0);

      const again = await c.payouts.generate(admin.id, new Date(Date.now() - 3_600_000), new Date());
      expect(again.payouts.find((p) => p.payeeId === w.owner.id)).toBeUndefined(); // already bundled: nothing is paid twice
      const paidRow = await c.payouts.markPaid(admin.id, mine.id, 'Bank transfer #7781');
      expect(paidRow).toMatchObject({ status: 'PAID', reference: 'Bank transfer #7781' });
      await expect(c.payouts.markPaid(admin.id, mine.id, 'again')).rejects.toMatchObject({ code: 'ALREADY_PAID' });
      expect((await c.payouts.payoutsFor(w.owner.id))[0]).toMatchObject({ amountMinor: 51000, status: 'PAID' });
    });

    it('reconciliation agrees on a healthy ledger and pinpoints broken ones', async () => {
      const start = new Date();
      const w = await world();
      const o = await place(await shopper(w), COD);
      await deliver(w, o.id);
      const w2 = await world();
      const online = await place(await shopper(w2), ONLINE);
      await paid(online.id);
      await owners.reject(w2.owner.id, w2.restaurant.id, online.id, 'Closed early');
      await c.refunds.processPending();

      const to = new Date(Date.now() + 60_000);
      const healthy = await c.payouts.reconcile(start, to);
      expect(healthy).toMatchObject({ ok: true, issues: [], summary: { deliveredOrders: 1, gmvMinor: 36000, foodMinor: 30000, deliveryFeesMinor: 5000, serviceFeesMinor: 1000, commissionMinor: 4500, riderEarningsMinor: 4000 } });
      expect(healthy.summary.platformNetMinor).toBe(4500 + 1000 + (5000 - 4000)); // commission + service fee + the delivery-fee margin

      await prisma().restaurantEarning.delete({ where: { orderId: o.id } }); // simulate lost bookkeeping
      await prisma().payment.updateMany({ where: { orderId: online.id }, data: { amountMinor: 1 } });
      const broken = await c.payouts.reconcile(start, to);
      expect(broken.ok).toBe(false);
      expect(broken.issues.map((i) => i.issue).sort()).toEqual(expect.arrayContaining(['DELIVERED_WITHOUT_EARNING', 'PAYMENT_AMOUNT_MISMATCH']));
      expect(broken.issues.find((i) => i.issue === 'DELIVERED_WITHOUT_EARNING')!.orderNumber).toBe(o.orderNumber);
    });
  });

  // ───────────────────────── reviews ─────────────────────────
  describe('reviews', () => {
    it('only the customer of a delivered order, once, within the window; ratings aggregate for the restaurant and the rider', async () => {
      const w = await world();
      const s = await shopper(w);
      const o = await place(s, COD);
      await expect(c.reviews.create(s.customer.id, o.id, { restaurantRating: 5 })).rejects.toMatchObject({ code: 'NOT_REVIEWABLE' });
      const rider = await deliver(w, o.id);
      const stranger = await f.user('CUSTOMER');
      await expect(c.reviews.create(stranger.id, o.id, { restaurantRating: 1 })).rejects.toMatchObject({ status: 404 });

      const rv = await c.reviews.create(s.customer.id, o.id, { restaurantRating: 4, riderRating: 5, comment: 'Hot and fast' });
      expect(rv).toMatchObject({ restaurantRating: 4, riderRating: 5 });
      await expect(c.reviews.create(s.customer.id, o.id, { restaurantRating: 1 })).rejects.toMatchObject({ code: 'ALREADY_REVIEWED' });
      expect(await prisma().restaurant.findUniqueOrThrow({ where: { id: w.restaurant.id } })).toMatchObject({ ratingAvg: 4, ratingCount: 1 });
      expect(await prisma().riderProfile.findUniqueOrThrow({ where: { userId: rider.id } })).toMatchObject({ ratingAvg: 5, ratingCount: 1 });

      const o2 = await place(await shopper(w), COD);
      const s2 = (await prisma().order.findUniqueOrThrow({ where: { id: o2.id } })).customerId;
      await deliver(w, o2.id);
      await c.reviews.create(s2, o2.id, { restaurantRating: 2 });
      expect(await prisma().restaurant.findUniqueOrThrow({ where: { id: w.restaurant.id } })).toMatchObject({ ratingAvg: 3, ratingCount: 2 });

      await prisma().order.update({ where: { id: o2.id }, data: { deliveredAt: new Date(Date.now() - 20 * 86_400_000) } });
      const o3 = await place(await shopper(w), COD);
      const c3 = (await prisma().order.findUniqueOrThrow({ where: { id: o3.id } })).customerId;
      await deliver(w, o3.id);
      await prisma().order.update({ where: { id: o3.id }, data: { deliveredAt: new Date(Date.now() - 20 * 86_400_000) } });
      await expect(c.reviews.create(c3, o3.id, { restaurantRating: 5 })).rejects.toMatchObject({ code: 'REVIEW_WINDOW_CLOSED' });

      const list = await c.reviews.forRestaurant(w.restaurant.id, {}, { requireApproved: true });
      expect(list.rating).toEqual({ average: 3, count: 2 });
      expect(list.items.map((i) => i.reviewer)).toEqual(['Nusrat J.', 'Nusrat J.']); // never a full name
      await expect(c.reviews.forRestaurant((await f.restaurant((await f.user('RESTAURANT_OWNER')).id, { approval: 'PENDING' })).restaurant.id, {}, { requireApproved: true })).rejects.toMatchObject({ status: 404 });
    });

    it('simultaneous reviews never lose an update', async () => {
      const w = await world();
      const reviewers: { id: string; order: string }[] = [];
      for (let i = 0; i < 5; i++) {
        const s = await shopper(w);
        const o = await place(s, COD);
        await deliver(w, o.id);
        reviewers.push({ id: s.customer.id, order: o.id });
      }
      const res = await settle(reviewers.map((r, i) => c.reviews.create(r.id, r.order, { restaurantRating: [5, 4, 3, 2, 1][i] })));
      expect(res.every((r) => r.ok)).toBe(true);
      const r = await prisma().restaurant.findUniqueOrThrow({ where: { id: w.restaurant.id } });
      expect(r.ratingCount).toBe(5);
      expect(r.ratingAvg).toBeCloseTo(3, 9);
    });
  });

  // ───────────────────────── coupons ─────────────────────────
  describe('coupons', () => {
    const owner = (id: string) => ({ id, role: 'OWNER' as const });
    const def = (code: string, o: object = {}) => ({ code, type: 'PERCENTAGE' as const, value: 20, maxDiscountMinor: 5000, startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86_400_000), usageLimitTotal: 5, ...o });

    it('owners manage only their own restaurant’s coupons; used coupons are frozen; admins manage platform coupons', async () => {
      const w = await world();
      const other = await world();
      const code = `OC${Date.now() % 1000000}`;
      const created = await c.coupons.create(owner(w.owner.id), { restaurantId: w.restaurant.id }, def(code));
      expect(created).toMatchObject({ code, restaurantId: w.restaurant.id });
      await expect(c.coupons.create(owner(w.owner.id), { restaurantId: w.restaurant.id }, def(code))).rejects.toMatchObject({ code: 'COUPON_CODE_TAKEN' });
      await expect(c.coupons.create(owner(w.owner.id), { restaurantId: w.restaurant.id }, def(`${code}X`, { value: 75 }))).rejects.toMatchObject({ code: 'INVALID_COUPON' });
      await expect(c.coupons.update(owner(other.owner.id), { restaurantId: other.restaurant.id }, created.id, { isActive: false })).rejects.toMatchObject({ status: 404 }); // not theirs
      expect((await c.coupons.list({ restaurantId: other.restaurant.id }, {})).items.map((x) => x.id)).not.toContain(created.id);

      const s = await shopper(w, { couponCode: code });
      await place(s, COD);
      await expect(c.coupons.update(owner(w.owner.id), { restaurantId: w.restaurant.id }, created.id, { value: 90 })).rejects.toMatchObject({ code: 'COUPON_IN_USE' });
      await expect(c.coupons.update(owner(w.owner.id), { restaurantId: w.restaurant.id }, created.id, { usageLimitTotal: 0 as any })).rejects.toBeDefined();
      expect(await c.coupons.update(owner(w.owner.id), { restaurantId: w.restaurant.id }, created.id, { isActive: false })).toMatchObject({ isActive: false });
      expect((await c.coupons.list({ restaurantId: w.restaurant.id }, {})).items[0]).toMatchObject({ redemptions: 1 });

      const admin = await f.user('ADMIN');
      const platform = await c.coupons.create({ id: admin.id, role: 'ADMIN' }, {}, def(`PF${Date.now() % 1000000}`, { value: 60, maxDiscountMinor: null, usageLimitTotal: null }));
      expect(platform.restaurantId).toBeNull();
    });
  });

  // ───────────────────────── support ─────────────────────────
  describe('support & disputes', () => {
    it('anyone can raise a ticket about an order they are part of; internal notes stay internal; resolution needs an explanation', async () => {
      const w = await world();
      const s = await shopper(w);
      const o = await place(s, COD);
      const rider = await deliver(w, o.id);
      const admin = await f.user('ADMIN');
      const stranger = await f.user('CUSTOMER');

      await expect(c.support.create(stranger, { category: 'MISSING_ITEM', subject: 'Missing fries', description: 'There were no fries in the bag', orderId: o.id })).rejects.toMatchObject({ status: 404 });
      const t = await c.support.create({ id: s.customer.id, role: 'CUSTOMER' }, { category: 'MISSING_ITEM', subject: 'Missing fries', description: 'There were no fries in the bag', orderId: o.id });
      const rt = await c.support.create({ id: rider.id, role: 'RIDER' }, { category: 'DELIVERY_COMPLAINT', subject: 'Customer unreachable', description: 'Phone was off the whole time', orderId: o.id });
      const ot = await c.support.create({ id: w.owner.id, role: 'RESTAURANT_OWNER' }, { category: 'DISPUTE', subject: 'Chargeback', description: 'Customer disputed the payment', orderId: o.id });
      expect([t.status, rt.status, ot.status]).toEqual(['OPEN', 'OPEN', 'OPEN']);

      await c.support.adminReply(admin.id, t.id, { body: 'Checking with the restaurant (note to team)', isInternal: true });
      expect((await c.support.getMine(s.customer.id, t.id)).messages).toHaveLength(0); // internal notes are never shown
      expect(await prisma().notification.count({ where: { userId: s.customer.id, title: 'Support replied' } })).toBe(0);
      await c.support.adminReply(admin.id, t.id, { body: 'Sorry about that: we are looking into it.' });
      const view = await c.support.getMine(s.customer.id, t.id);
      expect(view).toMatchObject({ status: 'AWAITING_CUSTOMER', messages: [{ fromSupport: true, body: expect.stringContaining('Sorry') }] });
      expect(await prisma().notification.count({ where: { userId: s.customer.id, title: 'Support replied' } })).toBe(1);

      await expect(c.support.getMine(stranger.id, t.id)).rejects.toMatchObject({ status: 404 });
      await expect(c.support.reply(stranger.id, t.id, 'hi')).rejects.toMatchObject({ status: 404 });
      await c.support.reply(s.customer.id, t.id, 'Thank you!');
      expect((await c.support.getMine(s.customer.id, t.id)).status).toBe('IN_PROGRESS');

      await expect(c.support.assign(admin.id, t.id, w.owner.id)).rejects.toMatchObject({ code: 'INVALID_ASSIGNEE' });
      await c.support.assign(admin.id, t.id, admin.id);
      await expect(c.support.setStatus(admin.id, t.id, 'RESOLVED')).rejects.toMatchObject({ code: 'RESOLUTION_REQUIRED' });
      await c.support.setStatus(admin.id, t.id, 'RESOLVED', 'Refunded the fries');
      expect((await prisma().notification.findMany({ where: { userId: s.customer.id, title: 'Issue resolved' } }))[0].body).toContain('Refunded the fries');
      expect((await c.support.adminList({ open: true, unassigned: true })).items.map((x) => x.id)).toEqual(expect.arrayContaining([rt.id, ot.id]));
      expect(await c.support.close(s.customer.id, t.id)).toMatchObject({ status: 'CLOSED' });
      await expect(c.support.reply(s.customer.id, t.id, 'more')).rejects.toMatchObject({ code: 'TICKET_CLOSED' });
    });

    it('ticket creation is rate-limited', async () => {
      const u = await f.user('CUSTOMER');
      for (let i = 0; i < 5; i++) await c.support.create({ id: u.id, role: 'CUSTOMER' }, { category: 'OTHER', subject: `Question ${i}`, description: 'A general question about the app' });
      await expect(c.support.create({ id: u.id, role: 'CUSTOMER' }, { category: 'OTHER', subject: 'Question 6', description: 'A general question about the app' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    });
  });

  // ───────────────────────── admin tools ─────────────────────────
  describe('admin tools', () => {
    it('suspending a user ends their sessions; admins and yourself are protected; every action is audited', async () => {
      const admin = await f.user('ADMIN');
      const other = await f.user('ADMIN');
      const victim = await f.user('RIDER');
      await prisma().riderProfile.update({ where: { userId: victim.id }, data: { approvalStatus: 'APPROVED', isOnline: true, lastLat: 1, lastLng: 1, lastLocationAt: new Date() } });
      const headers = await login(victim.id);
      await http.get('/api/v1/users/me').set(headers).expect(200);

      await expect(c.adminPlatform.setUserStatus(admin.id, victim.id, 'SUSPENDED', undefined)).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
      await expect(c.adminPlatform.setUserStatus(admin.id, admin.id, 'SUSPENDED', 'oops')).rejects.toMatchObject({ status: 403 });
      await expect(c.adminPlatform.setUserStatus(admin.id, other.id, 'SUSPENDED', 'no')).rejects.toMatchObject({ status: 403 });
      await c.adminPlatform.setUserStatus(admin.id, victim.id, 'SUSPENDED', 'Fraud report');
      await http.get('/api/v1/users/me').set(headers).expect(401); // the session died immediately
      expect(await prisma().riderProfile.findUniqueOrThrow({ where: { userId: victim.id } })).toMatchObject({ isOnline: false, lastLat: null });
      await c.adminPlatform.setUserStatus(admin.id, victim.id, 'ACTIVE', undefined);
      const logs = await c.adminPlatform.auditLogs({ actorId: admin.id, action: 'user.' });
      expect(logs.items.map((l) => l.action)).toEqual(expect.arrayContaining(['user.suspend', 'user.reactivate']));
      expect((await c.adminPlatform.listUsers({ q: victim.email })).items[0]).toMatchObject({ id: victim.id, status: 'ACTIVE' });
    });

    it('platform settings are validated, take effect, and are audited with before/after', async () => {
      const admin = await f.user('ADMIN');
      await expect(c.adminPlatform.setSetting(admin.id, 'commission.defaultBps', 99_999)).rejects.toMatchObject({ code: 'INVALID_SETTING' });
      await expect(c.adminPlatform.setSetting(admin.id, 'commission.defaultBps', '12')).rejects.toMatchObject({ code: 'INVALID_SETTING' });
      await expect(c.adminPlatform.setSetting(admin.id, 'no.such.setting', 1)).rejects.toMatchObject({ code: 'UNKNOWN_SETTING' });
      await c.adminPlatform.setSetting(admin.id, 'fees.serviceFeeMinor', 2500);
      expect((await c.settings.get())['fees.serviceFeeMinor']).toBe(2500);
      const w = await world();
      const s = await shopper(w);
      expect((await c.checkout.compute(prisma(), s.customer.id, { addressId: s.address.id })).totals.serviceFeeMinor).toBe(2500); // the next quote uses it
      expect((await c.adminPlatform.getSettings()).find((x) => x.key === 'fees.serviceFeeMinor')).toMatchObject({ value: 2500, default: 1000, customised: true });
      const log = (await c.adminPlatform.auditLogs({ action: 'settings.update', entityId: 'fees.serviceFeeMinor' })).items[0];
      expect(log.metadata).toMatchObject({ before: 1000, after: 2500 });
      await c.adminPlatform.setSetting(admin.id, 'fees.serviceFeeMinor', 1000);
    });

    it('service areas restrict where anything can be delivered; bad shapes are refused; deactivating lifts the restriction', async () => {
      const admin = await f.user('ADMIN');
      await expect(c.adminPlatform.createServiceArea(admin.id, { name: 'Bad', polygon: [[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]] })).rejects.toMatchObject({ code: 'INVALID_POLYGON' });
      await expect(c.adminPlatform.createServiceArea(admin.id, { name: 'Open', polygon: [[0, 0], [1, 1], [1, 0]] })).rejects.toMatchObject({ code: 'INVALID_POLYGON' });
      const area = await c.adminPlatform.createServiceArea(admin.id, { name: `Banani-only ${Date.now()}`, polygon: [[90.40, 23.78], [90.42, 23.78], [90.42, 23.80], [90.40, 23.80], [90.40, 23.78]] });
      const w = await world();
      const inside = await c.discovery.listRestaurants({ lat: 23.7937, lng: 90.4066 });
      expect(inside.items.some((r) => r.id === w.restaurant.id)).toBe(true);
      const outside = await c.discovery.listRestaurants({ lat: 23.7, lng: 90.3 });
      expect(outside.items).toHaveLength(0);
      await c.adminPlatform.setServiceAreaActive(admin.id, area.id, false);
      expect((await c.adminPlatform.listServiceAreas() as any[]).find((a) => a.id === area.id)).toMatchObject({ isActive: false, polygon: { type: 'Polygon' } });
      await c.adminPlatform.deleteServiceArea(admin.id, area.id);
      expect((await c.adminPlatform.listServiceAreas() as any[]).some((a) => a.id === area.id)).toBe(false);
    });

    it('promotions reach only users who opted in; statistics summarise what needs attention', async () => {
      const admin = await f.user('ADMIN');
      const yes = await f.user('CUSTOMER');
      const no = await f.user('CUSTOMER');
      await prisma().profile.update({ where: { userId: yes.id }, data: { marketingConsent: true } });
      const out = await c.adminPlatform.broadcastPromotion(admin.id, { title: 'Weekend deal', body: 'Free delivery on Friday', role: 'CUSTOMER' });
      expect(out.recipients).toBeGreaterThanOrEqual(1);
      expect(await prisma().notification.count({ where: { userId: yes.id, type: 'PROMOTION' } })).toBe(1);
      expect(await prisma().notification.count({ where: { userId: no.id, type: 'PROMOTION' } })).toBe(0);

      const st = await c.adminPlatform.stats();
      expect(st).toMatchObject({ needsAttention: { openTickets: expect.any(Number), refundsToAction: expect.any(Number), ordersWithoutRider: expect.any(Number) }, gmvMinor: { last24h: expect.any(Number) } });
      expect(st.orders.deliveredLast24h).toBeGreaterThan(0);
    });
  });

  // ───────────────────────── over HTTP ─────────────────────────
  describe('over HTTP', () => {
    it('pay with the development gateway, get refunded, review, raise a ticket: with correct roles and validation', async () => {
      const w = await world();
      const s = await shopper(w);
      const cust = await login(s.customer.id);
      const placed = await http.post('/api/v1/orders').set(cust).set('Idempotency-Key', key()).send({ addressId: s.address.id, paymentMethod: 'ONLINE' }).expect(201);
      expect(placed.body).toMatchObject({ status: 'PENDING_PAYMENT', payment: { redirectUrl: expect.stringContaining('/dev/payments/') } });
      const ref = placed.body.payment.redirectUrl.split('/').pop();
      await http.post(`/api/v1/dev/payments/${ref}/simulate`).send({ outcome: 'PAID' }).expect(200);
      expect((await http.get(`/api/v1/orders/${placed.body.id}`).set(cust).expect(200)).body.status).toBe('PLACED');

      await deliver(w, placed.body.id);
      await http.post(`/api/v1/orders/${placed.body.id}/review`).set(cust).send({ restaurantRating: 6 }).expect(400);
      await http.post(`/api/v1/orders/${placed.body.id}/review`).set(cust).send({ restaurantRating: 5, riderRating: 4, comment: 'Great', extra: 1 }).expect(400);
      await http.post(`/api/v1/orders/${placed.body.id}/review`).set(cust).send({ restaurantRating: 5, riderRating: 4, comment: 'Great' }).expect(201);
      await http.post(`/api/v1/orders/${placed.body.id}/review`).set(cust).send({ restaurantRating: 5 }).expect(409);
      expect((await http.get(`/api/v1/restaurants/${w.restaurant.slug}/reviews`).expect(200)).body).toMatchObject({ rating: { average: 5, count: 1 }, items: [{ reviewer: 'Nusrat J.', comment: 'Great' }] });

      await http.post(`/api/v1/orders/${placed.body.id}/refund-requests`).set(cust).send({ reason: 'ab' }).expect(400);
      const rr = await http.post(`/api/v1/orders/${placed.body.id}/refund-requests`).set(cust).send({ amountMinor: 1000, reason: 'Missing sauce' }).expect(201);
      const admin = await login((await f.user('ADMIN')).id);
      await http.get('/api/v1/admin/refunds?status=REQUESTED').set(cust).expect(403);
      await http.post(`/api/v1/admin/refunds/${rr.body.id}/review`).set(admin).send({ approve: true }).expect(200).then((r) => expect(r.body.status).toBe('PROCESSED'));
      expect((await http.get(`/api/v1/orders/${placed.body.id}/refunds`).set(cust).expect(200)).body[0]).toMatchObject({ status: 'PROCESSED', amountMinor: 1000 });

      const tk = await http.post('/api/v1/support/tickets').set(cust).send({ category: 'ORDER_ISSUE', subject: 'Where is my receipt?', description: 'I need a receipt for this order', orderId: placed.body.id }).expect(201);
      await http.get(`/api/v1/support/tickets/${tk.body.id}`).set(await login((await f.user('CUSTOMER')).id)).expect(404);
      await http.get('/api/v1/admin/support/tickets').set(cust).expect(403);
      expect((await http.get('/api/v1/admin/support/tickets?open=true').set(admin).expect(200)).body.items.map((t: any) => t.id)).toContain(tk.body.id);
      await http.get('/api/v1/admin/reconciliation').set(admin).expect(400); // from/to required
      await http.get(`/api/v1/owner/restaurants/${w.restaurant.id}/earnings`).set(await login(w.owner.id)).expect(200).then((r) => expect(r.body.total).toBe(1));
      await http.get('/api/v1/rider/earnings').set(cust).expect(403);
    });

    it('the simulated gateway is not mounted when online payment is off, and the webhook says so', async () => {
      const offline = buildServices(env.prisma); // PAYMENT_PROVIDER=none
      const app = request(createApp(offline, { rateLimit: false }));
      await app.post('/api/v1/dev/payments/ffpay_x/simulate').send({ outcome: 'PAID' }).expect(404);
      await app.post('/api/v1/payments/webhook').set('Content-Type', 'application/json').send('{}').expect(404);
      const w = await world();
      const s = await shopper(w);
      await expect(offline.orders.placeOrder(s.customer.id, { addressId: s.address.id, paymentMethod: 'ONLINE' }, key())).rejects.toMatchObject({ code: 'PAYMENT_METHOD_UNAVAILABLE' });
    });
  });
});
