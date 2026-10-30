import { Router } from 'express';
import type { Container } from '../../container';
import { listRestaurantsSchema, restaurantDetailQuerySchema } from '../../schemas/discovery';
import { reviewsQuery } from '../../schemas/money';
import { DomainError } from '../../common/errors/domain-error';
import { query } from '../validate';

/** Browsing is public: visitors can look around before signing in. */
export function discoveryRouter(c: Container) {
  const r = Router();
  r.get('/cuisines', async (_req, res) => res.json(await c.discovery.listCuisines()));
  r.get('/restaurants', async (req, res) => res.json(await c.discovery.listRestaurants(query(listRestaurantsSchema, req))));
  r.get('/restaurants/:ref', async (req, res) => res.json(await c.discovery.getRestaurant(String(req.params.ref), query(restaurantDetailQuerySchema, req))));
  r.get('/restaurants/:ref/reviews', async (req, res) => {
    const ref = String(req.params.ref);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
    const rest = await c.prisma.restaurant.findFirst({ where: { approvalStatus: 'APPROVED', ...(uuid ? { id: ref } : { slug: ref }) }, select: { id: true } });
    if (!rest) throw new DomainError('RESTAURANT_NOT_FOUND', 'Restaurant not found', 404);
    res.json(await c.reviews.forRestaurant(rest.id, query(reviewsQuery, req), { requireApproved: true }));
  });
  return r;
}

export function healthRouter(c: Container) {
  const r = Router();
  r.get('/live', (_req, res) => res.json({ status: 'ok' })); // liveness: process is up
  r.get('/ready', async (_req, res) => {
    try {
      await c.prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', checks: { database: 'up' } });
    } catch {
      res.status(503).json({ status: 'degraded', checks: { database: 'down' } }); // readiness: dependencies reachable
    }
  });
  return r;
}
