import { AssignmentStatus, OrderStatus, Role } from '@prisma/client';
import { DomainError, notFound } from '../common/errors/domain-error';
import { isPlausibleMove } from '../common/geo/distance';
import type { AuthenticatedUser } from '../common/types';
import type { PrismaService } from '../prisma/prisma.service';
import type { SettingsService } from '../settings/settings.service';
import type { RoutingProvider } from './routing';

/** Order states in which the assigned rider's position may be shared: from acceptance until the food is delivered. */
const TRACKABLE: OrderStatus[] = [
  OrderStatus.RESTAURANT_ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY_FOR_PICKUP, OrderStatus.RIDER_ASSIGNED, OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY,
];

export interface LocationInput { orderId: string; lat: number; lng: number; accuracyM?: number; headingDeg?: number; speedMps?: number }

/**
 * Live rider tracking. Position is short-lived operational data:
 *  - only the assigned rider can write it, only while their delivery is active, rate-limited and plausibility-checked
 *  - only that order's customer, the assigned rider and admins can read it (anyone else gets a 404)
 *  - rows are deleted after LOCATION_RETENTION_HOURS; the rider's stored position is erased when they go offline
 */
export class TrackingService {
  private readonly lastAccepted = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly routing: RoutingProvider,
    private readonly retentionHours: number,
  ) {}

  /** Who may watch this order's rider. Returns the active assignment context. */
  async authorizeViewer(user: Pick<AuthenticatedUser, 'id' | 'role'>, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, customerId: true, status: true, assignments: { where: { status: AssignmentStatus.ACCEPTED }, select: { id: true, riderId: true } } },
    });
    const a = order?.assignments[0];
    const allowed = !!order && (user.role === Role.ADMIN || order.customerId === user.id || a?.riderId === user.id);
    if (!order || !allowed) throw notFound('Order not found'); // strangers cannot even learn the order exists
    if (!a || !TRACKABLE.includes(order.status)) throw new DomainError('TRACKING_NOT_ACTIVE', 'Tracking is not active for this order', 409);
    return { orderId, assignmentId: a.id, riderId: a.riderId, status: order.status };
  }

  /** Last known position (for page loads and subscribe acks). */
  async latest(orderId: string, assignmentId: string) {
    const s = await this.settings.get();
    const row = await this.prisma.riderLocationUpdate.findFirst({ where: { assignmentId }, orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }] });
    if (!row) return { location: null, staleAfterSeconds: s['tracking.staleAfterSeconds'] };
    const eta = await this.etaFor(orderId, row.lat, row.lng);
    return {
      staleAfterSeconds: s['tracking.staleAfterSeconds'],
      location: { lat: row.lat, lng: row.lng, headingDeg: row.headingDeg, speedMps: row.speedMps, recordedAt: row.recordedAt, stale: Date.now() - row.recordedAt.getTime() > s['tracking.staleAfterSeconds'] * 1000, ...eta },
    };
  }

  /** A rider reports their position. Every rule is enforced here, so socket and any other transport behave identically. */
  async record(riderId: string, input: LocationInput, now = new Date()) {
    const s = await this.settings.get();
    const rider = await this.prisma.riderProfile.findUnique({ where: { userId: riderId }, select: { isOnline: true, approvalStatus: true, lastLat: true, lastLng: true, lastLocationAt: true } });
    if (!rider || rider.approvalStatus !== 'APPROVED' || !rider.isOnline) throw new DomainError('NOT_ONLINE', 'Go online to share your location', 409);

    const a = await this.prisma.deliveryAssignment.findFirst({ where: { orderId: input.orderId, riderId, status: AssignmentStatus.ACCEPTED }, select: { id: true, order: { select: { status: true } } } });
    if (!a || !TRACKABLE.includes(a.order.status)) throw new DomainError('TRACKING_NOT_ACTIVE', 'You have no active delivery for this order', 409);

    const minGapMs = (s['tracking.updateIntervalSeconds'] * 1000) / 2;
    const last = this.lastAccepted.get(riderId) ?? 0;
    if (now.getTime() - last < minGapMs) throw new DomainError('TOO_FREQUENT', 'Location updates are too frequent', 429);

    const prev = rider.lastLat !== null && rider.lastLng !== null && rider.lastLocationAt ? { lat: rider.lastLat, lng: rider.lastLng, at: rider.lastLocationAt } : null;
    if (!isPlausibleMove(prev, { lat: input.lat, lng: input.lng, at: now })) throw new DomainError('IMPLAUSIBLE_LOCATION', 'Location jumped implausibly far', 422);

    this.lastAccepted.set(riderId, now.getTime());
    // The server's clock is authoritative: a client cannot back-date or future-date a position.
    await this.prisma.$transaction([
      this.prisma.riderLocationUpdate.create({ data: { assignmentId: a.id, riderId, lat: input.lat, lng: input.lng, accuracyM: input.accuracyM, headingDeg: input.headingDeg, speedMps: input.speedMps, recordedAt: now } }),
      this.prisma.riderProfile.update({ where: { userId: riderId }, data: { lastLat: input.lat, lastLng: input.lng, lastLocationAt: now } }),
    ]);
    const eta = await this.etaFor(input.orderId, input.lat, input.lng);
    return { orderId: input.orderId, lat: input.lat, lng: input.lng, headingDeg: input.headingDeg ?? null, speedMps: input.speedMps ?? null, recordedAt: now, ...eta };
  }

  /** For the live-tracking tick: which watched orders are no longer trackable, and which are silent. */
  async inspect(orderIds: string[], now = new Date()) {
    const s = await this.settings.get();
    if (!orderIds.length) return { ended: [] as { orderId: string; reason: string }[], silent: new Map<string, Date | null>() };
    const orders = await this.prisma.order.findMany({
      where: { id: { in: orderIds } },
      select: { id: true, status: true, assignments: { where: { status: AssignmentStatus.ACCEPTED }, select: { id: true } } },
    });
    const byId = new Map(orders.map((o) => [o.id, o]));
    const ended: { orderId: string; reason: string }[] = [];
    const live: { orderId: string; assignmentId: string }[] = [];
    for (const id of orderIds) {
      const o = byId.get(id);
      if (!o) ended.push({ orderId: id, reason: 'ORDER_NOT_FOUND' });
      else if (!TRACKABLE.includes(o.status)) ended.push({ orderId: id, reason: o.status });
      else if (!o.assignments[0]) ended.push({ orderId: id, reason: 'REASSIGNED' }); // rider released/replaced: tracking of the old rider stops
      else live.push({ orderId: id, assignmentId: o.assignments[0].id });
    }
    const last = live.length ? await this.prisma.riderLocationUpdate.groupBy({ by: ['assignmentId'], where: { assignmentId: { in: live.map((l) => l.assignmentId) } }, _max: { recordedAt: true } }) : [];
    const lastBy = new Map(last.map((l) => [l.assignmentId, l._max.recordedAt]));
    const silent = new Map<string, Date | null>();
    for (const l of live) {
      const at = lastBy.get(l.assignmentId) ?? null;
      if (at && now.getTime() - at.getTime() > s['tracking.staleAfterSeconds'] * 1000) silent.set(l.orderId, at);
    }
    return { ended, silent };
  }

  /** Retention policy: precise positions are not kept. */
  async purgeOld(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.retentionHours * 3_600_000);
    return (await this.prisma.riderLocationUpdate.deleteMany({ where: { receivedAt: { lt: cutoff } } })).count;
  }

  /** ETA to the CURRENT destination: the restaurant until pickup, the customer afterwards. */
  private async etaFor(orderId: string, lat: number, lng: number) {
    const o = await this.prisma.order.findUnique({ where: { id: orderId }, select: { status: true, restaurant: { select: { lat: true, lng: true } }, deliveryAddress: { select: { lat: true, lng: true } } } });
    if (!o) return {};
    const toCustomer = o.status === OrderStatus.PICKED_UP || o.status === OrderStatus.ON_THE_WAY;
    const dest = toCustomer ? o.deliveryAddress : o.restaurant;
    if (!dest) return {};
    const r = await this.routing.estimate({ lat, lng }, { lat: dest.lat, lng: dest.lng });
    return { destination: toCustomer ? ('CUSTOMER' as const) : ('RESTAURANT' as const), etaMinutes: r.minutes, distanceMeters: r.meters, etaSource: r.source };
  }
}
