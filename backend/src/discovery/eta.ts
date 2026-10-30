export interface DeliveryEstimate {
  minMinutes: number;
  maxMinutes: number;
}

const roundUp5 = (n: number) => Math.ceil(n / 5) * 5;
const roundDown5 = (n: number) => Math.max(5, Math.floor(n / 5) * 5);

/**
 * Cheap, deterministic estimate for list views: prep time + handover buffer + straight-line travel.
 * (Live ETA during an active delivery comes from the routing service in Phase 6.)
 */
export function estimateDelivery(avgPrepMinutes: number, distanceMeters: number, speedKmh: number): DeliveryEstimate {
  const travel = (distanceMeters / 1000 / Math.max(speedKmh, 1)) * 60;
  const base = avgPrepMinutes + 5 + travel;
  return { minMinutes: roundDown5(base), maxMinutes: roundUp5(base + 10) };
}
