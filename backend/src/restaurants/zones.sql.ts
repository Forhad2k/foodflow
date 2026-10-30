import { Prisma } from '@prisma/client';
import { utc } from '../dispatch/dispatch.sql';

/** Max area of one polygon zone (5,000 km²): catches mistakes like a zone drawn across the whole country. */
export const MAX_ZONE_AREA_M2 = 5_000_000_000;

export type Ring = [number, number][]; // [lng, lat] pairs, GeoJSON order

export const ringToWkt = (ring: Ring) => `POLYGON((${ring.map(([lng, lat]) => `${lng} ${lat}`).join(', ')}))`;

/** Structural checks before the database sees the ring. Returns an error message or null. */
export function validateRing(ring: unknown): string | null {
  if (!Array.isArray(ring) || ring.length < 4 || ring.length > 200) return 'polygon needs 4 to 200 points (first point repeated at the end)';
  for (const p of ring) {
    if (!Array.isArray(p) || p.length !== 2 || !p.every((n) => typeof n === 'number' && Number.isFinite(n))) return 'each point must be [lng, lat]';
    const [lng, lat] = p as [number, number];
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return 'point out of range';
  }
  const [first, last] = [ring[0] as number[], ring[ring.length - 1] as number[]];
  if (first[0] !== last[0] || first[1] !== last[1]) return 'polygon must be closed (last point equals first)';
  return null;
}

/** PostGIS validity (self-intersections etc.) and geodesic area. */
export const buildPolygonCheckQuery = (wkt: string) => Prisma.sql`
  SELECT ST_IsValid(g) AS valid,
         ST_IsValidReason(g) AS reason,
         CASE WHEN ST_IsValid(g) THEN ST_Area(ST_ForcePolygonCCW(g)::geography)::float8 END AS area
  FROM (SELECT ST_GeomFromText(${wkt}, 4326) AS g) t`;

/**
 * Rings are normalised to counter-clockwise: for the geography type a wrongly-wound ring can mean "everything
 * except this shape", which would make a zone cover the whole planet.
 * (Prisma's @default(uuid()) is client-side, so raw inserts must supply the id themselves.)
 */
export const buildInsertPolygonZone = (p: { restaurantId: string; name: string; wkt: string; deliveryFeeMinor: number | null; minOrderMinor: number | null }) => Prisma.sql`
  INSERT INTO delivery_zones (id, "restaurantId", name, type, polygon, "deliveryFeeMinor", "minOrderMinor", "isActive")
  VALUES (gen_random_uuid(), ${p.restaurantId}::uuid, ${p.name}, 'POLYGON',
          ST_ForcePolygonCCW(ST_GeomFromText(${p.wkt}, 4326))::geography,
          ${p.deliveryFeeMinor}::int, ${p.minOrderMinor}::int, TRUE)
  RETURNING id`;

export const buildListZonesQuery = (restaurantId: string) => Prisma.sql`
  SELECT id, name, type::text AS type, "radiusMeters", "deliveryFeeMinor", "minOrderMinor", "isActive",
         CASE WHEN polygon IS NULL THEN NULL ELSE ST_AsGeoJSON(polygon::geometry)::json END AS polygon
  FROM delivery_zones WHERE "restaurantId" = ${restaurantId}::uuid
  ORDER BY "createdAt" ASC, id ASC`;

/** Sales for one restaurant over [from, to). Commission uses the rate snapshotted on each order. */
export const buildSalesSummaryQuery = (restaurantId: string, from: Date, to: Date) => Prisma.sql`
  SELECT
    COUNT(*) FILTER (WHERE status = 'DELIVERED')::int                                   AS "deliveredCount",
    COUNT(*) FILTER (WHERE status IN ('CANCELLED','REJECTED_BY_RESTAURANT'))::int      AS "cancelledCount",
    COUNT(*) FILTER (WHERE status NOT IN ('DELIVERED','CANCELLED','REJECTED_BY_RESTAURANT','PAYMENT_FAILED','DELIVERY_FAILED','PENDING_PAYMENT'))::int AS "inProgressCount",
    COALESCE(SUM("subtotalMinor") FILTER (WHERE status = 'DELIVERED'), 0)::float8       AS "grossMinor",
    COALESCE(SUM(ROUND("subtotalMinor"::numeric * "commissionBps" / 10000)) FILTER (WHERE status = 'DELIVERED'), 0)::float8 AS "commissionMinor"
  FROM orders
  WHERE "restaurantId" = ${restaurantId}::uuid AND "placedAt" >= ${utc(from)} AND "placedAt" < ${utc(to)}`;

/** Admin-defined service areas: same polygon handling as delivery zones (validated, normalised to counter-clockwise). */
export const buildInsertServiceArea = (name: string, wkt: string) => Prisma.sql`
  INSERT INTO service_areas (id, name, polygon, "isActive")
  VALUES (gen_random_uuid(), ${name}, ST_ForcePolygonCCW(ST_GeomFromText(${wkt}, 4326))::geography, TRUE)
  RETURNING id`;
export const buildListServiceAreasQuery = () => Prisma.sql`
  SELECT id, name, "isActive", CASE WHEN polygon IS NULL THEN NULL ELSE ST_AsGeoJSON(polygon::geometry)::json END AS polygon
  FROM service_areas ORDER BY "createdAt" ASC, id ASC`;
