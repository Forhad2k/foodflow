import { estimateDelivery } from './eta';
import { Rankable, score, sortRestaurants } from './ranking';

const W = { distance: 0.35, eta: 0.3, rating: 0.25, relevance: 0.1 };
const r = (o: Partial<Rankable> & { id: string }): Rankable => ({
  distanceMeters: 1000, etaMaxMinutes: 40, ratingAvg: 4, ratingCount: 50, deliveryFeeMinor: 3000, relevance: 0.5, ...o,
});

describe('estimateDelivery', () => {
  it('grows with distance and prep time and rounds to 5 minutes', () => {
    const near = estimateDelivery(15, 500, 18);
    const far = estimateDelivery(15, 5000, 18);
    expect(far.maxMinutes).toBeGreaterThan(near.maxMinutes);
    expect(estimateDelivery(30, 500, 18).minMinutes).toBeGreaterThan(near.minMinutes);
    for (const e of [near, far]) {
      expect(e.minMinutes % 5).toBe(0);
      expect(e.maxMinutes % 5).toBe(0);
      expect(e.maxMinutes).toBeGreaterThan(e.minMinutes);
    }
  });
});

describe('ranking', () => {
  it('prefers nearer, faster, better-rated restaurants', () => {
    const good = r({ id: 'a', distanceMeters: 500, etaMaxMinutes: 30, ratingAvg: 4.8 });
    const bad = r({ id: 'b', distanceMeters: 7000, etaMaxMinutes: 80, ratingAvg: 3.1 });
    expect(score(good, W, 8000)).toBeGreaterThan(score(bad, W, 8000));
    expect(sortRestaurants([bad, good], 'recommended', W, 8000).map((x) => x.id)).toEqual(['a', 'b']);
  });
  it('weights are configurable: rating-only weights flip the order', () => {
    const near = r({ id: 'near', distanceMeters: 300, ratingAvg: 3.0 });
    const loved = r({ id: 'loved', distanceMeters: 6000, ratingAvg: 4.9 });
    const byDistance = sortRestaurants([loved, near], 'recommended', { distance: 1, eta: 0, rating: 0, relevance: 0 }, 8000);
    const byRating = sortRestaurants([near, loved], 'recommended', { distance: 0, eta: 0, rating: 1, relevance: 0 }, 8000);
    expect(byDistance[0].id).toBe('near');
    expect(byRating[0].id).toBe('loved');
  });
  it('does not bury unrated restaurants below mediocre ones', () => {
    const fresh = r({ id: 'new', ratingAvg: 0, ratingCount: 0 });
    const meh = r({ id: 'meh', ratingAvg: 2.0, ratingCount: 200 });
    expect(score(fresh, W, 8000)).toBeGreaterThan(score(meh, W, 8000));
  });
  it('supports explicit sort modes and is deterministic on ties', () => {
    const items = [r({ id: 'c', distanceMeters: 100 }), r({ id: 'a', distanceMeters: 100 }), r({ id: 'b', distanceMeters: 50, deliveryFeeMinor: 0 })];
    expect(sortRestaurants(items, 'distance', W, 8000).map((x) => x.id)).toEqual(['b', 'a', 'c']);
    expect(sortRestaurants(items, 'delivery_fee', W, 8000)[0].id).toBe('b');
  });
  it('survives zero weights and out-of-range inputs', () => {
    const s = score(r({ id: 'x', distanceMeters: 99999, etaMaxMinutes: 999, relevance: 7 }), { distance: 0, eta: 0, rating: 0, relevance: 0 }, 8000);
    expect(Number.isFinite(s)).toBe(true);
  });
});
