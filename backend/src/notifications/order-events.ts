import { NotificationType, OrderStatus, Prisma, Role } from '@prisma/client';

export interface OrderRef {
  id: string;
  orderNumber: string;
  customerId: string;
  ownerId: string;
  riderId?: string | null;
}
export interface NotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Prisma.InputJsonValue;
}

const S = OrderStatus;

/** Who hears about an order status change, and what they are told. Pure, so the wording and recipients are unit-tested. */
export function orderStatusNotifications(o: OrderRef, from: OrderStatus | null, to: OrderStatus, actor: Role | 'SYSTEM' | null, reason?: string | null): NotificationInput[] {
  const data = { orderId: o.id, orderNumber: o.orderNumber, status: to };
  const n = `#${o.orderNumber}`;
  const toCustomer = (title: string, body: string, type: NotificationType = NotificationType.ORDER_UPDATE): NotificationInput[] => [{ userId: o.customerId, type, title, body, data }];
  const because = reason ? ` Reason: ${reason}` : '';

  switch (to) {
    case S.PLACED:
      return from === S.PENDING_PAYMENT ? orderPlacedNotifications(o) : []; // cash orders are announced by checkout itself
    case S.RESTAURANT_ACCEPTED:
      return toCustomer('Order accepted', `The restaurant accepted order ${n}.`);
    case S.REJECTED_BY_RESTAURANT:
      return toCustomer('Order declined', `The restaurant could not take order ${n}.${because}`);
    case S.PREPARING:
      return toCustomer('Preparing your food', `Order ${n} is being prepared.`);
    case S.READY_FOR_PICKUP:
      return from === S.PREPARING ? toCustomer('Food is ready', `Order ${n} is ready and waiting for the rider.`) : [];
    case S.PICKED_UP:
      return toCustomer('Rider picked up your order', `Order ${n} is with your rider.`);
    case S.ON_THE_WAY:
      return toCustomer('On the way', `Your rider is on the way with order ${n}.`);
    case S.DELIVERED:
      return toCustomer('Delivered', `Order ${n} was delivered. Enjoy! You can now rate it.`);
    case S.PAYMENT_FAILED:
      return toCustomer('Payment failed', `Payment for order ${n} did not go through.`, NotificationType.PAYMENT);
    case S.DELIVERY_FAILED:
      return [
        ...toCustomer('Delivery failed', `We could not deliver order ${n}.${because}`),
        { userId: o.ownerId, type: NotificationType.ORDER_UPDATE, title: 'Delivery failed', body: `Order ${n} could not be delivered.${because}`, data },
      ];
    case S.CANCELLED: {
      // tell everyone involved except the person who did it
      const msg = `Order ${n} was cancelled.${because}`;
      const out: NotificationInput[] = [];
      if (actor !== Role.CUSTOMER) out.push({ userId: o.customerId, type: NotificationType.ORDER_UPDATE, title: 'Order cancelled', body: msg, data });
      if (actor !== Role.RESTAURANT_OWNER) out.push({ userId: o.ownerId, type: NotificationType.ORDER_UPDATE, title: 'Order cancelled', body: msg, data });
      if (o.riderId) out.push({ userId: o.riderId, type: NotificationType.ASSIGNMENT, title: 'Delivery cancelled', body: msg, data });
      return out;
    }
    default:
      return [];
  }
}

export function orderPlacedNotifications(o: OrderRef): NotificationInput[] {
  const data = { orderId: o.id, orderNumber: o.orderNumber, status: OrderStatus.PLACED };
  return [
    { userId: o.ownerId, type: NotificationType.ORDER_UPDATE, title: 'New order', body: `Order #${o.orderNumber} is waiting for you to accept it.`, data },
    { userId: o.customerId, type: NotificationType.ORDER_UPDATE, title: 'Order placed', body: `We sent order #${o.orderNumber} to the restaurant.`, data },
  ];
}

export function riderAssignedNotifications(o: OrderRef, riderFirstName: string): NotificationInput[] {
  const data = { orderId: o.id, orderNumber: o.orderNumber };
  return [
    { userId: o.customerId, type: NotificationType.ASSIGNMENT, title: 'Rider assigned', body: `${riderFirstName} will deliver order #${o.orderNumber}. You can chat from the order page.`, data },
    { userId: o.ownerId, type: NotificationType.ASSIGNMENT, title: 'Rider assigned', body: `A rider accepted the delivery for order #${o.orderNumber}.`, data },
  ];
}

export function offerNotification(riderId: string, orderNumber: string, offerId: string, expiresAt: Date): NotificationInput {
  return { userId: riderId, type: NotificationType.ASSIGNMENT, title: 'New delivery offer', body: `Order #${orderNumber} needs a rider. Respond before it expires.`, data: { offerId, expiresAt: expiresAt.toISOString() } };
}
