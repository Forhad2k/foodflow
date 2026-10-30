export interface RankWeights {
  distance: number;
  eta: number;
  rating: number;
  relevance: number;
}

export interface Rankable {
  id: string;
  distanceMeters: number;
  etaMaxMinutes: number;
  ratingAvg: number;
  ratingCount: number;
  deliveryFeeMinor: number;
  relevance: number; // 0..1
}

export type SortMode = 'recommended' | 'distance' | 'rating' | 'delivery_time' | 'delivery_fee';

const MAX_ETA_MINUTES = 90;
const UNRATED_SCORE = 0.6; // new restaurants are neither buried nor boosted

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Weighted blend in [0,1]. Weights are normalised so admins can set any positive ratio. */
export function score(r: Rankable, w: RankWeights, maxRadiusMeters: number): number {
  const total = w.distance + w.eta + w.rating + w.relevance || 1;
  const distance = 1 - clamp01(r.distanceMeters / Math.max(maxRadiusMeters, 1));
  const eta = 1 - clamp01(r.etaMaxMinutes / MAX_ETA_MINUTES);
  const rating = r.ratingCount > 0 ? clamp01(r.ratingAvg / 5) : UNRATED_SCORE;
  return (w.distance * distance + w.eta * eta + w.rating * rating + w.relevance * clamp01(r.relevance)) / total;
}

export function sortRestaurants<T extends Rankable>(items: T[], mode: SortMode, w: RankWeights, maxRadius: number): T[] {
  const byId = (a: T, b: T) => a.id.localeCompare(b.id); // deterministic tie-break → stable pagination
  const cmp: Record<SortMode, (a: T, b: T) => number> = {
    recommended: (a, b) => score(b, w, maxRadius) - score(a, w, maxRadius) || a.distanceMeters - b.distanceMeters,
    distance: (a, b) => a.distanceMeters - b.distanceMeters,
    rating: (a, b) => b.ratingAvg - a.ratingAvg || b.ratingCount - a.ratingCount,
    delivery_time: (a, b) => a.etaMaxMinutes - b.etaMaxMinutes || a.distanceMeters - b.distanceMeters,
    delivery_fee: (a, b) => a.deliveryFeeMinor - b.deliveryFeeMinor || a.distanceMeters - b.distanceMeters,
  };
  return [...items].sort((a, b) => cmp[mode](a, b) || byId(a, b));
}
