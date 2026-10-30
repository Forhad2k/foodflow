import { AssignmentStatus, Order, OrderStatus, PaymentMethod, PaymentStatus, Prisma, Role } from '@prisma/client';
import { notFound } from '../common/errors/domain-error';
import { DomainError } from '../common/errors/domain-error';
import { PrismaService } from '../prisma/prisma.service';
import type { NotificationService } from '../notifications/notification.service';
import { orderStatusNotifications } from '../notifications/order-events';
import { autoRefundInTx, settleDeliveredInTx } from '../payments/ledger';
import { assertTransition, isTerminal, TransitionActor } from './order-state-machine';

export interface TransitionRequest {
  orderId: string;
  to: OrderStatus;
  actor: { role: Role | 'SYSTEM'; userId?: string };
  reason?: string;
  /** Extra order fields set atomically with the transition (e.g. the restaurant's prep estimate on accept). */
  patch?: { estimatedPrepMinutes?: number };
}

const ROLE_TO_ACTOR: Record<Role, TransitionActor> = {
  CUSTOMER: 'CUSTOMER',
  RESTAURANT_OWNER: 'RESTAURANT',
  RIDER: 'RIDER',
  ADMIN: 'ADMIN',
};

/** Which timestamp column each status stamps. */
const STATUS_TIMESTAMP: Partial<Record<OrderStatus, keyof Prisma.OrderUpdateInput>> = {
  RESTAURANT_ACCEPTED: 'acceptedAt',
  READY_FOR_PICKUP: 'readyAt',
  PICKED_UP: 'pickedUpAt',
  DELIVERED: 'deliveredAt',
  CANCELLED: 'cancelledAt',
};

/**
 * The only code path allowed to change Order.status.
 * One transaction does: lock row → validate (machine + ownership + preconditions) → update with optimistic
 * version check → append history → close dependents on terminal states.
 */
export class OrderTransitionService {
  constructor(private readonly prisma: PrismaService, private readonly notifications?: NotificationService) {}

  /** Runs the transition in its own transaction. */
  transition(req: TransitionRequest): Promise<Order> {
    return this.prisma.$transaction((tx) => this.applyInTx(tx, req));
  }

  /**
   * Same transition inside a caller's transaction, so callers (dispatch accept/release…) can change the order and
   * their own rows atomically. Callers must take row locks in the order: order row first, then rider row.
   */
  async applyInTx(tx: Prisma.TransactionClient, req: TransitionRequest): Promise<Order> {
    {
      // Serialise concurrent transitions on the same order.
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${req.orderId}::uuid FOR UPDATE`;

      const order = await tx.order.findUnique({
        where: { id: req.orderId },
        include: {
          restaurant: { select: { ownerId: true } },
          assignments: { where: { status: AssignmentStatus.ACCEPTED }, select: { id: true, riderId: true } },
        },
      });
      if (!order) throw notFound('Order not found');

      const actor: TransitionActor = req.actor.role === 'SYSTEM' ? 'SYSTEM' : ROLE_TO_ACTOR[req.actor.role];
      const rule = assertTransition(order.status, req.to, actor, req.reason);

      // Object-level authorization: being the right *role* is not enough, the actor must own this order.
      this.assertOwnership(actor, req.actor.userId, order);

      if (rule.precondition === 'ACCEPTED_ASSIGNMENT' && order.assignments.length === 0) {
        throw new DomainError('NO_ACCEPTED_ASSIGNMENT', 'A rider must accept the delivery first', 409);
      }

      const now = new Date();
      const stamp = STATUS_TIMESTAMP[req.to];
      const updated = await tx.order.updateMany({
        where: { id: order.id, version: order.version, status: order.status },
        data: {
          status: req.to,
          version: { increment: 1 },
          ...(stamp && { [stamp]: now }),
          ...(req.patch?.estimatedPrepMinutes !== undefined && {
            estimatedPrepMinutes: req.patch.estimatedPrepMinutes,
            // keep the customer's promised delivery time consistent with the restaurant's estimate
            ...(order.estimatedDeliveryAt && {
              estimatedDeliveryAt: new Date(order.estimatedDeliveryAt.getTime() + (req.patch.estimatedPrepMinutes - (order.estimatedPrepMinutes ?? req.patch.estimatedPrepMinutes)) * 60_000),
            }),
          }),
          ...(req.to === OrderStatus.CANCELLED && {
            cancelReason: req.reason?.trim() ?? null,
            cancelledByRole: req.actor.role === 'SYSTEM' ? null : req.actor.role,
          }),
        },
      });
      if (updated.count !== 1) {
        throw new DomainError('ORDER_CHANGED', 'The order was modified by someone else. Reload and retry.', 409);
      }

      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: order.status,
          toStatus: req.to,
          actorId: req.actor.userId ?? null,
          actorRole: req.actor.role === 'SYSTEM' ? null : req.actor.role,
          reason: req.reason?.trim() || null,
        },
      });

      // Told in the SAME transaction: the notification exists if and only if the status change committed.
      if (this.notifications) {
        const riderId = order.assignments[0]?.riderId ?? null;
        await this.notifications.createMany(
          tx,
          orderStatusNotifications({ id: order.id, orderNumber: order.orderNumber, customerId: order.customerId, ownerId: order.restaurant.ownerId, riderId }, order.status, req.to, req.actor.role, req.reason?.trim()),
        );
      }

      if (isTerminal(req.to)) await this.closeDependents(tx, order.id, req.to, now);

      // The join point of "food ready" and "rider accepted": whichever happens second moves the order to RIDER_ASSIGNED.
      if (req.to === OrderStatus.READY_FOR_PICKUP && order.assignments.length > 0) {
        await this.applyInTx(tx, { orderId: order.id, to: OrderStatus.RIDER_ASSIGNED, actor: { role: 'SYSTEM' } });
      }

      // Phase 6: write an outbox row here so notifications + socket broadcasts fire after commit.
      return tx.order.findUniqueOrThrow({ where: { id: order.id } });
    }
  }

  private assertOwnership(
    actor: TransitionActor,
    userId: string | undefined,
    order: { customerId: string; restaurant: { ownerId: string }; assignments: { riderId: string }[] },
  ) {
    const deny = () => new DomainError('NOT_ORDER_PARTICIPANT', 'You are not allowed to act on this order', 403);
    switch (actor) {
      case 'CUSTOMER':
        if (!userId || order.customerId !== userId) throw deny();
        break;
      case 'RESTAURANT':
        if (!userId || order.restaurant.ownerId !== userId) throw deny();
        break;
      case 'RIDER':
        if (!userId || !order.assignments.some((a) => a.riderId === userId)) throw deny();
        break;
      default: // ADMIN and SYSTEM are authorised by role/origin alone
        break;
    }
  }

  /** Terminal order → settle live assignment and make the chat room read-only. */
  private async closeDependents(tx: Prisma.TransactionClient, orderId: string, to: OrderStatus, now: Date) {
    const assignmentOutcome: AssignmentStatus =
      to === OrderStatus.DELIVERED ? AssignmentStatus.COMPLETED : to === OrderStatus.DELIVERY_FAILED ? AssignmentStatus.FAILED : AssignmentStatus.CANCELLED;
    await tx.deliveryAssignment.updateMany({
      where: { orderId, status: { in: [AssignmentStatus.OFFERED, AssignmentStatus.ACCEPTED] } },
      data: { status: assignmentOutcome, respondedAt: now },
    });
    await tx.orderChatRoom.updateMany({ where: { orderId, closedAt: null }, data: { closedAt: now } });

    // Orders that never reach the customer give back what they reserved (food was never made/sent).
    const undone: OrderStatus[] = [OrderStatus.CANCELLED, OrderStatus.REJECTED_BY_RESTAURANT, OrderStatus.PAYMENT_FAILED];
    if (undone.includes(to)) {
      const items = await tx.orderItem.findMany({ where: { orderId, menuItemId: { not: null } }, select: { menuItemId: true, quantity: true } });
      for (const it of items) {
        // stockQuantity NULL means "unlimited": the `not: null` filter leaves those rows untouched.
        await tx.menuItem.updateMany({ where: { id: it.menuItemId!, stockQuantity: { not: null } }, data: { stockQuantity: { increment: it.quantity } } });
      }
      await tx.couponRedemption.deleteMany({ where: { orderId } }); // frees the coupon use
      if (to !== OrderStatus.PAYMENT_FAILED) {
        // (PAYMENT_FAILED is settled by the payments module in Phase 7.)
        await tx.payment.updateMany({ where: { orderId, status: PaymentStatus.PENDING }, data: { status: PaymentStatus.CANCELLED } });
      }
    }
    // Paid online but the order did not complete: refund in full, atomically with the status change.
    if (to === OrderStatus.CANCELLED || to === OrderStatus.REJECTED_BY_RESTAURANT || to === OrderStatus.DELIVERY_FAILED) {
      await autoRefundInTx(tx, orderId, `Order ${to.toLowerCase().replace(/_/g, ' ')}`, now);
    }
    if (to === OrderStatus.DELIVERED) {
      await settleDeliveredInTx(tx, orderId); // earnings for the restaurant and the rider commit together with DELIVERED
      // Cash is collected at the door: the COD payment becomes successful when the rider completes delivery.
      await tx.payment.updateMany({
        where: { orderId, method: PaymentMethod.CASH_ON_DELIVERY, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.SUCCESSFUL, paidAt: now },
      });
    }
  }
}
