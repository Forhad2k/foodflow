import { Prisma } from '@prisma/client';
import type { RiderCandidate } from './ranking';

/**
 * An instant as a UTC wall-clock `timestamp`, comparable with Prisma's `timestamp(3)` columns (which hold UTC).
 * The value travels as ISO text and is parsed explicitly, so the result is independent of the database session's
 * time zone AND of how a given driver/adapter types JavaScript Date parameters.
 */
export const utc = (d: Date) => Prisma.sql`((${d.toISOString()}::text)::timestamptz AT TIME ZONE 'UTC')`;

/**
 * Riders who may be OFFERED this order right now:
 *  - approved, account active, online, with a position fresher than `freshSince`
 *  - within `maxDistanceMeters` of the restaurant (PostGIS, GiST-indexed)
 *  - below their delivery capacity (offered + accepted deliveries count)
 *  - never offered THIS order in the current round (so a rider who rejected/ignored it is not asked again)
 */
export function buildRiderCandidatesQuery(p: { orderId: string; restaurantId: string; maxDistanceMeters: number; freshSince: Date; roundStart: Date; limit: number }): Prisma.Sql {
  return Prisma.sql`
    SELECT rp."userId" AS "riderId",
           ST_Distance(rp.location, r.location)::float8 AS "distanceMeters",
           (SELECT COUNT(*) FROM delivery_assignments da WHERE da."riderId" = rp."userId" AND da.status IN ('OFFERED','ACCEPTED'))::int AS "activeLoad",
           rp."maxActiveDeliveries"::int AS "maxActive",
           rp."offersReceived"::int AS "offersReceived",
           rp."offersAccepted"::int AS "offersAccepted"
    FROM rider_profiles rp
    JOIN users u ON u.id = rp."userId" AND u.status = 'ACTIVE'
    JOIN restaurants r ON r.id = ${p.restaurantId}::uuid
    WHERE rp."approvalStatus" = 'APPROVED'
      AND rp."isOnline"
      AND rp.location IS NOT NULL
      AND rp."lastLocationAt" >= ${utc(p.freshSince)}
      AND ST_DWithin(rp.location, r.location, ${p.maxDistanceMeters}::float8)
      AND (SELECT COUNT(*) FROM delivery_assignments da WHERE da."riderId" = rp."userId" AND da.status IN ('OFFERED','ACCEPTED')) < rp."maxActiveDeliveries"
      AND NOT EXISTS (SELECT 1 FROM delivery_assignments prev
                      WHERE prev."orderId" = ${p.orderId}::uuid AND prev."riderId" = rp."userId" AND prev."offeredAt" >= ${utc(p.roundStart)})
    ORDER BY "distanceMeters" ASC, rp."userId" ASC
    LIMIT ${p.limit}`;
}
export type { RiderCandidate };
