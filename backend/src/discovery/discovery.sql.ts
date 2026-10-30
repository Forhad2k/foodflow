import { Prisma } from '@prisma/client';

/**
 * SQL builders for location-based discovery (PostGIS). Kept free of I/O so the exact statements can be
 * exercised against a real PostGIS in discovery.sql.spec.ts.
 *
 * ELIGIBILITY (shared by listing, restaurant page and checkout re-validation) - a restaurant serves a point iff:
 *   1. it is APPROVED and not paused, and
 *   2. at least one ACTIVE delivery zone covers the point (RADIUS: within radiusMeters of the restaurant,
 *      POLYGON: point inside the polygon), and
 *   3. if the admin has defined any active service areas, the point lies inside one of them.
 * Plain proximity is never enough. When several zones cover the point, the cheapest fee wins (ties by id).
 */

export interface CandidateParams {
  lat: number;
  lng: number;
  maxRadiusMeters: number;
  q?: string;
  cuisineSlugs?: string[];
  priceTiers?: number[];
  minRating?: number;
  limit: number;
}

export interface Candidate {
  id: string;
  distanceMeters: number;
  deliveryFeeMinor: number;
  minOrderMinor: number;
  nameMatch: boolean;
  dishMatch: boolean;
}

export const point = (lat: number, lng: number) =>
  Prisma.sql`ST_SetSRID(ST_MakePoint(${lng}::float8, ${lat}::float8), 4326)::geography`;

/** Escape LIKE wildcards so user text is matched literally. */
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const zoneJoin = (pt: Prisma.Sql) => Prisma.sql`
  JOIN LATERAL (
    SELECT COALESCE(dz."deliveryFeeMinor", r."baseDeliveryFeeMinor") AS fee,
           COALESCE(dz."minOrderMinor", r."minOrderMinor")           AS min_order
    FROM delivery_zones dz
    WHERE dz."restaurantId" = r.id
      AND dz."isActive"
      AND ( (dz.type = 'RADIUS'  AND ST_DWithin(r.location, ${pt}, dz."radiusMeters"))
         OR (dz.type = 'POLYGON' AND dz.polygon IS NOT NULL AND ST_Covers(dz.polygon, ${pt})) )
    ORDER BY COALESCE(dz."deliveryFeeMinor", r."baseDeliveryFeeMinor") ASC, dz.id ASC
    LIMIT 1
  ) z ON TRUE`;

const serviceAreaGuard = (pt: Prisma.Sql) => Prisma.sql`
  AND ( NOT EXISTS (SELECT 1 FROM service_areas WHERE "isActive")
        OR EXISTS (SELECT 1 FROM service_areas sa WHERE sa."isActive" AND sa.polygon IS NOT NULL AND ST_Covers(sa.polygon, ${pt})) )`;

export function buildCandidatesQuery(p: CandidateParams): Prisma.Sql {
  const pt = point(p.lat, p.lng);
  const pattern = p.q ? likePattern(p.q) : null;

  const nameMatch = pattern ? Prisma.sql`(r.name ILIKE ${pattern} ESCAPE '\\')` : Prisma.sql`FALSE`;
  const dishMatch = pattern
    ? Prisma.sql`EXISTS (SELECT 1 FROM menu_items mi WHERE mi."restaurantId" = r.id AND mi."deletedAt" IS NULL AND mi."isAvailable" AND mi.name ILIKE ${pattern} ESCAPE '\\')`
    : Prisma.sql`FALSE`;

  const filters: Prisma.Sql[] = [];
  if (pattern) filters.push(Prisma.sql`AND (${nameMatch} OR ${dishMatch})`);
  if (p.cuisineSlugs?.length) {
    filters.push(Prisma.sql`AND EXISTS (
      SELECT 1 FROM restaurant_cuisines rc JOIN cuisine_types c ON c.id = rc."cuisineId"
      WHERE rc."restaurantId" = r.id AND c.slug = ANY(${p.cuisineSlugs}::text[]))`);
  }
  if (p.priceTiers?.length) filters.push(Prisma.sql`AND r."priceTier" = ANY(${p.priceTiers}::int[])`);
  if (p.minRating !== undefined) filters.push(Prisma.sql`AND (r."ratingCount" = 0 OR r."ratingAvg" >= ${p.minRating}::float8)`);

  return Prisma.sql`
    SELECT r.id,
           ST_Distance(r.location, ${pt})::float8 AS "distanceMeters",
           z.fee::int       AS "deliveryFeeMinor",
           z.min_order::int AS "minOrderMinor",
           ${nameMatch}     AS "nameMatch",
           ${dishMatch}     AS "dishMatch"
    FROM restaurants r
    ${zoneJoin(pt)}
    WHERE r."approvalStatus" = 'APPROVED'
      AND NOT r."isPaused"
      AND ST_DWithin(r.location, ${pt}, ${p.maxRadiusMeters}::float8)
      ${serviceAreaGuard(pt)}
      ${filters.length ? Prisma.join(filters, ' ') : Prisma.empty}
    ORDER BY "distanceMeters" ASC, r.id ASC
    LIMIT ${p.limit}`;
}

/** Same eligibility for ONE restaurant: used by the restaurant page and by checkout re-validation. */
export function buildDeliverableQuery(restaurantId: string, lat: number, lng: number): Prisma.Sql {
  const pt = point(lat, lng);
  return Prisma.sql`
    SELECT r.id,
           ST_Distance(r.location, ${pt})::float8 AS "distanceMeters",
           z.fee::int       AS "deliveryFeeMinor",
           z.min_order::int AS "minOrderMinor"
    FROM restaurants r
    ${zoneJoin(pt)}
    WHERE r.id = ${restaurantId}::uuid
      AND r."approvalStatus" = 'APPROVED'
      AND NOT r."isPaused"
      ${serviceAreaGuard(pt)}`;
}
