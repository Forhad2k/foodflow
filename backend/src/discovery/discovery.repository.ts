import type { Db } from '../common/db';
import { buildCandidatesQuery, buildDeliverableQuery, Candidate, CandidateParams } from './discovery.sql';

export interface Deliverability {
  distanceMeters: number;
  deliveryFeeMinor: number;
  minOrderMinor: number;
}
export class DiscoveryRepository {
  findCandidates(db: Db, params: CandidateParams): Promise<Candidate[]> {
    return db.$queryRaw<Candidate[]>(buildCandidatesQuery(params));
  }

  /** null → this restaurant does not deliver to that point (right now). */
  async checkDeliverable(db: Db, restaurantId: string, lat: number, lng: number): Promise<Deliverability | null> {
    const rows = await db.$queryRaw<Deliverability[]>(buildDeliverableQuery(restaurantId, lat, lng));
    return rows[0] ?? null;
  }
}
