export interface RiderCandidate {
  riderId: string;
  distanceMeters: number;
  activeLoad: number;
  maxActive: number;
  offersReceived: number;
  offersAccepted: number;
}

const W = { distance: 0.6, workload: 0.25, acceptance: 0.15 } as const;
const MIN_HISTORY = 5; // fewer offers than this → neutral acceptance (new riders are not penalised)
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function riderScore(c: RiderCandidate, maxDistanceMeters: number): number {
  const distance = 1 - clamp01(c.distanceMeters / Math.max(maxDistanceMeters, 1));
  const workload = 1 - clamp01(c.activeLoad / Math.max(c.maxActive, 1));
  const acceptance = c.offersReceived >= MIN_HISTORY ? clamp01(c.offersAccepted / c.offersReceived) : 0.5;
  return W.distance * distance + W.workload * workload + W.acceptance * acceptance;
}

/** Best first; riderId breaks exact ties so results are deterministic. */
export function rankRiders(cands: readonly RiderCandidate[], maxDistanceMeters: number): RiderCandidate[] {
  return [...cands].sort((a, b) => riderScore(b, maxDistanceMeters) - riderScore(a, maxDistanceMeters) || a.distanceMeters - b.distanceMeters || a.riderId.localeCompare(b.riderId));
}
