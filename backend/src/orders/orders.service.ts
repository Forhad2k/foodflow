import { Order, OrderStatus, PaymentMethod, PaymentStatus, Prisma, Role } from '@prisma/client';
import { notFound } from '../common/errors/domain-error';
import { randomBytes } from 'crypto';
import type { Db } from '../common/db';
import { DomainError } from '../common/errors/domain-error';
import { CheckoutService } from '../checkout/checkout.service';
import type { NotificationService } from '../notifications/notification.service';
import { orderPlacedNotifications } from '../notifications/order-events';
import type { PaymentService } from '../payments/payment.service';
import { PrismaService } from '../prisma/prisma.service';
import { CancelOrderDto, ListOrdersDto, PlaceOrderDto } from '../schemas/orders';
import { OrderTransitionService } from './order-transition.service';
import { allowedTransitions } from './order-state-machine';
import { normalizeCouponCode } from '../checkout/coupons';

const orderDetailInclude = {
  items: { include: { addons: true }, orderBy: { id: 'asc' } },
  deliveryAddress: true,
  history: { orderBy: { createdAt: 'asc' } },
  payments: { select: { method: true, status: true, amountMinor: true, paidAt: true } },
} satisfies Prisma.OrderInclude;

type OrderDetail = Prisma.OrderGetPayload<{ include: typeof orderDetailInclude }>;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function newOrderNumber(now = new Date()): string {
  const d = now.toISOString().slice(2, 10).replace(/-/g, ''); // YYMMDD
  const rand = Array.from(randomBytes(6), (b) => CROCKFORD[b % 32]).join('');
  return `FF-${d}-${rand}`;
}
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly checkout: CheckoutService,
    private readonly transitions: OrderTransitionService,
    private readonly notifications?: NotificationService,
    private readonly payments?: PaymentService,
  ) {}

  /**
   * Places an order from the customer's cart.
   *
   * Safety properties (all inside ONE transaction):
   *  - the customer's cart row is locked → two simultaneous checkouts cannot both consume the same cart
   *  - (customerId, Idempotency-Key) is unique and re-checked under the lock → retries/double-clicks return the
   *    original order instead of creating a second one
   *  - the coupon row is locked while usage is counted → the last use cannot be redeemed twice
   *  - everything is re-priced and re-validated from current data (open, deliverable, stock, coupon, min order)
   *  - stock is decremented with a conditional UPDATE → it can never go negative
   */
  async placeOrder(userId: string, dto: PlaceOrderDto, idempotencyKey: string): Promise<{ order: ReturnType<typeof toOrderView> & { payment?: { redirectUrl: string; expiresAt: Date } }; replayed: boolean }> {
    const online = dto.paymentMethod === PaymentMethod.ONLINE;
    if (online && !this.payments?.enabled) throw new DomainError('PAYMENT_METHOD_UNAVAILABLE', 'Online payment is not available. Choose cash on delivery.', 422);

    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.cart.upsert({ where: { userId }, create: { userId }, update: {} });
        await tx.$queryRaw`SELECT id FROM "carts" WHERE "userId" = ${userId}::uuid FOR UPDATE`;

        const existing = await tx.order.findUnique({
          where: { customerId_idempotencyKey: { customerId: userId, idempotencyKey } },
          include: orderDetailInclude,
        });
        if (existing) return { order: existing, replayed: true };

        const cart = await tx.cart.findUniqueOrThrow({ where: { userId }, select: { couponCode: true } });
        const couponCode = dto.couponCode !== undefined ? dto.couponCode : cart.couponCode;
        if (couponCode) {
          await tx.$queryRaw`SELECT id FROM "coupons" WHERE code = ${normalizeCouponCode(couponCode)} FOR UPDATE`;
        }

        const c = await this.checkout.compute(tx, userId, { addressId: dto.addressId, couponCode: dto.couponCode });
        if (c.issues.length > 0) {
          throw new DomainError('CHECKOUT_BLOCKED', 'Your order cannot be placed yet', 409, { issues: c.issues });
        }

        const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { phone: true, profile: { select: { fullName: true } } } });
        const contactPhone = dto.contactPhone ?? user.phone;
        if (!contactPhone) throw new DomainError('CONTACT_PHONE_REQUIRED', 'Add a contact phone number so the rider can reach you', 422);

        // Reserve stock (only for items that track it).
        const qtyByItem = new Map<string, { qty: number; tracked: boolean }>();
        for (const l of c.lines) {
          const cur = qtyByItem.get(l.menuItemId) ?? { qty: 0, tracked: l.stockQuantity !== null };
          cur.qty += l.quantity;
          qtyByItem.set(l.menuItemId, cur);
        }
        for (const [menuItemId, { qty, tracked }] of qtyByItem) {
          if (!tracked) continue;
          const res = await tx.menuItem.updateMany({ where: { id: menuItemId, stockQuantity: { gte: qty } }, data: { stockQuantity: { decrement: qty } } });
          if (res.count !== 1) throw new DomainError('OUT_OF_STOCK', 'An item in your cart just sold out', 409, { menuItemId });
        }

        const now = new Date();
        const order = await tx.order.create({
          data: {
            orderNumber: newOrderNumber(now),
            customerId: userId,
            restaurantId: c.restaurant.id,
            status: online ? OrderStatus.PENDING_PAYMENT : OrderStatus.PLACED, // online: the restaurant sees nothing until the gateway confirms payment
            paymentMethod: dto.paymentMethod,
            idempotencyKey,
            restaurantName: c.restaurant.name,
            subtotalMinor: c.totals.subtotalMinor,
            deliveryFeeMinor: c.totals.deliveryFeeMinor,
            serviceFeeMinor: c.totals.serviceFeeMinor,
            discountMinor: c.totals.discountMinor,
            taxMinor: c.totals.taxMinor,
            totalMinor: c.totals.totalMinor,
            commissionBps: c.commissionBps,
            couponId: c.coupon?.valid ? c.coupon.row!.id : null,
            couponCode: c.coupon?.valid ? c.coupon.code : null,
            contactPhone,
            customerNote: dto.customerNote || null,
            deliveryInstructions: dto.deliveryInstructions || null,
            estimatedPrepMinutes: c.restaurant.avgPrepMinutes,
            estimatedDeliveryAt: c.delivery ? new Date(now.getTime() + c.delivery.estimatedMinutes.max * 60_000) : null,
            deliveryAddress: {
              create: {
                label: c.address.label, line1: c.address.line1, line2: c.address.line2, area: c.address.area, city: c.address.city,
                lat: c.address.lat, lng: c.address.lng, contactName: user.profile?.fullName ?? 'Customer', contactPhone,
              },
            },
            // Immutable snapshot: later menu edits never change this receipt.
            items: {
              create: c.lines.map((l) => ({
                menuItemId: l.menuItemId, nameSnapshot: l.name, variantSnapshot: l.variantName, unitPriceMinor: l.unitPriceMinor,
                quantity: l.quantity, lineTotalMinor: l.lineTotalMinor, notes: l.notes,
                addons: { create: l.addons.map((a) => ({ nameSnapshot: a.name, priceMinor: a.priceMinor, quantity: 1 })) },
              })),
            },
            history: { create: { fromStatus: null, toStatus: online ? OrderStatus.PENDING_PAYMENT : OrderStatus.PLACED, actorId: userId, actorRole: Role.CUSTOMER } },
            payments: {
              create: {
                method: dto.paymentMethod, provider: online ? this.payments!.provider!.name : 'cod', status: PaymentStatus.PENDING, amountMinor: c.totals.totalMinor,
                idempotencyKey: `order-initial:${userId}:${idempotencyKey}`,
              },
            },
          },
          include: orderDetailInclude,
        });

        if (c.coupon?.valid) await tx.couponRedemption.create({ data: { couponId: c.coupon.row!.id, userId, orderId: order.id } });
        await tx.cartItem.deleteMany({ where: { cartId: c.cartId } });
        await tx.cart.update({ where: { id: c.cartId }, data: { restaurantId: null, couponCode: null } });

        // Told in the same transaction: the restaurant hears about the order if and only if it was really placed.
        if (!online) await this.notifications?.createMany(tx, orderPlacedNotifications({ id: order.id, orderNumber: order.orderNumber, customerId: userId, ownerId: c.restaurant.ownerId }));
        return { order, replayed: false };
      },
      { maxWait: 5_000, timeout: 20_000 },
    );
    const view = toOrderView(result.order);
    if (result.order.status === OrderStatus.PENDING_PAYMENT && this.payments) {
      // Outside the transaction (it calls the gateway): open the payment and hand the customer the way to pay.
      const payment = await this.payments.start(result.order.id);
      return { order: { ...view, payment }, replayed: result.replayed };
    }
    return { order: view, replayed: result.replayed };
  }

  async list(userId: string, q: ListOrdersDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const where: Prisma.OrderWhereInput = { customerId: userId, ...(q.status && { status: q.status }) };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit,
        select: {
          id: true, orderNumber: true, status: true, restaurantId: true, restaurantName: true, totalMinor: true, paymentMethod: true, placedAt: true,
          _count: { select: { items: true } },
        },
      }),
    ]);
    return {
      items: rows.map(({ _count, ...o }) => ({ ...o, itemCount: _count.items })),
      page, limit, total,
    };
  }

  /** Also serves as the receipt. 404 (not 403) for other people's orders: existence is not revealed. */
  async get(userId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, customerId: userId }, include: orderDetailInclude });
    if (!order) throw notFound('Order not found');
    return toOrderView(order);
  }

  async cancel(userId: string, orderId: string, dto: CancelOrderDto) {
    const owned = await this.prisma.order.findFirst({ where: { id: orderId, customerId: userId }, select: { id: true } });
    if (!owned) throw notFound('Order not found');
    await this.transitions.transition({ orderId, to: OrderStatus.CANCELLED, actor: { role: Role.CUSTOMER, userId }, reason: dto.reason });
    return this.get(userId, orderId);
  }
}

/** Public shape: internal bookkeeping (version, idempotency key, commission) is not exposed to customers. */
export function toOrderView(o: OrderDetail) {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    paymentMethod: o.paymentMethod,
    restaurant: { id: o.restaurantId, name: o.restaurantName },
    currency: o.currency,
    totals: {
      subtotalMinor: o.subtotalMinor, deliveryFeeMinor: o.deliveryFeeMinor, serviceFeeMinor: o.serviceFeeMinor,
      discountMinor: o.discountMinor, taxMinor: o.taxMinor, totalMinor: o.totalMinor,
    },
    couponCode: o.couponCode,
    contactPhone: o.contactPhone,
    customerNote: o.customerNote,
    deliveryInstructions: o.deliveryInstructions,
    estimatedDeliveryAt: o.estimatedDeliveryAt,
    cancelReason: o.cancelReason,
    placedAt: o.placedAt,
    deliveryAddress: o.deliveryAddress && {
      label: o.deliveryAddress.label, line1: o.deliveryAddress.line1, line2: o.deliveryAddress.line2, area: o.deliveryAddress.area,
      city: o.deliveryAddress.city, lat: o.deliveryAddress.lat, lng: o.deliveryAddress.lng,
    },
    items: o.items.map((i) => ({
      name: i.nameSnapshot, variant: i.variantSnapshot, quantity: i.quantity, unitPriceMinor: i.unitPriceMinor, lineTotalMinor: i.lineTotalMinor,
      notes: i.notes, addons: i.addons.map((a) => ({ name: a.nameSnapshot, priceMinor: a.priceMinor })),
    })),
    timeline: o.history.map((h) => ({ from: h.fromStatus, to: h.toStatus, at: h.createdAt, reason: h.reason })),
    payments: o.payments,
    /** What this customer may do next: lets the UI show/hide the Cancel button without duplicating rules. */
    customerActions: allowedTransitions(o.status, 'CUSTOMER'),
  };
}
export type { Order };
