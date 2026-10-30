import { PaymentMethod } from '@prisma/client';
import { Router } from 'express';
import type { Container } from '../../container';
import { DomainError } from '../../common/errors/domain-error';
import { createAddressSchema, updateAddressSchema } from '../../schemas/addresses';
import { addCartItemSchema, setCouponSchema, updateCartItemSchema } from '../../schemas/cart';
import { cancelOrderSchema, listOrdersSchema, placeOrderSchema, quoteSchema } from '../../schemas/orders';
import { refundRequestSchema, reviewSchema, ticketCreateSchema, ticketReplySchema, ticketsQuery } from '../../schemas/money';
import { chatHistoryQuery, chatReadRest, chatSendRest, notificationsQuery, reportMessageSchema } from '../../schemas/realtime';
import { updateProfileSchema } from '../../schemas/users';
import { body, me, param, query } from '../validate';

/** /users/me: any authenticated role. */
export function usersRouter(c: Container) {
  const r = Router();
  r.get('/me', async (req, res) => res.json(await c.users.getMe(me(req).id)));
  r.patch('/me', async (req, res) => res.json(await c.users.updateProfile(me(req).id, body(updateProfileSchema, req))));
  return r;
}

/** /addresses: customers only. */
export function addressesRouter(c: Container) {
  const r = Router();
  r.get('/', async (req, res) => res.json(await c.addresses.list(me(req).id)));
  r.post('/', async (req, res) => res.status(201).json(await c.addresses.create(me(req).id, body(createAddressSchema, req))));
  r.patch('/:id', async (req, res) => res.json(await c.addresses.update(me(req).id, param(req), body(updateAddressSchema, req))));
  r.delete('/:id', async (req, res) => { await c.addresses.remove(me(req).id, param(req)); res.status(204).end(); });
  return r;
}

/** /cart: customers only. */
export function cartRouter(c: Container) {
  const r = Router();
  r.get('/', async (req, res) => res.json(await c.carts.getCart(me(req).id)));
  r.post('/items', async (req, res) => res.status(201).json(await c.carts.addItem(me(req).id, body(addCartItemSchema, req))));
  r.patch('/items/:id', async (req, res) => res.json(await c.carts.updateItem(me(req).id, param(req), body(updateCartItemSchema, req))));
  r.delete('/items/:id', async (req, res) => res.json(await c.carts.removeItem(me(req).id, param(req))));
  r.put('/coupon', async (req, res) => res.json(await c.carts.setCoupon(me(req).id, body(setCouponSchema, req).code)));
  r.delete('/coupon', async (req, res) => res.json(await c.carts.removeCoupon(me(req).id)));
  r.delete('/', async (req, res) => { await c.carts.clear(me(req).id); res.status(204).end(); });
  return r;
}

/** /checkout: customers only. */
export function checkoutRouter(c: Container) {
  const r = Router();
  /** Read-only preview of exactly what an order placed right now would cost, plus anything blocking it. */
  r.post('/quote', async (req, res) => {
    const dto = body(quoteSchema, req);
    const x = await c.checkout.compute(c.prisma, me(req).id, { addressId: dto.addressId, couponCode: dto.couponCode });
    res.json({
      canCheckout: x.issues.length === 0,
      restaurant: { id: x.restaurant.id, name: x.restaurant.name },
      items: x.lines.map((l) => ({ id: l.id, name: l.name, variantName: l.variantName, quantity: l.quantity, addons: l.addons, lineTotalMinor: l.lineTotalMinor, valid: l.valid })),
      totals: x.totals,
      coupon: x.coupon && { code: x.coupon.code, valid: x.coupon.valid, discountMinor: x.coupon.discountMinor, reasonCode: x.coupon.reasonCode, reason: x.coupon.reason },
      delivery: x.delivery,
      issues: x.issues,
      // Only methods that can really be processed are offered.
      paymentMethods: c.payments.enabled ? [PaymentMethod.CASH_ON_DELIVERY, PaymentMethod.ONLINE] : [PaymentMethod.CASH_ON_DELIVERY],
    });
  });
  return r;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

/** /orders: customers only. */
export function ordersRouter(c: Container) {
  const r = Router();
  /** 201 when created, 200 when the same Idempotency-Key replays an existing order. */
  r.post('/', async (req, res) => {
    const dto = body(placeOrderSchema, req);
    const key = req.header('idempotency-key');
    if (!key || !IDEMPOTENCY_KEY.test(key)) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8-100 chars: letters, digits, _ or -)', 400);
    const { order, replayed } = await c.orders.placeOrder(me(req).id, dto, key);
    res.status(replayed ? 200 : 201).json(order);
  });
  r.get('/', async (req, res) => res.json(await c.orders.list(me(req).id, query(listOrdersSchema, req))));
  r.get('/:id', async (req, res) => res.json(await c.orders.get(me(req).id, param(req))));
  r.post('/:id/cancel', async (req, res) => res.json(await c.orders.cancel(me(req).id, param(req), body(cancelOrderSchema, req))));

  r.post('/:id/review', async (req, res) => res.status(201).json(await c.reviews.create(me(req).id, param(req), body(reviewSchema, req))));
  r.post('/:id/refund-requests', async (req, res) => res.status(201).json(await c.refunds.request(me(req).id, param(req), body(refundRequestSchema, req))));
  r.get('/:id/refunds', async (req, res) => res.json(await c.refunds.listForOrder(me(req).id, param(req))));

  /** Live-tracking snapshot for page loads (the live stream itself is the `tracking:*` socket events). */
  r.get('/:id/tracking', async (req, res) => {
    const ctx = await c.tracking.authorizeViewer(me(req), param(req));
    res.json({ orderId: ctx.orderId, ...(await c.tracking.latest(ctx.orderId, ctx.assignmentId)) });
  });
  // Order chat (REST fallback for the socket events; identical rules, enforced in ChatService).
  r.get('/:id/chat/messages', async (req, res) => res.json(await c.chat.history(me(req).id, param(req), query(chatHistoryQuery, req))));
  r.post('/:id/chat/messages', async (req, res) => { const x = await c.chat.send(me(req).id, param(req), body(chatSendRest, req)); res.status(x.duplicate ? 200 : 201).json(x.message); });
  r.post('/:id/chat/read', async (req, res) => res.json(await c.chat.markRead(me(req).id, param(req), body(chatReadRest, req).upToMessageId)));
  r.post('/:id/chat/messages/:messageId/report', async (req, res) => res.status(201).json(await c.chat.report(me(req).id, param(req), param(req, 'messageId'), body(reportMessageSchema, req).reason)));
  return r;
}

/** /notifications: any authenticated role sees only their own. */
export function notificationsRouter(c: Container) {
  const r = Router();
  r.get('/', async (req, res) => res.json(await c.notifications.list(me(req).id, query(notificationsQuery, req))));
  r.get('/unread-count', async (req, res) => res.json({ unreadCount: await c.notifications.unreadCount(me(req).id) }));
  r.post('/read-all', async (req, res) => res.json(await c.notifications.markAllRead(me(req).id)));
  r.post('/:id/read', async (req, res) => res.json(await c.notifications.markRead(me(req).id, param(req))));
  return r;
}

/** /support: any signed-in role can raise and follow their own tickets (order issues, missing items, complaints, disputes). */
export function supportRouter(c: Container) {
  const r = Router();
  r.post('/tickets', async (req, res) => res.status(201).json(await c.support.create(me(req), body(ticketCreateSchema, req))));
  r.get('/tickets', async (req, res) => res.json(await c.support.mine(me(req).id, query(ticketsQuery, req))));
  r.get('/tickets/:id', async (req, res) => res.json(await c.support.getMine(me(req).id, param(req))));
  r.post('/tickets/:id/messages', async (req, res) => res.status(201).json(await c.support.reply(me(req).id, param(req), body(ticketReplySchema, req).body)));
  r.post('/tickets/:id/close', async (req, res) => res.json(await c.support.close(me(req).id, param(req))));
  return r;
}
