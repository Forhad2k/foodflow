import { ApprovalStatus, OrderStatus, Role } from '@prisma/client';
import { DomainError } from '../common/errors/domain-error';
import { AdminRestaurantsService } from '../admin/admin-restaurants.service';
import { OrderTimeoutService } from '../orders/order-timeout.service';
import { OwnerMenuService } from './owner-menu.service';
import { OwnerOrdersService } from './owner-orders.service';
import { OwnerRestaurantsService } from './owner-restaurants.service';
import { RestaurantAccessService } from './restaurant-access.service';

const RID = '11111111-1111-4111-8111-111111111111';
const OID = '22222222-2222-4222-8222-222222222222';
const OWNER = 'owner-1';
const code = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e: any) { return e.code ?? e.constructor.name; } };

describe('OwnerOrdersService (authorization)', () => {
  const build = (orderInRestaurant: boolean, ownsRestaurant = true) => {
    const transition = jest.fn().mockResolvedValue({});
    const prisma: any = {
      restaurant: { findFirst: jest.fn().mockResolvedValue(ownsRestaurant ? { id: RID } : null) },
      order: {
        findFirst: jest.fn().mockImplementation(({ select }: any) => (orderInRestaurant ? (select?.id && Object.keys(select).length === 1 ? { id: OID } : { id: OID, status: 'RESTAURANT_ACCEPTED', items: [], customer: { profile: { fullName: 'Rahim Uddin' } }, history: [], assignments: [] }) : null)),
      },
    };
    const access = new RestaurantAccessService(prisma);
    return { svc: new OwnerOrdersService(prisma, access, { transition } as any), transition };
  };

  it("refuses to act on another restaurant's order and never reaches the state machine", async () => {
    const { svc, transition } = build(false);
    expect(await code(svc.accept(OWNER, RID, OID, {}))).toBe('NOT_FOUND');
    expect(transition).not.toHaveBeenCalled();
  });
  it("refuses to act on a restaurant the user does not own (even for a valid order id)", async () => {
    const { svc, transition } = build(true, false);
    expect(await code(svc.markReady(OWNER, RID, OID))).toBe('RESTAURANT_NOT_FOUND');
    expect(transition).not.toHaveBeenCalled();
  });
  it('accepts as the restaurant actor and forwards the prep estimate', async () => {
    const { svc, transition } = build(true);
    await svc.accept(OWNER, RID, OID, { prepMinutes: 25 });
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ orderId: OID, to: OrderStatus.RESTAURANT_ACCEPTED, actor: { role: Role.RESTAURANT_OWNER, userId: OWNER }, patch: { estimatedPrepMinutes: 25 } }));
  });
  it('maps each endpoint to exactly one target status', async () => {
    const { svc, transition } = build(true);
    await svc.reject(OWNER, RID, OID, 'Out of stock');
    await svc.startPreparing(OWNER, RID, OID);
    await svc.markReady(OWNER, RID, OID);
    await svc.cancel(OWNER, RID, OID, 'Oven broke');
    expect(transition.mock.calls.map((c) => [c[0].to, c[0].reason])).toEqual([
      [OrderStatus.REJECTED_BY_RESTAURANT, 'Out of stock'], [OrderStatus.PREPARING, undefined], [OrderStatus.READY_FOR_PICKUP, undefined], [OrderStatus.CANCELLED, 'Oven broke'],
    ]);
  });
  it('shows the kitchen only the customer first name', async () => {
    const { svc } = build(true);
    const view: any = await svc.get(OWNER, RID, OID);
    expect(view.customerFirstName).toBe('Rahim');
    expect(JSON.stringify(view)).not.toMatch(/phone|address|Uddin/i);
  });
});

describe('AdminRestaurantsService.act', () => {
  const build = (status: ApprovalStatus, ready: boolean) => {
    const update = jest.fn().mockResolvedValue({});
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const count = (n: number) => jest.fn().mockResolvedValue(n);
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      restaurant: { findUnique: jest.fn().mockResolvedValue({ approvalStatus: status }), update },
      deliveryZone: { count: count(ready ? 1 : 0) }, operatingHour: { count: count(ready ? 7 : 0) },
      menuItem: { count: count(ready ? 3 : 0) }, restaurantCuisine: { count: count(ready ? 1 : 0) },
    };
    const prisma: any = { $transaction: (fn: any) => fn(tx) };
    return { svc: new AdminRestaurantsService(prisma, audit as any, {} as any), update, audit, tx };
  };

  it('approves a ready restaurant, records the reviewer, and writes the audit row inside the same transaction', async () => {
    const { svc, update, audit, tx } = build(ApprovalStatus.PENDING, true);
    expect(await svc.act('admin-1', RID, 'approve', undefined, '1.2.3.4')).toEqual({ id: RID, approvalStatus: ApprovalStatus.APPROVED });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ approvalStatus: 'APPROVED', reviewedById: 'admin-1', rejectionReason: null }) }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'admin-1', action: 'restaurant.approve', entityId: RID }), tx);
  });
  it('will not approve a restaurant that is not set up, and tells the admin what is missing', async () => {
    const { svc, update, audit } = build(ApprovalStatus.PENDING, false);
    await expect(svc.act('admin-1', RID, 'approve', undefined)).rejects.toMatchObject({ code: 'RESTAURANT_NOT_READY', details: { missing: expect.arrayContaining(['Set opening hours']) } });
    expect(update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
  it('rejects illegal transitions and missing reasons without changing anything', async () => {
    const approved = build(ApprovalStatus.APPROVED, true);
    expect(await code(approved.svc.act('a', RID, 'approve', undefined))).toBe('INVALID_APPROVAL_TRANSITION');
    expect(await code(approved.svc.act('a', RID, 'suspend', ''))).toBe('REASON_REQUIRED');
    const pending = build(ApprovalStatus.PENDING, true);
    expect(await code(pending.svc.act('a', RID, 'reject', undefined))).toBe('REASON_REQUIRED');
    for (const b of [approved, pending]) expect(b.update).not.toHaveBeenCalled();
  });
  it('stores the rejection reason so the owner can see what to fix', async () => {
    const { svc, update } = build(ApprovalStatus.PENDING, true);
    await svc.act('a', RID, 'reject', '  Photos are missing ');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ approvalStatus: 'REJECTED', rejectionReason: 'Photos are missing' }) }));
  });
});

describe('OrderTimeoutService', () => {
  const build = (stale: string[], transition: jest.Mock) => {
    const findMany = jest.fn().mockResolvedValue(stale.map((id) => ({ id })));
    const svc = new OrderTimeoutService(
      { order: { findMany } } as any, { transition } as any,
      { get: async () => ({ 'order.restaurantAcceptTimeoutSeconds': 180 }) } as any,
      { JOBS_ENABLED: true } as any,
    );
    return { svc, findMany };
  };
  it('rejects only PLACED orders older than the timeout, as the SYSTEM, with a reason', async () => {
    const transition = jest.fn().mockResolvedValue({});
    const { svc, findMany } = build(['o1', 'o2'], transition);
    const now = new Date('2026-10-12T10:00:00Z');
    expect(await svc.rejectUnansweredOrders(now)).toBe(2);
    const where = findMany.mock.calls[0][0].where;
    expect(where.status).toBe(OrderStatus.PLACED);
    expect(where.placedAt.lt).toEqual(new Date('2026-10-12T09:57:00Z'));
    expect(transition).toHaveBeenCalledWith({ orderId: 'o1', to: OrderStatus.REJECTED_BY_RESTAURANT, actor: { role: 'SYSTEM' }, reason: expect.stringMatching(/did not respond/i) });
  });
  it('ignores orders that another instance or the restaurant already handled, and keeps going', async () => {
    const transition = jest.fn().mockRejectedValueOnce(new DomainError('INVALID_ORDER_TRANSITION', 'raced', 409)).mockResolvedValueOnce({});
    const { svc } = build(['o1', 'o2'], transition);
    expect(await svc.rejectUnansweredOrders()).toBe(1);
    expect(transition).toHaveBeenCalledTimes(2);
  });
});

describe('OwnerRestaurantsService zones & hours (input validation before the database)', () => {
  const svc = (zoneCount = 0, checkRow: any = { valid: true, area: 1e6 }) => {
    const prisma: any = {
      restaurant: { findFirst: jest.fn().mockResolvedValue({ id: RID }) },
      deliveryZone: { count: jest.fn().mockResolvedValue(zoneCount), create: jest.fn().mockResolvedValue({ id: 'z1' }) },
      $queryRaw: jest.fn().mockResolvedValueOnce([checkRow]).mockResolvedValue([{ id: 'zp' }]),
    };
    return { s: new OwnerRestaurantsService(prisma, new RestaurantAccessService(prisma), {} as any, {} as any, { IMAGE_HOST_ALLOWLIST: [] } as any), prisma };
  };
  const ring = [[90.40, 23.78], [90.42, 23.78], [90.42, 23.80], [90.40, 23.80], [90.40, 23.78]] as [number, number][];

  it('rejects malformed, self-intersecting and oversized polygons without inserting', async () => {
    expect(await code(svc().s.createZone(OWNER, RID, { name: 'Z', type: 'POLYGON', polygon: ring.slice(0, 4) }))).toBe('INVALID_POLYGON');
    const bad = svc(0, { valid: false, reason: 'Self-intersection' });
    expect(await code(bad.s.createZone(OWNER, RID, { name: 'Z', type: 'POLYGON', polygon: ring }))).toBe('INVALID_POLYGON');
    expect(bad.prisma.$queryRaw).toHaveBeenCalledTimes(1); // only the check ran, never the insert
    expect(await code(svc(0, { valid: true, area: 6e9 }).s.createZone(OWNER, RID, { name: 'Z', type: 'POLYGON', polygon: ring }))).toBe('ZONE_TOO_LARGE');
  });
  it('caps zones per restaurant and accepts a valid polygon', async () => {
    expect(await code(svc(10).s.createZone(OWNER, RID, { name: 'Z', type: 'RADIUS', radiusMeters: 1000 }))).toBe('ZONE_LIMIT');
    expect(await svc().s.createZone(OWNER, RID, { name: 'Z', type: 'POLYGON', polygon: ring })).toEqual({ id: 'zp' });
  });
  it('rejects invalid opening hours before touching the database', async () => {
    const { s, prisma } = svc();
    prisma.operatingHour = { deleteMany: jest.fn(), createMany: jest.fn() };
    expect(await code(s.setHours(OWNER, RID, { hours: [{ dayOfWeek: 1, opensAtMin: 600, closesAtMin: 900 }, { dayOfWeek: 1, opensAtMin: 800, closesAtMin: 1000 }] }))).toBe('INVALID_HOURS');
    expect(prisma.operatingHour.deleteMany).not.toHaveBeenCalled();
  });
  it('stats rejects inverted and oversized ranges', async () => {
    const { s } = svc();
    expect(await code(s.stats(OWNER, RID, { from: new Date('2026-10-02'), to: new Date('2026-10-01') }))).toBe('INVALID_RANGE');
    expect(await code(s.stats(OWNER, RID, { from: new Date('2020-01-01'), to: new Date('2026-10-01') }))).toBe('RANGE_TOO_LARGE');
  });
});

describe('OwnerMenuService validation', () => {
  const svc = () => {
    const prisma: any = { restaurant: { findFirst: jest.fn().mockResolvedValue({ id: RID }) }, $transaction: jest.fn() };
    return { s: new OwnerMenuService(prisma, new RestaurantAccessService(prisma), { IMAGE_HOST_ALLOWLIST: [] } as any), prisma };
  };
  const group = (o: any = {}) => ({ name: 'Sides', minSelect: 0, maxSelect: 2, addons: [{ name: 'A', priceMinor: 1 }, { name: 'B', priceMinor: 2 }], ...o });

  it('rejects impossible add-on group rules before opening a transaction', async () => {
    const { s, prisma } = svc();
    expect(await code(s.syncAddonGroups(OWNER, RID, OID, { groups: [group({ minSelect: 3, maxSelect: 2 })] }))).toBe('INVALID_GROUP_LIMITS');
    expect(await code(s.syncAddonGroups(OWNER, RID, OID, { groups: [group({ minSelect: 3, maxSelect: 3 })] }))).toBe('INVALID_GROUP_LIMITS'); // min > number of add-ons
    expect(await code(s.syncAddonGroups(OWNER, RID, OID, { groups: [group({ addons: [] })] }))).toBe('EMPTY_GROUP');
    expect(await code(s.syncAddonGroups(OWNER, RID, OID, { groups: [group(), group()] }))).toBe('DUPLICATE_GROUP');
    expect(await code(s.syncAddonGroups(OWNER, RID, OID, { groups: [group({ addons: [{ name: 'a', priceMinor: 1 }, { name: 'A', priceMinor: 1 }] })] }))).toBe('DUPLICATE_ADDON');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('rejects duplicate option names and multiple defaults', async () => {
    const { s, prisma } = svc();
    expect(await code(s.syncVariants(OWNER, RID, OID, { variants: [{ name: 'Large', priceMinor: 1 }, { name: ' large ', priceMinor: 2 }] }))).toBe('DUPLICATE_VARIANT');
    expect(await code(s.syncVariants(OWNER, RID, OID, { variants: [{ name: 'S', priceMinor: 1, isDefault: true }, { name: 'L', priceMinor: 2, isDefault: true }] }))).toBe('MULTIPLE_DEFAULTS');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('refuses another owner before doing anything', async () => {
    const { s, prisma } = svc();
    prisma.restaurant.findFirst.mockResolvedValue(null);
    expect(await code(s.createItem(OWNER, RID, { categoryId: OID, name: 'x', basePriceMinor: 1 }))).toBe('RESTAURANT_NOT_FOUND');
    expect(await code(s.getMenu(OWNER, RID))).toBe('RESTAURANT_NOT_FOUND');
  });
  it('only accepts approved image hosts', async () => {
    const prisma: any = { restaurant: { findFirst: jest.fn().mockResolvedValue({ id: RID }) } };
    const s = new OwnerMenuService(prisma, new RestaurantAccessService(prisma), { IMAGE_HOST_ALLOWLIST: ['res.cloudinary.com'] } as any);
    expect(await code(s.createItem(OWNER, RID, { categoryId: OID, name: 'x', basePriceMinor: 1, imageUrls: ['https://evil.example/a.jpg'] }))).toBe('IMAGE_HOST_NOT_ALLOWED');
  });
});
