import { DispatchService } from '../dispatch/dispatch.service';
import { notFound } from '../common/errors/domain-error';
import { AssignmentStatus, OrderStatus, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { allowedTransitions, TERMINAL_STATUSES } from '../orders/order-state-machine';
import { OrderTransitionService } from '../orders/order-transition.service';
import { AcceptOrderDto, ListOwnerOrdersDto } from '../schemas/owner-orders';
import { RestaurantAccessService } from './restaurant-access.service';

const ACTIVE: OrderStatus[] = [
  OrderStatus.PLACED, OrderStatus.RESTAURANT_ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY_FOR_PICKUP,
  OrderStatus.RIDER_ASSIGNED, OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY,
];
// Orders awaiting online payment (PENDING_PAYMENT) are not the restaurant's concern until they are PLACED.
const HISTORY: OrderStatus[] = [...TERMINAL_STATUSES].filter((s) => s !== OrderStatus.PAYMENT_FAILED);

const kitchenItems = { select: { nameSnapshot: true, variantSnapshot: true, quantity: true, notes: true, addons: { select: { nameSnapshot: true } } }, orderBy: { id: 'asc' } } satisfies Prisma.Order$itemsArgs;
export class OwnerOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: RestaurantAccessService,
    private readonly transitions: OrderTransitionService,
    private readonly dispatch?: DispatchService,
  ) {}

  async list(ownerId: string, restaurantId: string, q: ListOwnerOrdersDto) {
    await this.access.assertOwner(ownerId, restaurantId);
    const scope = q.scope ?? 'active';
    const pool = scope === 'active' ? ACTIVE : HISTORY;
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const where: Prisma.OrderWhereInput = { restaurantId, status: q.status && pool.includes(q.status) ? q.status : { in: pool } };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: [{ placedAt: scope === 'active' ? 'asc' : 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, orderNumber: true, status: true, placedAt: true, subtotalMinor: true, paymentMethod: true, customerNote: true,
          estimatedPrepMinutes: true, items: kitchenItems,
        },
      }),
    ]);
    return { items: rows.map((o) => ({ ...o, restaurantActions: allowedTransitions(o.status, 'RESTAURANT') })), page, limit, total };
  }

  /** Kitchen view: what to cook and when. Customer phone and address are deliberately NOT included. */
  async get(ownerId: string, restaurantId: string, orderId: string) {
    await this.access.assertOwner(ownerId, restaurantId);
    const o = await this.prisma.order.findFirst({
      where: { id: orderId, restaurantId, status: { not: OrderStatus.PENDING_PAYMENT } },
      select: {
        id: true, orderNumber: true, status: true, placedAt: true, subtotalMinor: true, paymentMethod: true, customerNote: true,
        estimatedPrepMinutes: true, cancelReason: true, items: { ...kitchenItems, select: { ...kitchenItems.select, unitPriceMinor: true, lineTotalMinor: true } },
        customer: { select: { profile: { select: { fullName: true } } } },
        history: { orderBy: { createdAt: 'asc' }, select: { fromStatus: true, toStatus: true, createdAt: true, reason: true } },
        assignments: { where: { status: AssignmentStatus.ACCEPTED }, select: { id: true } },
      },
    });
    if (!o) throw notFound('Order not found');
    const { customer, assignments, history, ...rest } = o;
    return {
      ...rest,
      customerFirstName: customer.profile?.fullName.split(' ')[0] ?? 'Customer',
      riderAssigned: assignments.length > 0,
      timeline: history.map((h) => ({ from: h.fromStatus, to: h.toStatus, at: h.createdAt, reason: h.reason })),
      restaurantActions: allowedTransitions(o.status, 'RESTAURANT'),
    };
  }

  async accept(ownerId: string, rid: string, orderId: string, dto: AcceptOrderDto) {
    const view = await this.act(ownerId, rid, orderId, OrderStatus.RESTAURANT_ACCEPTED, undefined, dto.prepMinutes);
    void this.dispatch?.kick(orderId); // start finding a rider right away; the periodic sweep is the safety net
    return view;
  }
  reject(ownerId: string, rid: string, orderId: string, reason: string) {
    return this.act(ownerId, rid, orderId, OrderStatus.REJECTED_BY_RESTAURANT, reason);
  }
  startPreparing(ownerId: string, rid: string, orderId: string) {
    return this.act(ownerId, rid, orderId, OrderStatus.PREPARING);
  }
  markReady(ownerId: string, rid: string, orderId: string) {
    return this.act(ownerId, rid, orderId, OrderStatus.READY_FOR_PICKUP);
  }
  cancel(ownerId: string, rid: string, orderId: string, reason: string) {
    return this.act(ownerId, rid, orderId, OrderStatus.CANCELLED, reason);
  }

  /** The order must belong to THIS restaurant AND the restaurant to this owner; the state machine does the rest. */
  private async act(ownerId: string, restaurantId: string, orderId: string, to: OrderStatus, reason?: string, prepMinutes?: number) {
    await this.access.assertOwner(ownerId, restaurantId);
    const exists = await this.prisma.order.findFirst({ where: { id: orderId, restaurantId }, select: { id: true } });
    if (!exists) throw notFound('Order not found');
    await this.transitions.transition({
      orderId, to, actor: { role: Role.RESTAURANT_OWNER, userId: ownerId }, reason,
      patch: prepMinutes !== undefined ? { estimatedPrepMinutes: prepMinutes } : undefined,
    });
    return this.get(ownerId, restaurantId, orderId);
  }
}
