import { OrderStatus, Role } from '@prisma/client';
import { offerNotification, orderPlacedNotifications, orderStatusNotifications, riderAssignedNotifications } from './order-events';

const o = { id: 'o1', orderNumber: 'FF-1', customerId: 'cust', ownerId: 'owner', riderId: null as string | null };
const S = OrderStatus;
const who = (list: { userId: string }[]) => list.map((n) => n.userId).sort();

describe('who is told about an order', () => {
  it('placement tells the restaurant to act and the customer it was sent', () => {
    const n = orderPlacedNotifications(o);
    expect(who(n)).toEqual(['cust', 'owner']);
    expect(n.find((x) => x.userId === 'owner')!.title).toBe('New order');
  });
  it('progress is for the customer; the restaurant is not told about its own actions', () => {
    for (const to of [S.RESTAURANT_ACCEPTED, S.PREPARING, S.PICKED_UP, S.ON_THE_WAY, S.DELIVERED]) {
      expect(who(orderStatusNotifications(o, S.PLACED, to, Role.RESTAURANT_OWNER))).toEqual(['cust']);
    }
  });
  it('a rejection carries the reason', () => {
    const [n] = orderStatusNotifications(o, S.PLACED, S.REJECTED_BY_RESTAURANT, Role.RESTAURANT_OWNER, 'Out of stock');
    expect(n.body).toContain('Out of stock');
  });
  it('cancellation tells everyone involved except whoever did it', () => {
    const withRider = { ...o, riderId: 'rider' };
    expect(who(orderStatusNotifications(withRider, S.PLACED, S.CANCELLED, Role.CUSTOMER))).toEqual(['owner', 'rider']);
    expect(who(orderStatusNotifications(withRider, S.PREPARING, S.CANCELLED, Role.RESTAURANT_OWNER))).toEqual(['cust', 'rider']);
    expect(who(orderStatusNotifications(o, S.PLACED, S.CANCELLED, 'SYSTEM'))).toEqual(['cust', 'owner']);
    expect(who(orderStatusNotifications(withRider, S.PREPARING, S.CANCELLED, Role.ADMIN))).toEqual(['cust', 'owner', 'rider']);
  });
  it('is quiet where another notification already covers it', () => {
    expect(orderStatusNotifications(o, S.READY_FOR_PICKUP, S.RIDER_ASSIGNED, 'SYSTEM')).toEqual([]); // "rider assigned" is sent by dispatch
    expect(orderStatusNotifications(o, S.RIDER_ASSIGNED, S.READY_FOR_PICKUP, 'SYSTEM', 'rider released')).toEqual([]); // internal reshuffle
    expect(orderStatusNotifications(o, null, S.PLACED, Role.CUSTOMER)).toEqual([]); // cash checkout announces itself
    expect(who(orderStatusNotifications(o, S.PENDING_PAYMENT, S.PLACED, 'SYSTEM'))).toEqual(['cust', 'owner']); // online payment confirmed
  });
  it('every notification names the order and links to it', () => {
    for (const n of [...orderPlacedNotifications(o), ...orderStatusNotifications(o, S.PLACED, S.RESTAURANT_ACCEPTED, 'SYSTEM'), ...riderAssignedNotifications(o, 'Karim')]) {
      expect(JSON.stringify(n.data)).toContain('o1');
      expect(`${n.title} ${n.body}`.length).toBeGreaterThan(10);
    }
    expect(riderAssignedNotifications(o, 'Karim').find((n) => n.userId === 'cust')!.body).toContain('Karim');
  });
  it('a delivery offer goes to the rider with the offer id and deadline', () => {
    const n = offerNotification('rider', 'FF-1', 'offer-1', new Date('2026-10-12T10:00:00Z'));
    expect(n).toMatchObject({ userId: 'rider', data: { offerId: 'offer-1', expiresAt: '2026-10-12T10:00:00.000Z' } });
  });
});
