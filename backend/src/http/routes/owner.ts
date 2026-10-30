import { Router } from 'express';
import type { Container } from '../../container';
import { categorySchema, createItemSchema, itemAvailabilitySchema, syncAddonGroupsSchema, syncVariantsSchema, updateCategorySchema, updateItemSchema } from '../../schemas/menu';
import { acceptOrderSchema, listOwnerOrdersSchema, orderReasonSchema } from '../../schemas/owner-orders';
import { createRestaurantSchema, createZoneSchema, setAvailabilitySchema, setHoursSchema, statsQuerySchema, updateRestaurantSchema, updateZoneSchema } from '../../schemas/restaurants';
import { couponCreateSchema, couponUpdateSchema, couponsQuery, earningsQuery, reviewsQuery } from '../../schemas/money';
import { body, me, param, query } from '../validate';

/** /owner/*: restaurant owners only. Every call is scoped to a restaurant the caller owns (404 otherwise). */
export function ownerRouter(c: Container) {
  const r = Router();
  const owner = (req: Parameters<typeof me>[0]) => me(req).id;

  // ── restaurant ──
  r.get('/restaurants', async (req, res) => res.json(await c.ownerRestaurants.list(owner(req))));
  r.post('/restaurants', async (req, res) => res.status(201).json(await c.ownerRestaurants.create(owner(req), body(createRestaurantSchema, req))));
  r.get('/restaurants/:id', async (req, res) => res.json(await c.ownerRestaurants.get(owner(req), param(req))));
  r.patch('/restaurants/:id', async (req, res) => res.json(await c.ownerRestaurants.update(owner(req), param(req), body(updateRestaurantSchema, req))));
  r.patch('/restaurants/:id/availability', async (req, res) => res.json(await c.ownerRestaurants.setPaused(owner(req), param(req), body(setAvailabilitySchema, req).isPaused)));
  r.post('/restaurants/:id/resubmit', async (req, res) => res.json(await c.ownerRestaurants.resubmit(owner(req), param(req))));
  r.put('/restaurants/:id/hours', async (req, res) => res.json(await c.ownerRestaurants.setHours(owner(req), param(req), body(setHoursSchema, req))));
  r.get('/restaurants/:id/stats', async (req, res) => res.json(await c.ownerRestaurants.stats(owner(req), param(req), query(statsQuerySchema, req))));

  // ── delivery zones ──
  r.get('/restaurants/:id/zones', async (req, res) => res.json(await c.ownerRestaurants.listZones(owner(req), param(req))));
  r.post('/restaurants/:id/zones', async (req, res) => res.status(201).json(await c.ownerRestaurants.createZone(owner(req), param(req), body(createZoneSchema, req))));
  r.patch('/restaurants/:id/zones/:zoneId', async (req, res) => res.json(await c.ownerRestaurants.updateZone(owner(req), param(req), param(req, 'zoneId'), body(updateZoneSchema, req))));
  r.delete('/restaurants/:id/zones/:zoneId', async (req, res) => { await c.ownerRestaurants.deleteZone(owner(req), param(req), param(req, 'zoneId')); res.status(204).end(); });

  // ── menu ──
  const m = '/restaurants/:rid/menu';
  r.get(m, async (req, res) => res.json(await c.ownerMenu.getMenu(owner(req), param(req, 'rid'))));
  r.post(`${m}/categories`, async (req, res) => res.status(201).json(await c.ownerMenu.createCategory(owner(req), param(req, 'rid'), body(categorySchema, req))));
  r.patch(`${m}/categories/:id`, async (req, res) => res.json(await c.ownerMenu.updateCategory(owner(req), param(req, 'rid'), param(req), body(updateCategorySchema, req))));
  r.delete(`${m}/categories/:id`, async (req, res) => res.json(await c.ownerMenu.deleteCategory(owner(req), param(req, 'rid'), param(req))));
  r.post(`${m}/items`, async (req, res) => res.status(201).json(await c.ownerMenu.createItem(owner(req), param(req, 'rid'), body(createItemSchema, req))));
  r.patch(`${m}/items/:id`, async (req, res) => res.json(await c.ownerMenu.updateItem(owner(req), param(req, 'rid'), param(req), body(updateItemSchema, req))));
  r.patch(`${m}/items/:id/availability`, async (req, res) => res.json(await c.ownerMenu.setAvailability(owner(req), param(req, 'rid'), param(req), body(itemAvailabilitySchema, req))));
  r.delete(`${m}/items/:id`, async (req, res) => { await c.ownerMenu.deleteItem(owner(req), param(req, 'rid'), param(req)); res.status(204).end(); });
  r.put(`${m}/items/:id/variants`, async (req, res) => res.json(await c.ownerMenu.syncVariants(owner(req), param(req, 'rid'), param(req), body(syncVariantsSchema, req))));
  r.put(`${m}/items/:id/addon-groups`, async (req, res) => res.json(await c.ownerMenu.syncAddonGroups(owner(req), param(req, 'rid'), param(req), body(syncAddonGroupsSchema, req))));

  // ── kitchen orders ──
  const o = '/restaurants/:rid/orders';
  r.get(o, async (req, res) => res.json(await c.ownerOrders.list(owner(req), param(req, 'rid'), query(listOwnerOrdersSchema, req))));
  r.get(`${o}/:id`, async (req, res) => res.json(await c.ownerOrders.get(owner(req), param(req, 'rid'), param(req))));
  r.post(`${o}/:id/accept`, async (req, res) => res.json(await c.ownerOrders.accept(owner(req), param(req, 'rid'), param(req), body(acceptOrderSchema, req))));
  r.post(`${o}/:id/reject`, async (req, res) => res.json(await c.ownerOrders.reject(owner(req), param(req, 'rid'), param(req), body(orderReasonSchema, req).reason)));
  r.post(`${o}/:id/preparing`, async (req, res) => res.json(await c.ownerOrders.startPreparing(owner(req), param(req, 'rid'), param(req))));
  r.post(`${o}/:id/ready`, async (req, res) => res.json(await c.ownerOrders.markReady(owner(req), param(req, 'rid'), param(req))));
  r.post(`${o}/:id/cancel`, async (req, res) => res.json(await c.ownerOrders.cancel(owner(req), param(req, 'rid'), param(req), body(orderReasonSchema, req).reason)));

  // ── reviews, coupons, money ──
  r.get('/restaurants/:rid/reviews', async (req, res) => { await c.access.assertOwner(owner(req), param(req, 'rid')); res.json(await c.reviews.forRestaurant(param(req, 'rid'), query(reviewsQuery, req), { requireApproved: false })); });
  const cp = '/restaurants/:rid/coupons';
  const me_ = (req: Parameters<typeof me>[0]) => ({ id: me(req).id, role: 'OWNER' as const });
  r.get(cp, async (req, res) => { await c.access.assertOwner(owner(req), param(req, 'rid')); res.json(await c.coupons.list({ restaurantId: param(req, 'rid') }, query(couponsQuery, req))); });
  r.post(cp, async (req, res) => { await c.access.assertOwner(owner(req), param(req, 'rid')); res.status(201).json(await c.coupons.create(me_(req), { restaurantId: param(req, 'rid') }, body(couponCreateSchema, req))); });
  r.patch(`${cp}/:id`, async (req, res) => { await c.access.assertOwner(owner(req), param(req, 'rid')); res.json(await c.coupons.update(me_(req), { restaurantId: param(req, 'rid') }, param(req), body(couponUpdateSchema, req))); });
  r.get('/restaurants/:rid/earnings', async (req, res) => { await c.access.assertOwner(owner(req), param(req, 'rid')); res.json(await c.payouts.restaurantEarnings(param(req, 'rid'), query(earningsQuery, req))); });
  r.get('/payouts', async (req, res) => res.json(await c.payouts.payoutsFor(owner(req))));
  return r;
}
