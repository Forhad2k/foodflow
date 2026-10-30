import { AssignmentStatus, OrderStatus, Prisma } from '@prisma/client';
import { createLogger } from '../common/logger';
import { AuditService } from '../audit/audit.service';
import type { Db } from '../common/db';
import { DomainError } from '../common/errors/domain-error';
import type { Env } from '../config/env';
import type { NotificationService } from '../notifications/notification.service';
import { offerNotification, riderAssignedNotifications } from '../notifications/order-events';
import { OrderTransitionService } from '../orders/order-transition.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { buildRiderCandidatesQuery } from './dispatch.sql';
import { RiderCandidate, rankRiders } from './ranking';

/** Order states in which a rider may be (or stay) assigned. Dispatch starts once the restaurant accepts. */
export const DISPATCHABLE: OrderStatus[] = [OrderStatus.RESTAURANT_ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY_FOR_PICKUP];
const LIVE: AssignmentStatus[] = [AssignmentStatus.OFFERED, AssignmentStatus.ACCEPTED];
const EPOCH = new Date(0);

export type OfferOutcome = 'OFFERED' | 'NO_RIDER' | 'EXHAUSTED' | 'NOT_DISPATCHABLE' | 'ALREADY_LIVE';

/**
 * Rider assignment.
 *
 * Offers go to ONE rider at a time (best-ranked first) with a deadline; an unanswered/rejected offer moves on to the
 * next eligible rider. Everything is driven by the database, not by in-memory events, so a crash or restart loses nothing:
 * a periodic sweep expires stale offers and (re)offers every order that is cooking/ready but has no live assignment.
 *
 * Concurrency rules (what makes double-assignment impossible):
 *  1. every operation locks the ORDER row first, then the RIDER row: one global lock order, so no deadlocks
 *  2. capacity and eligibility are re-checked after the rider lock is held
 *  3. a partial unique index allows at most one OFFERED/ACCEPTED assignment per order (database backstop)
 */
export class DispatchService {
  private readonly logger = createLogger(DispatchService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly transitions: OrderTransitionService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly config: Env,
    private readonly notifications?: NotificationService,
  ) {}

  // ───────────────────────── background sweep ─────────────────────────
  async tick() {
    if (!this.config.JOBS_ENABLED || this.running) return;
    this.running = true;
    try {
      await this.sweep();
    } catch (err) {
      this.logger.error(`Dispatch sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async sweep(now = new Date()) {
    const expired = await this.expireOffers(now);
    const waiting = await this.prisma.order.findMany({
      where: { status: { in: DISPATCHABLE }, assignments: { none: { status: { in: LIVE } } } },
      orderBy: { acceptedAt: 'asc' },
      take: 50,
      select: { id: true },
    });
    let offered = 0;
    for (const { id } of waiting) {
      try {
        if ((await this.offerNext(id, now)) === 'OFFERED') offered++;
      } catch (err) {
        this.logger.error(`Could not dispatch order ${id}: ${(err as Error).message}`);
      }
    }
    const presenceCleared = await this.clearSilentRiders(now);
    return { expired, offered, presenceCleared };
  }

  /** Marks overdue offers EXPIRED (the sweep then re-offers those orders). */
  async expireOffers(now = new Date()): Promise<number> {
    const res = await this.prisma.deliveryAssignment.updateMany({
      where: { status: AssignmentStatus.OFFERED, expiresAt: { lt: now } },
      data: { status: AssignmentStatus.EXPIRED, respondedAt: now },
    });
    return res.count;
  }

  /** Idle riders who stopped reporting are taken offline and their stored position is erased. */
  async clearSilentRiders(now = new Date()): Promise<number> {
    const s = await this.settings.get();
    const cutoff = new Date(now.getTime() - s['dispatch.presenceTimeoutSeconds'] * 1000);
    const res = await this.prisma.riderProfile.updateMany({
      where: {
        isOnline: true,
        OR: [{ lastLocationAt: { lt: cutoff } }, { lastLocationAt: null }],
        assignments: { none: { status: { in: LIVE } } },
      },
      data: { isOnline: false, lastLat: null, lastLng: null, lastLocationAt: null },
    });
    return res.count;
  }

  /** Low-latency path: called right after the restaurant accepts. Failures are harmless: the sweep retries. */
  async kick(orderId: string): Promise<void> {
    try {
      await this.offerNext(orderId);
    } catch (err) {
      this.logger.warn(`Immediate dispatch of ${orderId} failed (the sweep will retry): ${(err as Error).message}`);
    }
  }

  // ───────────────────────── offering ─────────────────────────
  async offerNext(orderId: string, now = new Date()): Promise<OfferOutcome> {
    const s = await this.settings.get();
    return this.prisma.$transaction(async (tx) => {
      await this.lockOrder(tx, orderId);
      const order = await tx.order.findUnique({ where: { id: orderId }, select: { status: true, restaurantId: true, dispatchResetAt: true, orderNumber: true } });
      if (!order || !DISPATCHABLE.includes(order.status)) return 'NOT_DISPATCHABLE';
      if ((await tx.deliveryAssignment.count({ where: { orderId, status: { in: LIVE } } })) > 0) return 'ALREADY_LIVE';

      const roundStart = order.dispatchResetAt ?? EPOCH;
      const attempts = await tx.deliveryAssignment.count({ where: { orderId, offeredAt: { gte: roundStart } } });
      if (attempts >= s['dispatch.maxOfferAttempts']) return 'EXHAUSTED';

      const candidates = await tx.$queryRaw<RiderCandidate[]>(
        buildRiderCandidatesQuery({
          orderId, restaurantId: order.restaurantId, maxDistanceMeters: s['dispatch.maxRiderDistanceMeters'],
          freshSince: new Date(now.getTime() - s['dispatch.riderFreshnessSeconds'] * 1000), roundStart, limit: 20,
        }),
      );
      for (const c of rankRiders(candidates, s['dispatch.maxRiderDistanceMeters'])) {
        // Re-verify under the rider lock: another order may have claimed this rider since the candidate query ran.
        await this.lockRider(tx, c.riderId);
        const rider = await tx.riderProfile.findUnique({ where: { userId: c.riderId }, select: { isOnline: true, approvalStatus: true, maxActiveDeliveries: true } });
        if (!rider?.isOnline || rider.approvalStatus !== 'APPROVED') continue;
        if ((await tx.deliveryAssignment.count({ where: { riderId: c.riderId, status: { in: LIVE } } })) >= rider.maxActiveDeliveries) continue;

        const offer = await tx.deliveryAssignment.create({
          data: { orderId, riderId: c.riderId, status: AssignmentStatus.OFFERED, attempt: attempts + 1, offeredAt: now, expiresAt: new Date(now.getTime() + s['dispatch.offerTimeoutSeconds'] * 1000) },
        });
        if (this.notifications) await this.notifications.create(tx, offerNotification(c.riderId, order.orderNumber, offer.id, offer.expiresAt));
        await tx.riderProfile.update({ where: { userId: c.riderId }, data: { offersReceived: { increment: 1 } } });
        return 'OFFERED';
      }
      return 'NO_RIDER'; // stays dispatchable: the next sweep tries again as riders come online
    });
  }

  // ───────────────────────── rider responses ─────────────────────────
  async acceptOffer(riderId: string, assignmentId: string, now = new Date()): Promise<{ orderId: string }> {
    const probe = await this.prisma.deliveryAssignment.findFirst({ where: { id: assignmentId, riderId }, select: { orderId: true } });
    if (!probe) throw new DomainError('OFFER_NOT_FOUND', 'Offer not found', 404);

    const outcome = await this.prisma.$transaction(async (tx) => {
      await this.lockOrder(tx, probe.orderId);
      await this.lockRider(tx, riderId);
      const a = await tx.deliveryAssignment.findUniqueOrThrow({ where: { id: assignmentId }, include: { order: { select: { status: true, customerId: true } } } });

      if (a.status === AssignmentStatus.ACCEPTED) return 'ALREADY' as const; // idempotent: a retried/double tap is not an error
      if (a.status !== AssignmentStatus.OFFERED) return 'GONE' as const;
      if (a.expiresAt <= now) {
        await tx.deliveryAssignment.update({ where: { id: a.id }, data: { status: AssignmentStatus.EXPIRED, respondedAt: now } });
        return 'EXPIRED' as const;
      }
      const rider = await tx.riderProfile.findUniqueOrThrow({ where: { userId: riderId }, select: { approvalStatus: true, maxActiveDeliveries: true } });
      if (rider.approvalStatus !== 'APPROVED') return 'NOT_APPROVED' as const;
      const accepted = await tx.deliveryAssignment.count({ where: { riderId, status: AssignmentStatus.ACCEPTED } });
      if (accepted >= rider.maxActiveDeliveries) return 'CAPACITY' as const;

      await this.acceptInTx(tx, a.id, a.orderId, riderId, a.order.customerId, a.order.status, now);
      return 'OK' as const;
    });

    if (outcome === 'EXPIRED') throw new DomainError('OFFER_EXPIRED', 'This offer has expired', 409);
    if (outcome === 'GONE') throw new DomainError('OFFER_NOT_AVAILABLE', 'This offer is no longer available', 409);
    if (outcome === 'NOT_APPROVED') throw new DomainError('RIDER_NOT_APPROVED', 'Your account is not approved for deliveries', 403);
    if (outcome === 'CAPACITY') throw new DomainError('RIDER_AT_CAPACITY', 'Finish your current delivery before accepting another', 409);
    return { orderId: probe.orderId };
  }

  async rejectOffer(riderId: string, assignmentId: string, reason?: string): Promise<void> {
    const probe = await this.prisma.deliveryAssignment.findFirst({ where: { id: assignmentId, riderId }, select: { orderId: true } });
    if (!probe) throw new DomainError('OFFER_NOT_FOUND', 'Offer not found', 404);
    const res = await this.prisma.$transaction(async (tx) => {
      await this.lockOrder(tx, probe.orderId);
      const a = await tx.deliveryAssignment.findUniqueOrThrow({ where: { id: assignmentId } });
      if (a.status === AssignmentStatus.REJECTED) return 'ALREADY';
      if (a.status !== AssignmentStatus.OFFERED) return 'GONE';
      await tx.deliveryAssignment.update({ where: { id: a.id }, data: { status: AssignmentStatus.REJECTED, respondedAt: new Date(), rejectReason: reason?.trim() || null } });
      return 'OK';
    });
    if (res === 'GONE') throw new DomainError('OFFER_NOT_AVAILABLE', 'This offer is no longer available', 409);
    if (res === 'OK') await this.kick(probe.orderId);
  }

  /** A rider drops an accepted delivery before picking it up. The order goes back to dispatch. */
  async releaseDelivery(riderId: string, orderId: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockOrder(tx, orderId);
      const a = await tx.deliveryAssignment.findFirst({ where: { orderId, riderId, status: AssignmentStatus.ACCEPTED }, include: { order: { select: { status: true } } } });
      if (!a) throw new DomainError('DELIVERY_NOT_FOUND', 'Delivery not found', 404);
      if (a.order.status === OrderStatus.PICKED_UP || a.order.status === OrderStatus.ON_THE_WAY) {
        throw new DomainError('CANNOT_RELEASE', 'You already have the food. Report a failed delivery instead.', 409);
      }
      await this.unassignInTx(tx, a.id, orderId, a.order.status, AssignmentStatus.CANCELLED, `Released by rider: ${reason.trim()}`);
      await this.audit.log({ actorId: riderId, action: 'dispatch.rider_release', entityType: 'Order', entityId: orderId, metadata: { reason: reason.trim() } }, tx);
    });
    await this.kick(orderId);
  }

  // ───────────────────────── admin intervention ─────────────────────────
  /** Orders that are cooking/ready but have no rider and need a human: offers exhausted, or waiting too long. */
  async stuckOrders(now = new Date()) {
    const s = await this.settings.get();
    const orders = await this.prisma.order.findMany({
      where: { status: { in: DISPATCHABLE }, assignments: { none: { status: { in: LIVE } } } },
      orderBy: { acceptedAt: 'asc' },
      take: 200,
      select: {
        id: true, orderNumber: true, status: true, restaurantName: true, acceptedAt: true, dispatchResetAt: true,
        assignments: { select: { offeredAt: true, status: true } },
      },
    });
    return orders
      .map((o) => {
        const roundStart = o.dispatchResetAt ?? EPOCH;
        const attempts = o.assignments.filter((a) => a.offeredAt >= roundStart).length;
        const waitingSeconds = o.acceptedAt ? Math.floor((now.getTime() - o.acceptedAt.getTime()) / 1000) : 0;
        const reason = attempts >= s['dispatch.maxOfferAttempts'] ? 'OFFERS_EXHAUSTED' : waitingSeconds >= s['dispatch.noRiderEscalationSeconds'] ? 'NO_RIDER_AVAILABLE' : null;
        return { id: o.id, orderNumber: o.orderNumber, status: o.status, restaurantName: o.restaurantName, attempts, waitingSeconds, reason };
      })
      .filter((o) => o.reason);
  }

  /** Starts a fresh offer round (previously-rejecting riders become eligible again). */
  async redispatch(adminId: string, orderId: string, ip?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockOrder(tx, orderId);
      const o = await tx.order.findUnique({ where: { id: orderId }, select: { status: true } });
      if (!o) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
      if (!DISPATCHABLE.includes(o.status)) throw new DomainError('NOT_DISPATCHABLE', `An order that is ${o.status} cannot be dispatched`, 409);
      await tx.deliveryAssignment.updateMany({ where: { orderId, status: AssignmentStatus.OFFERED }, data: { status: AssignmentStatus.CANCELLED, respondedAt: new Date(), rejectReason: 'Admin redispatch' } });
      await tx.order.update({ where: { id: orderId }, data: { dispatchResetAt: new Date() } });
      await this.audit.log({ actorId: adminId, action: 'dispatch.redispatch', entityType: 'Order', entityId: orderId, ip }, tx);
    });
    await this.kick(orderId);
  }

  /** Admin picks the rider directly (the rider is not asked). `replace` takes the order from its current rider. */
  async adminAssign(adminId: string, orderId: string, riderId: string, replace: boolean, ip?: string): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await this.lockOrder(tx, orderId);
      await this.lockRider(tx, riderId);
      const order = await tx.order.findUnique({ where: { id: orderId }, select: { status: true, customerId: true } });
      if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
      if (!DISPATCHABLE.includes(order.status) && order.status !== OrderStatus.RIDER_ASSIGNED) {
        throw new DomainError('NOT_DISPATCHABLE', `An order that is ${order.status} cannot be assigned`, 409);
      }
      const rider = await tx.riderProfile.findUnique({ where: { userId: riderId }, include: { user: { select: { status: true } } } });
      if (!rider || rider.approvalStatus !== 'APPROVED' || rider.user.status !== 'ACTIVE') throw new DomainError('RIDER_NOT_ELIGIBLE', 'Rider is not approved or not active', 422);

      const current = await tx.deliveryAssignment.findFirst({ where: { orderId, status: { in: LIVE } } });
      let status = order.status;
      if (current) {
        if (current.status === AssignmentStatus.ACCEPTED && !replace) throw new DomainError('ORDER_ALREADY_ASSIGNED', 'Order already has a rider. Set replace=true to reassign.', 409);
        if (current.riderId === riderId && current.status === AssignmentStatus.ACCEPTED) return; // already theirs
        status = await this.unassignInTx(tx, current.id, orderId, status, AssignmentStatus.CANCELLED, 'Reassigned by admin');
      }
      const load = await tx.deliveryAssignment.count({ where: { riderId, status: { in: LIVE } } });
      if (load >= rider.maxActiveDeliveries) throw new DomainError('RIDER_AT_CAPACITY', 'Rider is already at capacity', 409);

      const attempts = await tx.deliveryAssignment.count({ where: { orderId } });
      const a = await tx.deliveryAssignment.create({
        data: { orderId, riderId, status: AssignmentStatus.OFFERED, attempt: attempts + 1, offeredAt: now, expiresAt: now },
      });
      await this.acceptInTx(tx, a.id, orderId, riderId, order.customerId, status, now, false);
      await this.audit.log({ actorId: adminId, action: 'dispatch.admin_assign', entityType: 'Order', entityId: orderId, ip, metadata: { riderId, replace } }, tx);
    });
  }

  // ───────────────────────── internals ─────────────────────────
  /** Marks the assignment ACCEPTED, opens (or re-opens) the order chat, and joins with READY_FOR_PICKUP if the food is already ready. */
  private async acceptInTx(tx: Prisma.TransactionClient, assignmentId: string, orderId: string, riderId: string, customerId: string, orderStatus: OrderStatus, now: Date, countStat = true) {
    await tx.deliveryAssignment.update({ where: { id: assignmentId }, data: { status: AssignmentStatus.ACCEPTED, respondedAt: now } });
    if (countStat) await tx.riderProfile.update({ where: { userId: riderId }, data: { offersAccepted: { increment: 1 } } });
    // One chat room per order. A new rider re-opens it; their visibility starts at openedAt (enforced with the chat in Phase 6).
    await tx.orderChatRoom.upsert({
      where: { orderId },
      create: { orderId, assignmentId, customerId, riderId, openedAt: now },
      update: { assignmentId, riderId, customerId, openedAt: now, closedAt: null },
    });
    if (this.notifications) {
      const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { orderNumber: true, restaurant: { select: { ownerId: true } } } });
      const rider = await tx.profile.findUnique({ where: { userId: riderId }, select: { fullName: true } });
      await this.notifications.createMany(tx, riderAssignedNotifications({ id: orderId, orderNumber: o.orderNumber, customerId, ownerId: o.restaurant.ownerId, riderId }, rider?.fullName.split(' ')[0] ?? 'Your rider'));
    }
    if (orderStatus === OrderStatus.READY_FOR_PICKUP) {
      await this.transitions.applyInTx(tx, { orderId, to: OrderStatus.RIDER_ASSIGNED, actor: { role: 'SYSTEM' } });
    }
  }

  /** Ends an assignment, closes its chat, and returns the order to READY_FOR_PICKUP if it had advanced to RIDER_ASSIGNED. Returns the new order status. */
  private async unassignInTx(tx: Prisma.TransactionClient, assignmentId: string, orderId: string, orderStatus: OrderStatus, as: AssignmentStatus, reason: string): Promise<OrderStatus> {
    const now = new Date();
    await tx.deliveryAssignment.update({ where: { id: assignmentId }, data: { status: as, respondedAt: now, rejectReason: reason } });
    await tx.orderChatRoom.updateMany({ where: { orderId, closedAt: null }, data: { closedAt: now } });
    if (orderStatus === OrderStatus.RIDER_ASSIGNED) {
      await this.transitions.applyInTx(tx, { orderId, to: OrderStatus.READY_FOR_PICKUP, actor: { role: 'SYSTEM' }, reason });
      return OrderStatus.READY_FOR_PICKUP;
    }
    return orderStatus;
  }

  private async lockOrder(tx: Db, orderId: string) {
    await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${orderId}::uuid FOR UPDATE`;
  }
  private async lockRider(tx: Db, riderId: string) {
    await tx.$queryRaw`SELECT "userId" FROM "rider_profiles" WHERE "userId" = ${riderId}::uuid FOR UPDATE`;
  }
}
