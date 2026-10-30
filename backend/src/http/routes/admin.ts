import { Router } from 'express';
import type { Container } from '../../container';
import { adminListRestaurantsSchema, adminListRidersSchema, assignRiderSchema, reasonSchema, reviewDocumentSchema, setCommissionSchema } from '../../schemas/admin';
import { adminReportsQuery, reviewReportSchema } from '../../schemas/realtime';
import {
  activeSchema, adminCouponCreateSchema, adminReplySchema, adminTicketsQuery, adminUsersQuery, assignSchema, auditQuery, couponUpdateSchema, couponsQuery, markPaidSchema, markProcessedSchema,
  payoutGenerateSchema, payoutsQuery, promoBroadcastSchema, reconcileQuery, refundReviewSchema, refundsQuery, serviceAreaSchema, settingSchema, ticketStatusSchema, userStatusSchema,
} from '../../schemas/money';
import { body, me, param, query } from '../validate';

/** /admin/*: admins only. Every state change runs in a transaction together with its audit-log row. */
export function adminRouter(c: Container) {
  const r = Router();

  r.get('/restaurants', async (req, res) => res.json(await c.adminRestaurants.list(query(adminListRestaurantsSchema, req))));
  r.get('/restaurants/:id', async (req, res) => res.json(await c.adminRestaurants.get(param(req))));
  r.post('/restaurants/:id/approve', async (req, res) => res.json(await c.adminRestaurants.act(me(req).id, param(req), 'approve', undefined, req.ip)));
  r.post('/restaurants/:id/reject', async (req, res) => res.json(await c.adminRestaurants.act(me(req).id, param(req), 'reject', body(reasonSchema, req).reason, req.ip)));
  r.post('/restaurants/:id/suspend', async (req, res) => res.json(await c.adminRestaurants.act(me(req).id, param(req), 'suspend', body(reasonSchema, req).reason, req.ip)));
  r.post('/restaurants/:id/reinstate', async (req, res) => res.json(await c.adminRestaurants.act(me(req).id, param(req), 'reinstate', undefined, req.ip)));
  r.patch('/restaurants/:id/commission', async (req, res) => res.json(await c.adminRestaurants.setCommission(me(req).id, param(req), body(setCommissionSchema, req).commissionBps ?? null, req.ip)));

  r.get('/riders', async (req, res) => res.json(await c.adminRiders.list(query(adminListRidersSchema, req))));
  r.get('/riders/:id', async (req, res) => res.json(await c.adminRiders.get(param(req))));
  r.get('/riders/:id/documents/:docId/url', async (req, res) => res.json(await c.adminRiders.documentPreviewUrl(param(req), param(req, 'docId'))));
  r.post('/riders/:id/documents/:docId/review', async (req, res) => res.json(await c.adminRiders.reviewDocument(me(req).id, param(req), param(req, 'docId'), body(reviewDocumentSchema, req), req.ip)));
  r.post('/riders/:id/approve', async (req, res) => res.json(await c.adminRiders.act(me(req).id, param(req), 'approve', undefined, req.ip)));
  r.post('/riders/:id/reject', async (req, res) => res.json(await c.adminRiders.act(me(req).id, param(req), 'reject', body(reasonSchema, req).reason, req.ip)));
  r.post('/riders/:id/suspend', async (req, res) => res.json(await c.adminRiders.act(me(req).id, param(req), 'suspend', body(reasonSchema, req).reason, req.ip)));
  r.post('/riders/:id/reinstate', async (req, res) => res.json(await c.adminRiders.act(me(req).id, param(req), 'reinstate', undefined, req.ip)));

  /** Orders that need a human because no rider could be found. */
  r.get('/dispatch/stuck', async (_req, res) => res.json(await c.dispatch.stuckOrders()));
  r.post('/dispatch/orders/:id/redispatch', async (req, res) => { await c.dispatch.redispatch(me(req).id, param(req), req.ip); res.status(204).end(); });
  r.post('/dispatch/orders/:id/assign', async (req, res) => {
    const dto = body(assignRiderSchema, req);
    await c.dispatch.adminAssign(me(req).id, param(req), dto.riderId, dto.replace ?? false, req.ip);
    res.status(204).end();
  });

  /** Abuse reports on order chats: admins see only reported messages, never browse conversations. */
  r.get('/chat-reports', async (req, res) => res.json(await c.chat.listReports(query(adminReportsQuery, req))));
  r.post('/chat-reports/:id/review', async (req, res) => res.json(await c.chat.reviewReport(me(req).id, param(req), body(reviewReportSchema, req).status, req.ip)));
  r.get('/orders/:id/tracking', async (req, res) => {
    const ctx = await c.tracking.authorizeViewer(me(req), param(req));
    res.json({ orderId: ctx.orderId, ...(await c.tracking.latest(ctx.orderId, ctx.assignmentId)) });
  });

  // ── money ──
  r.get('/refunds', async (req, res) => res.json(await c.refunds.listAll(query(refundsQuery, req))));
  r.post('/refunds/:id/review', async (req, res) => res.json(await c.refunds.review(me(req).id, param(req), body(refundReviewSchema, req), req.ip)));
  r.post('/refunds/:id/mark-processed', async (req, res) => res.json(await c.refunds.markProcessed(me(req).id, param(req), body(markProcessedSchema, req).reference, req.ip)));
  r.get('/payouts', async (req, res) => res.json(await c.payouts.list(query(payoutsQuery, req))));
  r.post('/payouts/generate', async (req, res) => { const d = body(payoutGenerateSchema, req); res.status(201).json(await c.payouts.generate(me(req).id, d.periodStart, d.periodEnd, req.ip)); });
  r.post('/payouts/:id/mark-paid', async (req, res) => res.json(await c.payouts.markPaid(me(req).id, param(req), body(markPaidSchema, req).reference, req.ip)));
  r.get('/reconciliation', async (req, res) => { const q = query(reconcileQuery, req); res.json(await c.payouts.reconcile(q.from, q.to)); });

  // ── promotions ──
  r.get('/coupons', async (req, res) => res.json(await c.coupons.list({ all: true }, query(couponsQuery, req))));
  r.post('/coupons', async (req, res) => { const { restaurantId, ...dto } = body(adminCouponCreateSchema, req); res.status(201).json(await c.coupons.create({ id: me(req).id, role: 'ADMIN' }, { restaurantId }, dto)); });
  r.patch('/coupons/:id', async (req, res) => res.json(await c.coupons.update({ id: me(req).id, role: 'ADMIN' }, {}, param(req), body(couponUpdateSchema, req))));
  r.post('/promotions/broadcast', async (req, res) => res.json(await c.adminPlatform.broadcastPromotion(me(req).id, body(promoBroadcastSchema, req), req.ip)));

  // ── support & disputes ──
  r.get('/support/tickets', async (req, res) => res.json(await c.support.adminList(query(adminTicketsQuery, req))));
  r.get('/support/tickets/:id', async (req, res) => res.json(await c.support.adminGet(param(req))));
  r.post('/support/tickets/:id/messages', async (req, res) => res.status(201).json(await c.support.adminReply(me(req).id, param(req), body(adminReplySchema, req))));
  r.post('/support/tickets/:id/assign', async (req, res) => res.json(await c.support.assign(me(req).id, param(req), body(assignSchema, req).assigneeId, req.ip)));
  r.post('/support/tickets/:id/status', async (req, res) => { const d = body(ticketStatusSchema, req); res.json(await c.support.setStatus(me(req).id, param(req), d.status, d.resolution, req.ip)); });

  // ── users, statistics, audit trail, platform configuration ──
  r.get('/users', async (req, res) => res.json(await c.adminPlatform.listUsers(query(adminUsersQuery, req))));
  r.get('/users/:id', async (req, res) => res.json(await c.adminPlatform.getUser(param(req))));
  r.post('/users/:id/status', async (req, res) => { const d = body(userStatusSchema, req); res.json(await c.adminPlatform.setUserStatus(me(req).id, param(req), d.status, d.reason, req.ip)); });
  r.get('/stats', async (_req, res) => res.json(await c.adminPlatform.stats()));
  r.get('/audit-logs', async (req, res) => res.json(await c.adminPlatform.auditLogs(query(auditQuery, req))));
  r.get('/settings', async (_req, res) => res.json(await c.adminPlatform.getSettings()));
  r.put('/settings', async (req, res) => { const d = body(settingSchema, req); res.json(await c.adminPlatform.setSetting(me(req).id, d.key, d.value, req.ip)); });
  r.get('/service-areas', async (_req, res) => res.json(await c.adminPlatform.listServiceAreas()));
  r.post('/service-areas', async (req, res) => res.status(201).json(await c.adminPlatform.createServiceArea(me(req).id, body(serviceAreaSchema, req), req.ip)));
  r.post('/service-areas/:id/active', async (req, res) => res.json(await c.adminPlatform.setServiceAreaActive(me(req).id, param(req), body(activeSchema, req).isActive, req.ip)));
  r.delete('/service-areas/:id', async (req, res) => { await c.adminPlatform.deleteServiceArea(me(req).id, param(req), req.ip); res.status(204).end(); });
  return r;
}
