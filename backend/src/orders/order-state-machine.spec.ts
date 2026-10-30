import { OrderStatus } from '@prisma/client';
import {
  allowedTransitions,
  assertTransition,
  isTerminal,
  ORDER_TRANSITIONS,
  TERMINAL_STATUSES,
} from './order-state-machine';

const S = OrderStatus;

describe('order state machine', () => {
  it('defines a transition table entry for every OrderStatus', () => {
    for (const status of Object.values(S)) expect(ORDER_TRANSITIONS).toHaveProperty(status);
  });

  it('walks the full happy path with the correct actor at each step', () => {
    const path: [OrderStatus, OrderStatus, Parameters<typeof assertTransition>[2]][] = [
      [S.PLACED, S.RESTAURANT_ACCEPTED, 'RESTAURANT'],
      [S.RESTAURANT_ACCEPTED, S.PREPARING, 'RESTAURANT'],
      [S.PREPARING, S.READY_FOR_PICKUP, 'RESTAURANT'],
      [S.READY_FOR_PICKUP, S.RIDER_ASSIGNED, 'SYSTEM'],
      [S.RIDER_ASSIGNED, S.PICKED_UP, 'RIDER'],
      [S.PICKED_UP, S.ON_THE_WAY, 'RIDER'],
      [S.ON_THE_WAY, S.DELIVERED, 'RIDER'],
    ];
    for (const [from, to, actor] of path) expect(() => assertTransition(from, to, actor)).not.toThrow();
  });

  it('online-payment orders start in PENDING_PAYMENT and only the system may confirm or fail them', () => {
    expect(() => assertTransition(S.PENDING_PAYMENT, S.PLACED, 'SYSTEM')).not.toThrow();
    expect(() => assertTransition(S.PENDING_PAYMENT, S.PAYMENT_FAILED, 'SYSTEM')).not.toThrow();
    expect(() => assertTransition(S.PENDING_PAYMENT, S.PLACED, 'CUSTOMER')).toThrow(/may not/);
    expect(() => assertTransition(S.PENDING_PAYMENT, S.PLACED, 'ADMIN')).toThrow(/may not/);
  });

  it('terminal states have no way out, for any actor', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(
      [S.DELIVERED, S.REJECTED_BY_RESTAURANT, S.CANCELLED, S.PAYMENT_FAILED, S.DELIVERY_FAILED].sort(),
    );
    for (const from of TERMINAL_STATUSES) {
      expect(isTerminal(from)).toBe(true);
      for (const to of Object.values(S)) {
        for (const actor of ['CUSTOMER', 'RESTAURANT', 'RIDER', 'ADMIN', 'SYSTEM'] as const) {
          expect(() => assertTransition(from, to, actor)).toThrow();
        }
      }
    }
  });

  it('rejects skipping states', () => {
    expect(() => assertTransition(S.PLACED, S.PREPARING, 'RESTAURANT')).toThrow(/does not exist/);
    expect(() => assertTransition(S.PREPARING, S.DELIVERED, 'RIDER')).toThrow(/does not exist/);
    expect(() => assertTransition(S.READY_FOR_PICKUP, S.PICKED_UP, 'RIDER')).toThrow(/does not exist/);
  });

  it('enforces who may do what', () => {
    expect(() => assertTransition(S.PLACED, S.RESTAURANT_ACCEPTED, 'CUSTOMER')).toThrow(/may not/);
    expect(() => assertTransition(S.PLACED, S.RESTAURANT_ACCEPTED, 'RIDER')).toThrow(/may not/);
    expect(() => assertTransition(S.RIDER_ASSIGNED, S.PICKED_UP, 'CUSTOMER')).toThrow(/may not/);
    expect(() => assertTransition(S.RIDER_ASSIGNED, S.PICKED_UP, 'RESTAURANT')).toThrow(/may not/);
    expect(() => assertTransition(S.ON_THE_WAY, S.DELIVERED, 'CUSTOMER')).toThrow(/may not/);
  });

  describe('customer cancellation window', () => {
    it('is allowed before cooking starts', () => {
      expect(() => assertTransition(S.PLACED, S.CANCELLED, 'CUSTOMER')).not.toThrow();
      expect(() => assertTransition(S.RESTAURANT_ACCEPTED, S.CANCELLED, 'CUSTOMER', 'changed my mind')).not.toThrow();
    });
    it('is refused once food is being prepared or later', () => {
      for (const from of [S.PREPARING, S.READY_FOR_PICKUP, S.RIDER_ASSIGNED, S.PICKED_UP, S.ON_THE_WAY]) {
        expect(allowedTransitions(from, 'CUSTOMER')).not.toContain(S.CANCELLED);
      }
    });
  });

  describe('reasons', () => {
    it('are required when the restaurant rejects or cancels', () => {
      expect(() => assertTransition(S.PLACED, S.REJECTED_BY_RESTAURANT, 'RESTAURANT')).toThrow(/reason is required/i);
      expect(() => assertTransition(S.PLACED, S.REJECTED_BY_RESTAURANT, 'RESTAURANT', '  ')).toThrow(/reason is required/i);
      expect(() => assertTransition(S.PLACED, S.REJECTED_BY_RESTAURANT, 'RESTAURANT', 'Out of stock')).not.toThrow();
      expect(() => assertTransition(S.PREPARING, S.CANCELLED, 'RESTAURANT')).toThrow(/reason is required/i);
    });
    it('are required for delivery failure and rider reassignment', () => {
      expect(() => assertTransition(S.ON_THE_WAY, S.DELIVERY_FAILED, 'RIDER')).toThrow(/reason is required/i);
      expect(() => assertTransition(S.RIDER_ASSIGNED, S.READY_FOR_PICKUP, 'SYSTEM')).toThrow(/reason is required/i);
      expect(() => assertTransition(S.RIDER_ASSIGNED, S.READY_FOR_PICKUP, 'SYSTEM', 'rider timed out')).not.toThrow();
    });
  });

  it('only the system can enter RIDER_ASSIGNED, and it carries the accepted-assignment precondition', () => {
    expect(allowedTransitions(S.READY_FOR_PICKUP, 'RIDER')).not.toContain(S.RIDER_ASSIGNED);
    expect(allowedTransitions(S.READY_FOR_PICKUP, 'ADMIN')).not.toContain(S.RIDER_ASSIGNED);
    expect(assertTransition(S.READY_FOR_PICKUP, S.RIDER_ASSIGNED, 'SYSTEM').precondition).toBe('ACCEPTED_ASSIGNMENT');
  });

  it('after pickup the delivery can only finish or fail (no cancellation, no reassignment)', () => {
    for (const from of [S.PICKED_UP, S.ON_THE_WAY]) {
      const targets = Object.keys(ORDER_TRANSITIONS[from]);
      expect(targets).not.toContain(S.CANCELLED);
      expect(targets).not.toContain(S.READY_FOR_PICKUP);
    }
  });

  it('every non-initial status is reachable from PENDING_PAYMENT or PLACED', () => {
    const seen = new Set<OrderStatus>([S.PENDING_PAYMENT, S.PLACED]);
    const queue: OrderStatus[] = [S.PENDING_PAYMENT, S.PLACED];
    while (queue.length) {
      const cur = queue.pop()!;
      for (const next of Object.keys(ORDER_TRANSITIONS[cur]) as OrderStatus[]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual(Object.values(S).sort());
  });
});
