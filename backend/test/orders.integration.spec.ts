import { OrderStatus, PaymentMethod } from '@prisma/client';
import { OwnerOrdersService } from '../src/restaurants/owner-orders.service';
import { RestaurantAccessService } from '../src/restaurants/restaurant-access.service';
import { OrderTimeoutService } from '../src/orders/order-timeout.service';
import { buildServices, describeIt, factories, setupDatabase, TestEnv, testEnv } from './support/integration';

jest.setTimeout(120_000);

const COD = PaymentMethod.CASH_ON_DELIVERY;
const settle = async (ps: Promise<any>[]) => (await Promise.allSettled(ps)).map((r) => (r.status === 'fulfilled' ? { ok: true as const, value: r.value } : { ok: false as const, code: r.reason?.code ?? r.reason?.constructor?.name, details: r.reason?.details, message: r.reason?.message }));

describeIt('orders & checkout against real PostgreSQL', () => {
  let env: TestEnv;
  let svc: ReturnType<typeof buildServices>;
  let f: ReturnType<typeof factories>;
  let prisma: TestEnv['prisma'];
  let n = 0;
  const key = () => `idem-key-${Date.now()}-${n++}`;

  beforeAll(async () => {
    env = await setupDatabase();
    prisma = env.prisma;
    svc = buildServices(prisma);
    f = factories(prisma);
  });
  afterAll(async () => env.close());

  /** owner + live restaurant + a customer with an address and `qty` of the first item in their cart */
  const scenario = async (o: { stock?: number | null; price?: number; qty?: number; minOrder?: number; couponCode?: string } = {}) => {
    const owner = await f.user('RESTAURANT_OWNER');
    const { restaurant, items } = await f.restaurant(owner.id, { items: [{ name: 'Burger', price: o.price ?? 30000, stock: o.stock ?? null }], minOrderMinor: o.minOrder ?? 0 });
    const customer = await f.user('CUSTOMER');
    const address = await f.address(customer.id);
    await svc.carts.addItem(customer.id, { menuItemId: items[0].id, quantity: o.qty ?? 1 });
    if (o.couponCode) await svc.carts.setCoupon(customer.id, o.couponCode);
    return { owner, restaurant, item: items[0], customer, address };
  };
  const place = (s: { customer: { id: string }; address: { id: string } }, k = key(), extra: object = {}) =>
    svc.orders.placeOrder(s.customer.id, { addressId: s.address.id, paymentMethod: COD, ...extra }, k);

  it('prices on the server, snapshots the receipt, empties the cart and records history + a pending cash payment', async () => {
    const s = await scenario({ qty: 2 });
    const quote = await svc.checkout.compute(prisma, s.customer.id, { addressId: s.address.id });
    expect(quote.issues).toEqual([]);
    expect(quote.totals).toEqual({ subtotalMinor: 60000, deliveryFeeMinor: 5000, serviceFeeMinor: 1000, discountMinor: 0, taxMinor: 0, totalMinor: 66000 });

    const { order, replayed } = await place(s);
    expect(replayed).toBe(false);
    expect(order.status).toBe(OrderStatus.PLACED);
    expect(order.totals.totalMinor).toBe(66000);
    expect(order.items).toMatchObject([{ name: 'Burger', quantity: 2, unitPriceMinor: 30000, lineTotalMinor: 60000 }]);
    expect(order.deliveryAddress).toMatchObject({ line1: 'House 1, Road 2', city: 'Dhaka' });
    expect(order.timeline).toHaveLength(1);
    expect(order.payments).toMatchObject([{ method: COD, status: 'PENDING', amountMinor: 66000 }]);
    expect(order.customerActions).toContain('CANCELLED');

    const cart = await svc.carts.getCart(s.customer.id);
    expect(cart.items).toHaveLength(0);
    expect(cart.restaurant).toBeNull();
  });

  it('a later menu price change never rewrites an existing receipt', async () => {
    const s = await scenario({ price: 30000 });
    const { order } = await place(s);
    await prisma.menuItem.update({ where: { id: s.item.id }, data: { basePriceMinor: 99999, name: 'Renamed' } });
    const again = await svc.orders.get(s.customer.id, order.id);
    expect(again.items[0]).toMatchObject({ name: 'Burger', unitPriceMinor: 30000 });
    expect(again.totals.subtotalMinor).toBe(30000);
  });

  it('idempotency: the same key returns the original order and reserves stock only once', async () => {
    const s = await scenario({ stock: 5, qty: 2 });
    const k = key();
    const first = await place(s, k);
    const second = await place(s, k);
    expect(second.replayed).toBe(true);
    expect(second.order.id).toBe(first.order.id);
    expect(await prisma.order.count({ where: { customerId: s.customer.id } })).toBe(1);
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: s.item.id } })).stockQuantity).toBe(3);
  });

  it('double-click storm: 6 simultaneous submits with the SAME key create exactly one order', async () => {
    const s = await scenario({ stock: 10, qty: 1 });
    const k = key();
    const results = await settle(Array.from({ length: 6 }, () => place(s, k)));
    expect(results.every((r) => r.ok)).toBe(true);
    const ids = new Set(results.map((r: any) => r.value.order.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r: any) => !r.value.replayed)).toHaveLength(1);
    expect(await prisma.order.count({ where: { customerId: s.customer.id } })).toBe(1);
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: s.item.id } })).stockQuantity).toBe(9);
  });

  it('6 simultaneous submits with DIFFERENT keys on one cart: one order, the rest find an empty cart', async () => {
    const s = await scenario({ qty: 1 });
    const results = await settle(Array.from({ length: 6 }, () => place(s)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r: any) => r.code === 'CART_EMPTY')).toBe(true);
    expect(await prisma.order.count({ where: { customerId: s.customer.id } })).toBe(1);
  });

  it('never oversells: 3 left in stock, 6 customers race → exactly 3 orders, stock ends at 0, never negative', async () => {
    const owner = await f.user('RESTAURANT_OWNER');
    const { items } = await f.restaurant(owner.id, { items: [{ name: 'Last Burgers', price: 20000, stock: 3 }] });
    const buyers = [];
    for (let i = 0; i < 6; i++) {
      const c = await f.user('CUSTOMER');
      const a = await f.address(c.id);
      await svc.carts.addItem(c.id, { menuItemId: items[0].id, quantity: 1 });
      buyers.push({ customer: c, address: a });
    }
    const results = await settle(buyers.map((b) => place(b)));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    for (const r of results.filter((x) => !x.ok) as any[]) {
      expect(['CHECKOUT_BLOCKED', 'OUT_OF_STOCK']).toContain(r.code);
    }
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: items[0].id } })).stockQuantity).toBe(0);
  });

  it('a coupon with one use left can only be redeemed once, even when 5 customers race for it', async () => {
    const code = `LAST${Date.now() % 100000}`;
    await f.coupon({ code, usageLimitTotal: 1, value: 5000 });
    const owner = await f.user('RESTAURANT_OWNER');
    const { items } = await f.restaurant(owner.id, { items: [{ name: 'Wrap', price: 30000 }] });
    const buyers = [];
    for (let i = 0; i < 5; i++) {
      const c = await f.user('CUSTOMER');
      const a = await f.address(c.id);
      await svc.carts.addItem(c.id, { menuItemId: items[0].id, quantity: 1 });
      await svc.carts.setCoupon(c.id, code);
      buyers.push({ customer: c, address: a });
    }
    const results = await settle(buyers.map((b) => place(b)));
    const won = results.filter((r) => r.ok) as any[];
    expect(won).toHaveLength(1);
    expect(won[0].value.order.totals.discountMinor).toBe(5000);
    for (const r of results.filter((x) => !x.ok) as any[]) {
      expect(r.code).toBe('CHECKOUT_BLOCKED');
      expect(JSON.stringify(r.details)).toContain('COUPON_USAGE_LIMIT');
    }
    expect(await prisma.couponRedemption.count({ where: { coupon: { code } } })).toBe(1);
  });

  it('cancelling gives everything back: stock, the coupon use, and the pending cash payment', async () => {
    const code = `BACK${Date.now() % 100000}`;
    await f.coupon({ code, usageLimitTotal: 1 });
    const s = await scenario({ stock: 4, qty: 2, couponCode: code });
    const { order } = await place(s);
    expect(order.totals.discountMinor).toBe(5000);
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: s.item.id } })).stockQuantity).toBe(2);

    const cancelled = await svc.orders.cancel(s.customer.id, order.id, {});
    expect(cancelled.status).toBe(OrderStatus.CANCELLED);
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: s.item.id } })).stockQuantity).toBe(4);
    expect(await prisma.couponRedemption.count({ where: { orderId: order.id } })).toBe(0);
    expect(cancelled.payments[0].status).toBe('CANCELLED');
    expect(cancelled.timeline.map((t) => t.to)).toEqual(['PLACED', 'CANCELLED']);

    // the single-use coupon is available to someone else again
    const s2 = await scenario({ qty: 1, couponCode: code });
    expect((await place(s2)).order.totals.discountMinor).toBe(5000);
  });

  it('blocks checkout with precise reasons: undeliverable address, minimum order, restaurant not approved', async () => {
    const s = await scenario({ qty: 1, minOrder: 90000 });
    const far = await f.address(s.customer.id, 24.5, 91.5);
    const farQuote = await svc.checkout.compute(prisma, s.customer.id, { addressId: far.id });
    expect(farQuote.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['ADDRESS_NOT_DELIVERABLE', 'MIN_ORDER_NOT_MET']));
    const res = await settle([place({ customer: s.customer, address: far })]);
    expect(res[0]).toMatchObject({ ok: false, code: 'CHECKOUT_BLOCKED' });

    const owner = await f.user('RESTAURANT_OWNER');
    const pending = await f.restaurant(owner.id, { approval: 'PENDING' });
    const c = await f.user('CUSTOMER');
    await expect(svc.carts.addItem(c.id, { menuItemId: pending.items[0].id, quantity: 1 })).rejects.toMatchObject({ code: 'ITEM_NOT_FOUND' });
  });

  it('one restaurant per cart, unless the customer explicitly starts over', async () => {
    const s = await scenario({ qty: 1 });
    const other = await f.restaurant((await f.user('RESTAURANT_OWNER')).id, { items: [{ name: 'Pasta', price: 40000 }] });
    await expect(svc.carts.addItem(s.customer.id, { menuItemId: other.items[0].id, quantity: 1 })).rejects.toMatchObject({ code: 'CART_RESTAURANT_MISMATCH' });
    const view = await svc.carts.addItem(s.customer.id, { menuItemId: other.items[0].id, quantity: 1, replaceCart: true });
    expect(view.items.map((i) => i.name)).toEqual(['Pasta']);
  });

  it("other customers cannot read or cancel someone else's order (404, not 403)", async () => {
    const s = await scenario();
    const { order } = await place(s);
    const stranger = await f.user('CUSTOMER');
    await expect(svc.orders.get(stranger.id, order.id)).rejects.toMatchObject({ status: 404 });
    await expect(svc.orders.cancel(stranger.id, order.id, {})).rejects.toMatchObject({ status: 404 });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.PLACED);
  });

  describe('restaurant side', () => {
    const ownerOrders = () => new OwnerOrdersService(prisma, new RestaurantAccessService(prisma), svc.transitions);

    it('accept → preparing → ready, with the right actors; the customer can no longer cancel once cooking starts', async () => {
      const s = await scenario({ qty: 1 });
      const { order } = await place(s);
      const oo = ownerOrders();

      const accepted: any = await oo.accept(s.owner.id, s.restaurant.id, order.id, { prepMinutes: 35 });
      expect(accepted.status).toBe('RESTAURANT_ACCEPTED');
      expect(accepted.estimatedPrepMinutes).toBe(35);
      expect(accepted.customerFirstName).toBeTruthy();
      expect(accepted).not.toHaveProperty('contactPhone');

      await oo.startPreparing(s.owner.id, s.restaurant.id, order.id);
      await expect(svc.orders.cancel(s.customer.id, order.id, { reason: 'changed my mind' })).rejects.toMatchObject({ code: 'FORBIDDEN_ORDER_TRANSITION' });
      const ready: any = await oo.markReady(s.owner.id, s.restaurant.id, order.id);
      expect(ready.status).toBe('READY_FOR_PICKUP');
      expect(ready.timeline.map((t: any) => t.to)).toEqual(['PLACED', 'RESTAURANT_ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).version).toBe(3);
    });

    it("another owner cannot touch this restaurant's orders, and an owner cannot skip steps", async () => {
      const s = await scenario();
      const { order } = await place(s);
      const intruder = await f.user('RESTAURANT_OWNER');
      const own = await f.restaurant(intruder.id);
      const oo = ownerOrders();
      await expect(oo.accept(intruder.id, s.restaurant.id, order.id, {})).rejects.toMatchObject({ code: 'RESTAURANT_NOT_FOUND' });
      await expect(oo.accept(intruder.id, own.restaurant.id, order.id, {})).rejects.toMatchObject({ status: 404 }); // their restaurant, not their order
      await expect(oo.markReady(s.owner.id, s.restaurant.id, order.id)).rejects.toMatchObject({ code: 'INVALID_ORDER_TRANSITION' });
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.PLACED);
    });

    it('two simultaneous actions on one order: exactly one wins, no corrupted history', async () => {
      const s = await scenario();
      const { order } = await place(s);
      const oo = ownerOrders();
      const res = await settle([
        oo.accept(s.owner.id, s.restaurant.id, order.id, {}),
        oo.reject(s.owner.id, s.restaurant.id, order.id, 'Too busy'),
        svc.orders.cancel(s.customer.id, order.id, {}),
      ]);
      expect(res.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1); // which request wins the race varies; some must
      const history = await prisma.orderStatusHistory.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } });
      for (let i = 1; i < history.length; i++) expect(history[i].fromStatus).toBe(history[i - 1].toStatus); // an unbroken chain
      const reached = history.map((h) => h.toStatus);
      expect(reached.includes('RESTAURANT_ACCEPTED') && reached.includes('REJECTED_BY_RESTAURANT')).toBe(false); // accept and reject can never both win
      const final = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(final.status).toBe(history[history.length - 1].toStatus);
    });

    it('a restaurant that never answers: the system rejects the order and releases stock', async () => {
      const s = await scenario({ stock: 5, qty: 2 });
      const { order } = await place(s);
      expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: s.item.id } })).stockQuantity).toBe(3);
      await prisma.order.update({ where: { id: order.id }, data: { placedAt: new Date(Date.now() - 10 * 60_000) } });

      const job = new OrderTimeoutService(prisma, svc.transitions, svc.settings, testEnv);
      expect(await job.rejectUnansweredOrders()).toBeGreaterThanOrEqual(1);
      const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(after.status).toBe(OrderStatus.REJECTED_BY_RESTAURANT);
      expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: s.item.id } })).stockQuantity).toBe(5);
      const last = await prisma.orderStatusHistory.findFirstOrThrow({ where: { orderId: order.id }, orderBy: { createdAt: 'desc' } });
      expect(last).toMatchObject({ actorId: null, actorRole: null, reason: 'Restaurant did not respond in time' });
    });
  });
});
