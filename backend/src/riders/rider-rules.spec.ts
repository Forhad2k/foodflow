import { ApprovalStatus, DocumentType, OrderStatus, VehicleType } from '@prisma/client';
import { haversineMeters, isPlausibleMove } from '../common/geo/distance';
import { RiderCandidate, rankRiders, riderScore } from '../dispatch/ranking';
import { deliveryVisibility, isOwnStorageKey, missingForRiderApproval, requiredDocuments } from './rider-rules';

const D = DocumentType;
const doc = (type: DocumentType, status: ApprovalStatus = ApprovalStatus.APPROVED) => ({ type, status });

describe('rider verification requirements', () => {
  it('bicycle riders need ID + selfie; motorised riders also need licence and registration', () => {
    expect(requiredDocuments(VehicleType.BICYCLE)).toEqual([D.NATIONAL_ID, D.SELFIE]);
    expect(requiredDocuments(VehicleType.MOTORCYCLE)).toEqual([D.NATIONAL_ID, D.SELFIE, D.DRIVING_LICENSE, D.VEHICLE_REGISTRATION]);
    expect(requiredDocuments(VehicleType.CAR)).toHaveLength(4);
    expect(requiredDocuments(null)).toHaveLength(2);
  });
  it('lists exactly what is missing, pending or rejected', () => {
    expect(missingForRiderApproval(null, [])[0]).toMatch(/vehicle/i);
    expect(missingForRiderApproval(VehicleType.BICYCLE, [doc(D.NATIONAL_ID), doc(D.SELFIE)])).toEqual([]);
    expect(missingForRiderApproval(VehicleType.MOTORCYCLE, [doc(D.NATIONAL_ID), doc(D.SELFIE)])).toHaveLength(2);
    const m = missingForRiderApproval(VehicleType.BICYCLE, [doc(D.NATIONAL_ID, ApprovalStatus.PENDING), doc(D.SELFIE, ApprovalStatus.REJECTED)]);
    expect(m).toEqual(['Your national ID is awaiting review', 'Your selfie is rejected']);
  });
  it('an extra OTHER document never substitutes for a required one', () => {
    expect(missingForRiderApproval(VehicleType.BICYCLE, [doc(D.OTHER), doc(D.NATIONAL_ID)])).toHaveLength(1);
  });
});

describe('document storage keys', () => {
  const me = '6f1d6f3e-2d6b-4c8e-9a53-1f6a0b9c2d11';
  it('only accepts keys inside the rider’s own folder', () => {
    expect(isOwnStorageKey(me, `riders/${me}/id-front.jpg`)).toBe(true);
    expect(isOwnStorageKey(me, `riders/another-user/id-front.jpg`)).toBe(false);
    expect(isOwnStorageKey(me, `riders/${me}/../other/x.jpg`)).toBe(false);
    expect(isOwnStorageKey(me, `riders/${me}/sub/dir.jpg`)).toBe(false);
    expect(isOwnStorageKey(me, `/etc/passwd`)).toBe(false);
    expect(isOwnStorageKey(me, `riders/${me}/`)).toBe(false);
  });
});

describe('what a rider may see, by stage', () => {
  const S = OrderStatus;
  it('before pickup: restaurant details and customer first name only: no address, no phone', () => {
    for (const s of [S.RESTAURANT_ACCEPTED, S.PREPARING, S.READY_FOR_PICKUP, S.RIDER_ASSIGNED]) {
      expect(deliveryVisibility(s)).toEqual({ restaurantExact: true, customerFirstName: true, customerAddress: false, customerPhone: false });
    }
  });
  it('after pickup: the drop-off address and phone are revealed', () => {
    for (const s of [S.PICKED_UP, S.ON_THE_WAY]) expect(deliveryVisibility(s)).toMatchObject({ customerAddress: true, customerPhone: true });
  });
  it('once the order is over, nothing personal remains visible', () => {
    for (const s of [S.DELIVERED, S.DELIVERY_FAILED, S.CANCELLED, S.REJECTED_BY_RESTAURANT, S.PLACED]) {
      expect(deliveryVisibility(s)).toEqual({ restaurantExact: false, customerFirstName: false, customerAddress: false, customerPhone: false });
    }
  });
});

describe('rider ranking', () => {
  const c = (o: Partial<RiderCandidate> & { riderId: string }): RiderCandidate => ({ distanceMeters: 1000, activeLoad: 0, maxActive: 1, offersReceived: 0, offersAccepted: 0, ...o });
  it('prefers the nearer rider', () => {
    expect(rankRiders([c({ riderId: 'far', distanceMeters: 3000 }), c({ riderId: 'near', distanceMeters: 300 })], 4000)[0].riderId).toBe('near');
  });
  it('prefers the less busy rider when distances are equal', () => {
    const r = rankRiders([c({ riderId: 'busy', activeLoad: 1, maxActive: 2 }), c({ riderId: 'free', activeLoad: 0, maxActive: 2 })], 4000);
    expect(r[0].riderId).toBe('free');
  });
  it('rewards reliability once there is history, and does not punish newcomers', () => {
    const reliable = c({ riderId: 'reliable', offersReceived: 20, offersAccepted: 19 });
    const flaky = c({ riderId: 'flaky', offersReceived: 20, offersAccepted: 4 });
    const fresh = c({ riderId: 'fresh', offersReceived: 1, offersAccepted: 0 });
    expect(riderScore(reliable, 4000)).toBeGreaterThan(riderScore(flaky, 4000));
    expect(riderScore(fresh, 4000)).toBeGreaterThan(riderScore(flaky, 4000));
    expect(riderScore(fresh, 4000)).toBeLessThan(riderScore(reliable, 4000));
  });
  it('is deterministic on exact ties', () => {
    expect(rankRiders([c({ riderId: 'b' }), c({ riderId: 'a' })], 4000).map((x) => x.riderId)).toEqual(['a', 'b']);
  });
});

describe('geo helpers', () => {
  it('haversine matches known distances', () => {
    expect(haversineMeters(23.7925, 90.4078, 23.7925, 90.4078)).toBe(0);
    expect(haversineMeters(23.0, 90.0, 24.0, 90.0)).toBeCloseTo(111_195, -2);
  });
  it('flags teleporting locations but tolerates GPS jitter and normal speeds', () => {
    const t0 = new Date('2026-10-12T10:00:00Z');
    const at = (s: number) => new Date(t0.getTime() + s * 1000);
    const here = { lat: 23.79, lng: 90.40, at: t0 };
    expect(isPlausibleMove(null, { lat: 0, lng: 0, at: t0 })).toBe(true);
    expect(isPlausibleMove(here, { lat: 23.7905, lng: 90.4003, at: at(1) })).toBe(true); // jitter < 500 m
    expect(isPlausibleMove(here, { lat: 23.80, lng: 90.40, at: at(60) })).toBe(true); // ~1.1 km in a minute
    expect(isPlausibleMove(here, { lat: 23.90, lng: 90.40, at: at(10) })).toBe(false); // ~12 km in 10 s
    expect(isPlausibleMove(here, { lat: 23.80, lng: 90.40, at: at(0) })).toBe(false); // jump with no time passing
  });
});
