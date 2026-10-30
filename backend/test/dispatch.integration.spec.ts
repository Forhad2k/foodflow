import { ApprovalStatus, AssignmentStatus, DocumentType, OrderStatus, PaymentMethod, VehicleType } from '@prisma/client';
import type { AdminRidersService } from '../src/admin/admin-riders.service';
import type { DispatchService } from '../src/dispatch/dispatch.service';
import { OwnerOrdersService } from '../src/restaurants/owner-orders.service';
import type { RidersService } from '../src/riders/riders.service';
import { buildServices, describeIt, factories, setupDatabase, TestEnv } from './support/integration';

jest.setTimeout(180_000);

// Restaurant sits at (23.7925, 90.4078). 0.0045° latitude ≈ 500 m.
const R = { lat: 23.7925, lng: 90.4078 };
const NEAR = { lat: R.lat + 0.0045, lng: R.lng };
const MID = { lat: R.lat + 0.018, lng: R.lng }; // ~2 km
const FAR = { lat: R.lat + 0.054, lng: R.lng }; // ~6 km, beyond the 4 km dispatch radius
const settle = async (ps: Promise<any>[]) => (await Promise.allSettled(ps)).map((r) => (r.status === 'fulfilled' ? { ok: true as const, value: r.value } : { ok: false as const, code: r.reason?.code ?? r.reason?.constructor?.name }));
const COD = PaymentMethod.CASH_ON_DELIVERY;

describeIt('rider verification, dispatch & delivery against real PostgreSQL', () => {
  let env: TestEnv;
  let prisma: TestEnv['prisma'];
  let svc: ReturnType<typeof buildServices>;
  let f: ReturnType<typeof factories>;
  let dispatch: DispatchService;
  let riders: RidersService;
  let owners: OwnerOrdersService;
  let adminRiders: AdminRidersService;
  let n = 0;

  beforeAll(async () => {
    env = await setupDatabase();
    prisma = env.prisma;
    svc = buildServices(prisma);
    f = factories(prisma);
    dispatch = svc.dispatch;
    riders = svc.riders;
    adminRiders = svc.adminRiders;
    owners = new OwnerOrdersService(prisma, svc.access, svc.transitions); // no dispatch hook: tests drive dispatch explicitly
  });
  afterAll(async () => env.close());

  // Isolate each test: no riders from earlier tests may stay eligible.
  beforeEach(async () => {
    // Earlier tests must not leak riders or waiting orders into this one (the sweep looks at ALL waiting orders).
    await prisma.riderProfile.updateMany({ data: { isOnline: false } });
    await prisma.deliveryAssignment.updateMany({ where: { status: { in: ['OFFERED', 'ACCEPTED'] } }, data: { status: 'CANCELLED' } });
    await prisma.order.updateMany({ where: { status: { notIn: ['DELIVERED', 'CANCELLED', 'REJECTED_BY_RESTAURANT', 'PAYMENT_FAILED', 'DELIVERY_FAILED'] } }, data: { status: 'CANCELLED' } });
  });

  const makeRider = async (o: { pos?: { lat: number; lng: number }; approved?: boolean; online?: boolean; staleMinutes?: number; suspended?: boolean; maxActive?: number } = {}) => {
    const u = await f.user('RIDER');
    await prisma.riderProfile.update({
      where: { userId: u.id },
      data: {
        approvalStatus: o.approved === false ? ApprovalStatus.PENDING : ApprovalStatus.APPROVED, vehicleType: VehicleType.MOTORCYCLE, isOnline: o.online ?? true,
        lastLat: (o.pos ?? NEAR).lat, lastLng: (o.pos ?? NEAR).lng, lastLocationAt: new Date(Date.now() - (o.staleMinutes ?? 0) * 60_000), maxActiveDeliveries: o.maxActive ?? 1,
      },
    });
    if (o.suspended) await prisma.user.update({ where: { id: u.id }, data: { status: 'SUSPENDED' } });
    return u;
  };

  /** A placed order, driven by the owner up to `until`. The restaurant is the SAME physical spot for all tests. */
  const makeOrder = async (until: 'PLACED' | 'ACCEPTED' | 'PREPARING' | 'READY' = 'ACCEPTED') => {
    const owner = await f.user('RESTAURANT_OWNER');
    const { restaurant, items } = await f.restaurant(owner.id, { lat: R.lat, lng: R.lng, items: [{ name: 'Burger', price: 30000 }] });
    const customer = await f.user('CUSTOMER', { name: 'Nusrat Jahan' });
    const address = await f.address(customer.id, 23.7937, 90.4066);
    await svc.carts.addItem(customer.id, { menuItemId: items[0].id, quantity: 1 });
    const { order } = await svc.orders.placeOrder(customer.id, { addressId: address.id, paymentMethod: COD, deliveryInstructions: 'Gate 3, 4th floor' }, `k-${Date.now()}-${n++}`);
    const step = async (to: 'accept' | 'preparing' | 'ready') => {
      if (to === 'accept') await owners.accept(owner.id, restaurant.id, order.id, {});
      if (to === 'preparing') await owners.startPreparing(owner.id, restaurant.id, order.id);
      if (to === 'ready') await owners.markReady(owner.id, restaurant.id, order.id);
    };
    if (until !== 'PLACED') await step('accept');
    if (until === 'PREPARING' || until === 'READY') await step('preparing');
    if (until === 'READY') await step('ready');
    return { owner, restaurant, customer, order, step };
  };

  const status = async (orderId: string) => (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;
  const live = (orderId: string) => prisma.deliveryAssignment.findMany({ where: { orderId, status: { in: ['OFFERED', 'ACCEPTED'] } } });
  const offerTo = async (orderId: string) => (await live(orderId))[0]?.riderId;
  const setSetting = async (key: string, value: unknown) => {
    await prisma.platformSetting.upsert({ where: { key }, update: { value: value as never }, create: { key, value: value as never } });
    svc.settings.invalidate();
  };

  // ───────────────────────── verification ─────────────────────────
  describe('rider verification', () => {
    it('only an approved rider can go online; approval needs every required document approved', async () => {
      const u = await f.user('RIDER');
      await expect(riders.setStatus(u.id, { isOnline: true, lat: NEAR.lat, lng: NEAR.lng })).rejects.toMatchObject({ code: 'RIDER_NOT_APPROVED' });

      const admin = await f.user('ADMIN');
      await expect(adminRiders.act(admin.id, u.id, 'approve', undefined)).rejects.toMatchObject({ code: 'RIDER_NOT_READY', details: { missing: expect.arrayContaining([expect.stringMatching(/vehicle/i)]) } });

      await riders.updateVehicle(u.id, { vehicleType: VehicleType.BICYCLE });
      await expect(riders.submitDocument(u.id, { type: DocumentType.NATIONAL_ID, storageKey: 'riders/someone-else/id.jpg' })).rejects.toMatchObject({ code: 'INVALID_STORAGE_KEY' });
      await riders.submitDocument(u.id, { type: DocumentType.NATIONAL_ID, storageKey: `riders/${u.id}/id.jpg` });
      const me = await riders.submitDocument(u.id, { type: DocumentType.SELFIE, storageKey: `riders/${u.id}/me.jpg` });
      expect(me.missing).toEqual(['Your national ID is awaiting review', 'Your selfie is awaiting review']);
      await expect(adminRiders.act(admin.id, u.id, 'approve', undefined)).rejects.toMatchObject({ code: 'RIDER_NOT_READY' });

      const [idDoc, selfie] = me.documents;
      await adminRiders.reviewDocument(admin.id, u.id, idDoc.id, { approve: true });
      await expect(adminRiders.reviewDocument(admin.id, u.id, selfie.id, { approve: false })).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
      await adminRiders.reviewDocument(admin.id, u.id, selfie.id, { approve: false, reason: 'Face not visible' });
      const rejected = await riders.me(u.id);
      expect(rejected.documents.find((d) => d.type === 'SELFIE')).toMatchObject({ status: 'REJECTED', rejectionReason: 'Face not visible' });

      // re-uploading replaces the rejected document and puts it back in review
      const again = await riders.submitDocument(u.id, { type: DocumentType.SELFIE, storageKey: `riders/${u.id}/me2.jpg` });
      expect(again.documents.filter((d) => d.type === 'SELFIE')).toHaveLength(1);
      const newSelfie = again.documents.find((d) => d.type === 'SELFIE')!;
      await adminRiders.reviewDocument(admin.id, u.id, newSelfie.id, { approve: true });

      expect(await adminRiders.act(admin.id, u.id, 'approve', undefined)).toMatchObject({ approvalStatus: 'APPROVED' });
      await expect(riders.setStatus(u.id, { isOnline: true })).rejects.toMatchObject({ code: 'LOCATION_REQUIRED' });
      expect(await riders.setStatus(u.id, { isOnline: true, lat: NEAR.lat, lng: NEAR.lng })).toEqual({ isOnline: true });
      expect(await prisma.auditLog.count({ where: { actorId: admin.id, action: { startsWith: 'rider.' } } })).toBeGreaterThanOrEqual(4);
      await expect(riders.submitDocument(u.id, { type: DocumentType.SELFIE, storageKey: `riders/${u.id}/x.jpg` })).rejects.toMatchObject({ code: 'DOCUMENTS_LOCKED' });
    });

    it('presence heartbeats are plausibility-checked; going offline erases the stored position', async () => {
      const u = await makeRider({ pos: NEAR });
      await expect(riders.presence(u.id, { lat: NEAR.lat + 0.0001, lng: NEAR.lng })).resolves.toEqual({ ok: true });
      await expect(riders.presence(u.id, { lat: NEAR.lat + 0.5, lng: NEAR.lng })).rejects.toMatchObject({ code: 'IMPLAUSIBLE_LOCATION' });
      expect(await riders.setStatus(u.id, { isOnline: false })).toEqual({ isOnline: false });
      const p = await prisma.riderProfile.findUniqueOrThrow({ where: { userId: u.id } });
      expect([p.lastLat, p.lastLng, p.lastLocationAt, p.isOnline]).toEqual([null, null, null, false]);
      await expect(riders.presence(u.id, { lat: 1, lng: 1 })).rejects.toMatchObject({ code: 'NOT_ONLINE' });
    });

    it('a suspended rider is taken offline, loses pending offers, and cannot come back until reinstated', async () => {
      const admin = await f.user('ADMIN');
      const u = await makeRider();
      const { order } = await makeOrder();
      await dispatch.offerNext(order.id);
      expect(await offerTo(order.id)).toBe(u.id);
      await adminRiders.act(admin.id, u.id, 'suspend', 'Fraud report');
      expect((await prisma.deliveryAssignment.findFirstOrThrow({ where: { orderId: order.id } })).status).toBe(AssignmentStatus.CANCELLED);
      const p = await prisma.riderProfile.findUniqueOrThrow({ where: { userId: u.id } });
      expect(p).toMatchObject({ isOnline: false, lastLat: null });
      await expect(riders.setStatus(u.id, { isOnline: true, lat: 1, lng: 1 })).rejects.toMatchObject({ code: 'RIDER_NOT_APPROVED' });
      await adminRiders.act(admin.id, u.id, 'reinstate', undefined);
      expect(await riders.setStatus(u.id, { isOnline: true, lat: NEAR.lat, lng: NEAR.lng })).toEqual({ isOnline: true });
    });
  });

  // ───────────────────────── offers ─────────────────────────
  describe('who gets offered a delivery', () => {
    it('only eligible riders, nearest first; ineligible riders are never asked', async () => {
      const near = await makeRider({ pos: NEAR });
      const mid = await makeRider({ pos: MID });
      await makeRider({ pos: FAR }); // outside radius
      await makeRider({ pos: NEAR, online: false });
      await makeRider({ pos: NEAR, staleMinutes: 10 }); // position too old to trust
      await makeRider({ pos: NEAR, approved: false });
      await makeRider({ pos: NEAR, suspended: true });
      const { order } = await makeOrder();

      expect(await dispatch.offerNext(order.id)).toBe('OFFERED');
      expect(await offerTo(order.id)).toBe(near.id);
      expect(await dispatch.offerNext(order.id)).toBe('ALREADY_LIVE'); // one live offer at a time

      await riders.reject(near.id, (await live(order.id))[0].id, 'too far for me');
      expect(await offerTo(order.id)).toBe(mid.id); // rejection immediately moves on, skipping the rejecter
      const mids = (await live(order.id))[0];
      await riders.reject(mid.id, mids.id);
      expect(await live(order.id)).toHaveLength(0);
      expect(await dispatch.offerNext(order.id)).toBe('NO_RIDER'); // nobody else is eligible: the order waits
      expect(await prisma.deliveryAssignment.count({ where: { orderId: order.id } })).toBe(2);
    });

    it('an unanswered offer expires and moves to the next rider; a late accept is refused', async () => {
      const a = await makeRider({ pos: NEAR });
      const b = await makeRider({ pos: MID });
      const { order } = await makeOrder();
      const t0 = new Date();
      await dispatch.offerNext(order.id, t0);
      const first = (await live(order.id))[0];
      expect(first.riderId).toBe(a.id);

      const late = new Date(t0.getTime() + 61_000); // offer timeout is 45 s
      await expect(dispatch.acceptOffer(a.id, first.id, late)).rejects.toMatchObject({ code: 'OFFER_EXPIRED' });
      expect((await prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('EXPIRED');

      const swept = await dispatch.sweep(late);
      expect(swept.offered).toBeGreaterThanOrEqual(1);
      expect(await offerTo(order.id)).toBe(b.id);
      await expect(dispatch.acceptOffer(a.id, first.id)).rejects.toMatchObject({ code: 'OFFER_NOT_AVAILABLE' });
      expect(await status(order.id)).toBe(OrderStatus.RESTAURANT_ACCEPTED); // order unaffected by all this
    });

    it('the sweep expires stale offers by itself and re-offers orders left without a rider', async () => {
      const a = await makeRider({ pos: NEAR });
      const { order } = await makeOrder();
      await dispatch.offerNext(order.id, new Date(Date.now() - 120_000)); // offered 2 minutes ago
      const b = await makeRider({ pos: MID });
      const out = await dispatch.sweep();
      expect(out.expired).toBeGreaterThanOrEqual(1);
      expect(await offerTo(order.id)).toBe(b.id); // a already had their chance this round
      void a;
    });

    it('two simultaneous dispatch attempts for one order create exactly one offer', async () => {
      await makeRider({ pos: NEAR });
      await makeRider({ pos: MID });
      const { order } = await makeOrder();
      const res = await settle(Array.from({ length: 5 }, () => dispatch.offerNext(order.id)));
      expect(res.every((r) => r.ok)).toBe(true);
      expect(res.filter((r: any) => r.value === 'OFFERED')).toHaveLength(1);
      expect(await live(order.id)).toHaveLength(1);
    });

    it('a rider already holding work is not offered more (capacity 1); two orders racing for one rider yield one offer', async () => {
      const only = await makeRider({ pos: NEAR, maxActive: 1 });
      const o1 = await makeOrder();
      const o2 = await makeOrder();
      const res = await settle([dispatch.offerNext(o1.order.id), dispatch.offerNext(o2.order.id)]);
      expect(res.map((r: any) => r.value).sort()).toEqual(['NO_RIDER', 'OFFERED']);
      expect(await prisma.deliveryAssignment.count({ where: { riderId: only.id, status: 'OFFERED' } })).toBe(1);

      const winner = (await prisma.deliveryAssignment.findFirstOrThrow({ where: { riderId: only.id, status: 'OFFERED' } }));
      await riders.accept(only.id, winner.id);
      const loserOrder = winner.orderId === o1.order.id ? o2.order : o1.order;
      expect(await dispatch.offerNext(loserOrder.id)).toBe('NO_RIDER'); // busy rider is skipped

      // even a hand-made second offer cannot be accepted past capacity
      const sneaky = await prisma.deliveryAssignment.create({ data: { orderId: loserOrder.id, riderId: only.id, expiresAt: new Date(Date.now() + 60_000) } });
      await expect(riders.accept(only.id, sneaky.id)).rejects.toMatchObject({ code: 'RIDER_AT_CAPACITY' });
    });

    it('offers show only coarse information: no exact addresses, phone numbers or customer name', async () => {
      const u = await makeRider({ pos: NEAR });
      const { order } = await makeOrder();
      await dispatch.offerNext(order.id);
      const offers = await riders.offers(u.id);
      expect(offers).toHaveLength(1);
      const json = JSON.stringify(offers[0]);
      expect(offers[0]).toMatchObject({ orderNumber: order.orderNumber, itemCount: 1, cashToCollectMinor: order.totals.totalMinor });
      expect(offers[0].pickupDistanceMeters).toBeGreaterThan(300);
      expect(offers[0].pickupDistanceMeters).toBeLessThan(700);
      expect(json).not.toMatch(/Nusrat|Road 2|House 1|\+88017|Gulshan 2|Gate 3/);
    });
  });

  // ───────────────────────── accepting & the order join ─────────────────────────
  describe('accepting a delivery', () => {
    it('double-tapping accept is safe: one assignment, one chat room, one acceptance counted', async () => {
      const u = await makeRider();
      const { order } = await makeOrder('PREPARING');
      await dispatch.offerNext(order.id);
      const offer = (await live(order.id))[0];
      const res = await settle(Array.from({ length: 5 }, () => riders.accept(u.id, offer.id)));
      expect(res.every((r) => r.ok)).toBe(true);
      expect(await prisma.deliveryAssignment.count({ where: { orderId: order.id, status: 'ACCEPTED' } })).toBe(1);
      expect(await prisma.orderChatRoom.count({ where: { orderId: order.id } })).toBe(1);
      expect((await prisma.riderProfile.findUniqueOrThrow({ where: { userId: u.id } })).offersAccepted).toBe(1);
      expect(await status(order.id)).toBe(OrderStatus.PREPARING); // food not ready: order status unchanged
    });

    it('chat opens for exactly {customer, rider} on accept', async () => {
      const u = await makeRider();
      const { order, customer } = await makeOrder();
      await dispatch.offerNext(order.id);
      expect(await prisma.orderChatRoom.count({ where: { orderId: order.id } })).toBe(0); // not before acceptance
      await riders.accept(u.id, (await live(order.id))[0].id);
      const room = await prisma.orderChatRoom.findUniqueOrThrow({ where: { orderId: order.id } });
      expect(room).toMatchObject({ customerId: customer.id, riderId: u.id, closedAt: null });
    });

    it('another rider cannot accept, reject or see someone else’s offer', async () => {
      const a = await makeRider({ pos: NEAR });
      const b = await makeRider({ pos: MID });
      const { order } = await makeOrder();
      await dispatch.offerNext(order.id);
      const offer = (await live(order.id))[0];
      await expect(riders.accept(b.id, offer.id)).rejects.toMatchObject({ code: 'OFFER_NOT_FOUND' });
      await expect(riders.reject(b.id, offer.id)).rejects.toMatchObject({ code: 'OFFER_NOT_FOUND' });
      expect(await riders.offers(b.id)).toHaveLength(0);
      expect((await prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe('OFFERED');
      void a;
    });

    it('food ready THEN rider accepts → RIDER_ASSIGNED; rider accepts THEN food ready → RIDER_ASSIGNED (either order)', async () => {
      const u1 = await makeRider({ pos: NEAR });
      const readyFirst = await makeOrder('READY');
      await dispatch.offerNext(readyFirst.order.id);
      expect(await status(readyFirst.order.id)).toBe(OrderStatus.READY_FOR_PICKUP);
      await riders.accept(u1.id, (await live(readyFirst.order.id))[0].id);
      expect(await status(readyFirst.order.id)).toBe(OrderStatus.RIDER_ASSIGNED);

      const u2 = await makeRider({ pos: NEAR });
      const riderFirst = await makeOrder('PREPARING');
      await dispatch.offerNext(riderFirst.order.id);
      await riders.accept(u2.id, (await live(riderFirst.order.id))[0].id);
      expect(await status(riderFirst.order.id)).toBe(OrderStatus.PREPARING);
      await riderFirst.step('ready');
      expect(await status(riderFirst.order.id)).toBe(OrderStatus.RIDER_ASSIGNED);
      const history = await prisma.orderStatusHistory.findMany({ where: { orderId: riderFirst.order.id }, orderBy: { createdAt: 'asc' } });
      expect(history.map((h) => h.toStatus).slice(-2)).toEqual(['READY_FOR_PICKUP', 'RIDER_ASSIGNED']);
      expect(history[history.length - 1]).toMatchObject({ actorId: null, actorRole: null }); // done by the system
    });
  });

  // ───────────────────────── the delivery itself ─────────────────────────
  describe('delivery lifecycle', () => {
    it('pickup → on the way → delivered: right order, right actor, personal data appears only when needed, cash settles', async () => {
      const u = await makeRider();
      const other = await makeRider({ pos: MID });
      const { order, customer } = await makeOrder('READY');
      await dispatch.offerNext(order.id);
      const accepted: any = await riders.accept(u.id, (await live(order.id))[0].id);

      // before pickup: restaurant exact, customer first name only
      expect(accepted).toMatchObject({ status: 'RIDER_ASSIGNED', restaurant: { phone: '+8801700000009', addressLine: 'Gulshan 2' }, customer: { firstName: 'Nusrat' }, cashToCollectMinor: order.totals.totalMinor });
      expect(JSON.stringify(accepted.customer)).not.toMatch(/House 1|Gate 3|\+88017|Jahan/);

      await expect(riders.step(u.id, order.id, OrderStatus.DELIVERED)).rejects.toMatchObject({ code: 'INVALID_ORDER_TRANSITION' }); // cannot skip pickup
      await expect(riders.step(other.id, order.id, OrderStatus.PICKED_UP)).rejects.toMatchObject({ code: 'DELIVERY_NOT_FOUND' }); // not their delivery

      const pickedUp: any = await riders.step(u.id, order.id, OrderStatus.PICKED_UP);
      expect(pickedUp.status).toBe('PICKED_UP');
      expect(pickedUp.customer).toMatchObject({ firstName: 'Nusrat', phone: expect.stringMatching(/^\+8801/), instructions: 'Gate 3, 4th floor', address: { line1: 'House 1, Road 2' } });
      await expect(riders.release(u.id, order.id, 'changed my mind')).rejects.toMatchObject({ code: 'CANNOT_RELEASE' });
      await riders.step(u.id, order.id, OrderStatus.ON_THE_WAY);
      const done: any = await riders.step(u.id, order.id, OrderStatus.DELIVERED);
      expect(done.status).toBe('DELIVERED');
      expect(done.customer).not.toHaveProperty('phone');
      expect(done.cashToCollectMinor).toBe(0);

      const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true, chatRoom: true, assignments: true } });
      expect(finalOrder.deliveredAt).toBeTruthy();
      expect(finalOrder.payments[0]).toMatchObject({ status: 'SUCCESSFUL', method: COD, amountMinor: order.totals.totalMinor });
      expect(finalOrder.assignments[0].status).toBe('COMPLETED');
      expect(finalOrder.chatRoom!.closedAt).not.toBeNull(); // chat becomes read-only
      expect(await riders.activeDeliveries(u.id)).toHaveLength(0);
      const hist = await riders.history(u.id, {});
      expect(hist.items[0]).toMatchObject({ orderNumber: order.orderNumber, outcome: 'COMPLETED' });
      expect(JSON.stringify(hist)).not.toMatch(/House 1|\+88017|Nusrat/);
      await expect(riders.deliveryByOrder(u.id, order.id)).rejects.toMatchObject({ code: 'DELIVERY_NOT_FOUND' }); // no personal data after the fact
      void customer;
    });

    it('a failed delivery needs a reason, ends the assignment and closes the chat; cash is not marked collected', async () => {
      const u = await makeRider();
      const { order } = await makeOrder('READY');
      await dispatch.offerNext(order.id);
      await riders.accept(u.id, (await live(order.id))[0].id);
      await riders.step(u.id, order.id, OrderStatus.PICKED_UP);
      await riders.step(u.id, order.id, OrderStatus.ON_THE_WAY);
      await expect(riders.step(u.id, order.id, OrderStatus.DELIVERY_FAILED)).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
      await riders.step(u.id, order.id, OrderStatus.DELIVERY_FAILED, 'Customer unreachable');
      const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true, chatRoom: true, assignments: true } });
      expect(o.status).toBe('DELIVERY_FAILED');
      expect(o.assignments[0].status).toBe('FAILED');
      expect(o.payments[0].status).toBe('PENDING');
      expect(o.chatRoom!.closedAt).not.toBeNull();
    });

    it('releasing before pickup returns the order to dispatch, closes the chat, and the next rider re-opens it', async () => {
      const first = await makeRider({ pos: NEAR });
      const second = await makeRider({ pos: MID });
      const { order, customer } = await makeOrder('READY');
      await dispatch.offerNext(order.id);
      await riders.accept(first.id, (await live(order.id))[0].id);
      expect(await status(order.id)).toBe('RIDER_ASSIGNED');
      const roomBefore = await prisma.orderChatRoom.findUniqueOrThrow({ where: { orderId: order.id } });

      await riders.release(first.id, order.id, 'Bike broke down');
      expect((await prisma.deliveryAssignment.findFirstOrThrow({ where: { orderId: order.id, riderId: first.id } })).status).toBe('CANCELLED');
      expect((await prisma.orderChatRoom.findUniqueOrThrow({ where: { orderId: order.id } })).closedAt).not.toBeNull();
      expect(await status(order.id)).toBe('READY_FOR_PICKUP'); // food is waiting for a new rider
      expect(await offerTo(order.id)).toBe(second.id); // re-dispatched at once, never back to the rider who dropped it
      await expect(riders.activeDeliveries(first.id)).resolves.toHaveLength(0);

      await riders.accept(second.id, (await live(order.id))[0].id);
      expect(await status(order.id)).toBe('RIDER_ASSIGNED');
      const room = await prisma.orderChatRoom.findUniqueOrThrow({ where: { orderId: order.id } });
      expect(room.id).toBe(roomBefore.id); // one room per order
      expect(room).toMatchObject({ riderId: second.id, customerId: customer.id, closedAt: null });
      expect(room.assignmentId).not.toBe(roomBefore.assignmentId);
      expect(room.openedAt.getTime()).toBeGreaterThan(roomBefore.openedAt.getTime()); // new rider's visibility starts here
      const history = await prisma.orderStatusHistory.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } });
      for (let i = 1; i < history.length; i++) expect(history[i].fromStatus).toBe(history[i - 1].toStatus);
    });

    it('when the restaurant cancels while a rider is assigned, the assignment ends and the chat closes', async () => {
      const u = await makeRider();
      const { order, owner, restaurant } = await makeOrder('PREPARING');
      await dispatch.offerNext(order.id);
      await riders.accept(u.id, (await live(order.id))[0].id);
      await owners.cancel(owner.id, restaurant.id, order.id, 'Kitchen fire');
      const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { assignments: true, chatRoom: true } });
      expect(o.status).toBe('CANCELLED');
      expect(o.assignments[0].status).toBe('CANCELLED');
      expect(o.chatRoom!.closedAt).not.toBeNull();
      expect(await riders.activeDeliveries(u.id)).toHaveLength(0);
      await expect(riders.step(u.id, order.id, OrderStatus.PICKED_UP)).rejects.toMatchObject({ code: 'DELIVERY_NOT_FOUND' });
    });
  });

  // ───────────────────────── when no rider can be found ─────────────────────────
  describe('admin intervention', () => {
    afterEach(async () => setSetting('dispatch.maxOfferAttempts', 5));

    it('offers run out → the order is flagged; redispatch starts a fresh round; assign/replace puts a chosen rider on it', async () => {
      await setSetting('dispatch.maxOfferAttempts', 2);
      const admin = await f.user('ADMIN');
      const a = await makeRider({ pos: NEAR });
      const b = await makeRider({ pos: MID });
      const c = await makeRider({ pos: NEAR });
      const { order, customer } = await makeOrder();

      await dispatch.offerNext(order.id);
      await riders.reject((await prisma.deliveryAssignment.findFirstOrThrow({ where: { orderId: order.id, status: 'OFFERED' } })).riderId, (await live(order.id))[0].id);
      await riders.reject((await live(order.id))[0].riderId, (await live(order.id))[0].id);
      expect(await live(order.id)).toHaveLength(0);
      expect(await dispatch.offerNext(order.id)).toBe('EXHAUSTED'); // c is eligible but the round is used up

      const stuck = await dispatch.stuckOrders();
      expect(stuck.find((s) => s.id === order.id)).toMatchObject({ reason: 'OFFERS_EXHAUSTED', attempts: 2 });

      await dispatch.redispatch(admin.id, order.id);
      expect(await live(order.id)).toHaveLength(1); // a new round: even earlier rejecters are eligible again
      expect((await dispatch.stuckOrders()).some((s) => s.id === order.id)).toBe(false);

      // direct assignment by the admin
      const target = await makeRider({ pos: MID });
      await expect(dispatch.adminAssign(admin.id, order.id, target.id, false)).resolves.toBeUndefined(); // cancels the pending offer, no conflict
      expect((await prisma.orderChatRoom.findUniqueOrThrow({ where: { orderId: order.id } }))).toMatchObject({ riderId: target.id, customerId: customer.id });
      const other = await makeRider({ pos: NEAR });
      await expect(dispatch.adminAssign(admin.id, order.id, other.id, false)).rejects.toMatchObject({ code: 'ORDER_ALREADY_ASSIGNED' });
      await dispatch.adminAssign(admin.id, order.id, other.id, true); // replace
      expect((await prisma.orderChatRoom.findUniqueOrThrow({ where: { orderId: order.id } })).riderId).toBe(other.id);
      expect(await prisma.deliveryAssignment.count({ where: { orderId: order.id, status: 'ACCEPTED' } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { actorId: admin.id, action: { in: ['dispatch.redispatch', 'dispatch.admin_assign'] } } })).toBe(3);

      const unapproved = await makeRider({ approved: false });
      await expect(dispatch.adminAssign(admin.id, order.id, unapproved.id, true)).rejects.toMatchObject({ code: 'RIDER_NOT_ELIGIBLE' });
      void a; void b; void c;
    });

    it('a delivery started by an admin assignment still follows the full lifecycle', async () => {
      const admin = await f.user('ADMIN');
      const u = await makeRider({ online: false }); // offline riders can still be assigned by an admin
      const { order } = await makeOrder('READY');
      await dispatch.adminAssign(admin.id, order.id, u.id, false);
      expect(await status(order.id)).toBe('RIDER_ASSIGNED');
      await riders.step(u.id, order.id, OrderStatus.PICKED_UP);
      await riders.step(u.id, order.id, OrderStatus.ON_THE_WAY);
      await riders.step(u.id, order.id, OrderStatus.DELIVERED);
      expect(await status(order.id)).toBe('DELIVERED');
    });
  });

  // ───────────────────────── presence ─────────────────────────
  describe('presence', () => {
    it('silent idle riders are taken offline and lose their stored position; a rider on a delivery stays online', async () => {
      const silent = await makeRider({ staleMinutes: 30 });
      const busy = await makeRider({ staleMinutes: 30 });
      const fresh = await makeRider();
      const { order } = await makeOrder();
      await prisma.deliveryAssignment.create({ data: { orderId: order.id, riderId: busy.id, status: 'ACCEPTED', expiresAt: new Date() } });

      expect(await dispatch.clearSilentRiders()).toBeGreaterThanOrEqual(1);
      const get = (id: string) => prisma.riderProfile.findUniqueOrThrow({ where: { userId: id } });
      expect(await get(silent.id)).toMatchObject({ isOnline: false, lastLat: null, lastLng: null, lastLocationAt: null });
      expect((await get(busy.id)).isOnline).toBe(true);
      expect((await get(fresh.id)).isOnline).toBe(true);
    });

    it('going offline is refused during a delivery; with only a pending offer it cancels the offer so the order moves on', async () => {
      const u = await makeRider({ pos: NEAR });
      const backup = await makeRider({ pos: MID });
      const { order } = await makeOrder();
      await dispatch.offerNext(order.id);
      expect(await offerTo(order.id)).toBe(u.id);
      await riders.setStatus(u.id, { isOnline: false });
      expect((await prisma.deliveryAssignment.findFirstOrThrow({ where: { orderId: order.id, riderId: u.id } })).status).toBe('CANCELLED');
      await dispatch.offerNext(order.id);
      expect(await offerTo(order.id)).toBe(backup.id);
      await riders.accept(backup.id, (await live(order.id))[0].id);
      await expect(riders.setStatus(backup.id, { isOnline: false })).rejects.toMatchObject({ code: 'HAS_ACTIVE_DELIVERY' });
    });
  });

  // ───────────────────────── properties under concurrency ─────────────────────────
  it('4 concurrent dispatch sweeps over 6 waiting orders and 3 riders: no order has two live assignments, no rider exceeds capacity', async () => {
    const pool = await Promise.all([makeRider({ pos: NEAR }), makeRider({ pos: NEAR }), makeRider({ pos: MID })]);
    const orders = [];
    for (let i = 0; i < 6; i++) orders.push((await makeOrder()).order);

    const res = await settle(Array.from({ length: 4 }, () => dispatch.sweep()));
    expect(res.every((r) => r.ok)).toBe(true);

    const liveRows = await prisma.deliveryAssignment.findMany({ where: { status: { in: ['OFFERED', 'ACCEPTED'] } } });
    const perOrder = new Map<string, number>();
    const perRider = new Map<string, number>();
    for (const a of liveRows) {
      perOrder.set(a.orderId, (perOrder.get(a.orderId) ?? 0) + 1);
      perRider.set(a.riderId, (perRider.get(a.riderId) ?? 0) + 1);
    }
    expect(Math.max(...perOrder.values())).toBe(1);
    expect(Math.max(...perRider.values())).toBe(1); // capacity is 1 each
    expect(liveRows).toHaveLength(3); // every rider busy, three orders still waiting
    expect(pool.map((p) => p.id).sort()).toEqual([...perRider.keys()].sort());
    void orders;
  });
});
