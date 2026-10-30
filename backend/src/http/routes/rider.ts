import { OrderStatus } from '@prisma/client';
import { Router } from 'express';
import type { Container } from '../../container';
import { presenceSchema, reasonBodySchema, rejectOfferSchema, riderHistorySchema, setStatusSchema, submitDocumentSchema, updateVehicleSchema } from '../../schemas/riders';
import { chatHistoryQuery, chatReadRest, chatSendRest, reportMessageSchema } from '../../schemas/realtime';
import { earningsQuery } from '../../schemas/money';
import { limit } from '../middleware';
import { body, me, param, query } from '../validate';

/** /rider/*: riders only. */
export function riderRouter(c: Container, rate: boolean) {
  const r = Router();
  const id = (req: Parameters<typeof me>[0]) => me(req).id;

  r.get('/me', async (req, res) => res.json(await c.riders.me(id(req))));
  r.put('/vehicle', async (req, res) => res.json(await c.riders.updateVehicle(id(req), body(updateVehicleSchema, req))));
  r.post('/documents/upload-signature', limit(rate, 5), async (req, res) => res.json(await c.riders.createDocumentUploadSignature(id(req))));
  r.put('/documents', async (req, res) => res.json(await c.riders.submitDocument(id(req), body(submitDocumentSchema, req))));
  r.post('/resubmit', async (req, res) => res.json(await c.riders.resubmit(id(req))));

  r.put('/status', async (req, res) => res.json(await c.riders.setStatus(id(req), body(setStatusSchema, req))));
  r.post('/presence', limit(rate, 40), async (req, res) => res.json(await c.riders.presence(id(req), body(presenceSchema, req))));

  r.get('/offers', async (req, res) => res.json(await c.riders.offers(id(req))));
  r.post('/offers/:id/accept', async (req, res) => res.json(await c.riders.accept(id(req), param(req))));
  r.post('/offers/:id/reject', async (req, res) => { await c.riders.reject(id(req), param(req), body(rejectOfferSchema, req).reason); res.status(204).end(); });

  r.get('/deliveries/active', async (req, res) => res.json(await c.riders.activeDeliveries(id(req))));
  r.get('/deliveries/history', async (req, res) => res.json(await c.riders.history(id(req), query(riderHistorySchema, req))));
  r.get('/deliveries/:orderId', async (req, res) => res.json(await c.riders.deliveryByOrder(id(req), param(req, 'orderId'))));
  const step = (to: OrderStatus, needsReason = false) => async (req: Parameters<typeof me>[0], res: import('express').Response) => {
    const reason = needsReason ? body(reasonBodySchema, req).reason : undefined;
    res.json(await c.riders.step(id(req), param(req, 'orderId'), to, reason));
  };
  r.post('/deliveries/:orderId/pickup', step(OrderStatus.PICKED_UP));
  r.post('/deliveries/:orderId/on-the-way', step(OrderStatus.ON_THE_WAY));
  r.post('/deliveries/:orderId/delivered', step(OrderStatus.DELIVERED));
  r.post('/deliveries/:orderId/failed', step(OrderStatus.DELIVERY_FAILED, true));
  r.post('/deliveries/:orderId/release', async (req, res) => { await c.riders.release(id(req), param(req, 'orderId'), body(reasonBodySchema, req).reason); res.status(204).end(); });

  // Chat with the customer of a delivery you currently hold (REST fallback for the socket events).
  const chat = '/deliveries/:orderId/chat';
  r.get(`${chat}/messages`, async (req, res) => res.json(await c.chat.history(id(req), param(req, 'orderId'), query(chatHistoryQuery, req))));
  r.post(`${chat}/messages`, async (req, res) => { const x = await c.chat.send(id(req), param(req, 'orderId'), body(chatSendRest, req)); res.status(x.duplicate ? 200 : 201).json(x.message); });
  r.post(`${chat}/read`, async (req, res) => res.json(await c.chat.markRead(id(req), param(req, 'orderId'), body(chatReadRest, req).upToMessageId)));
  r.post(`${chat}/messages/:messageId/report`, async (req, res) => res.status(201).json(await c.chat.report(id(req), param(req, 'orderId'), param(req, 'messageId'), body(reportMessageSchema, req).reason)));
  r.get('/deliveries/:orderId/tracking', async (req, res) => {
    const ctx = await c.tracking.authorizeViewer(me(req), param(req, 'orderId'));
    res.json({ orderId: ctx.orderId, ...(await c.tracking.latest(ctx.orderId, ctx.assignmentId)) });
  });

  // Money: what you earned, the cash you collected on delivery and owe back, and your payouts (negative = you owe the platform).
  r.get('/earnings', async (req, res) => res.json(await c.payouts.riderEarnings(id(req), query(earningsQuery, req))));
  r.get('/payouts', async (req, res) => res.json(await c.payouts.payoutsFor(id(req))));
  return r;
}
