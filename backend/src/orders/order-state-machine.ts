import { OrderStatus } from '@prisma/client';
import { DomainError } from '../common/errors/domain-error';

/**
 * Order lifecycle: the single source of truth for which status changes exist and who may perform them.
 * Pure data + pure functions: no I/O, so it is trivially unit-testable and shared by every caller.
 *
 *   PENDING_PAYMENT ──► PLACED ──► RESTAURANT_ACCEPTED ──► PREPARING ──► READY_FOR_PICKUP ──► RIDER_ASSIGNED
 *                                                                                                  │
 *                                         DELIVERED ◄── ON_THE_WAY ◄── PICKED_UP ◄─────────────────┘
 *   Exits: REJECTED_BY_RESTAURANT, CANCELLED, PAYMENT_FAILED, DELIVERY_FAILED
 *
 * Rider dispatch runs in parallel with cooking (see DeliveryAssignment). RIDER_ASSIGNED is the join point:
 * it is entered by the SYSTEM once the food is READY_FOR_PICKUP *and* an ACCEPTED assignment exists, in either order.
 * Refunds are a separate lifecycle (Refund.status), not an order status.
 */
export type TransitionActor = 'CUSTOMER' | 'RESTAURANT' | 'RIDER' | 'ADMIN' | 'SYSTEM';

export interface TransitionRule {
  /** Who may trigger this transition. */
  actors: readonly TransitionActor[];
  /** A human-readable reason must accompany the change (stored in OrderStatusHistory + Order.cancelReason). */
  requiresReason?: boolean;
  /** Extra precondition the transition service must verify inside the transaction. */
  precondition?: 'ACCEPTED_ASSIGNMENT';
}


const S = OrderStatus;

export const ORDER_TRANSITIONS: Record<OrderStatus, Partial<Record<OrderStatus, TransitionRule>>> = {
  [S.PENDING_PAYMENT]: {
    [S.PLACED]: { actors: ['SYSTEM'] }, // verified online payment
    [S.PAYMENT_FAILED]: { actors: ['SYSTEM'] },
    [S.CANCELLED]: { actors: ['CUSTOMER', 'SYSTEM', 'ADMIN'] }, // customer abandons / payment window times out
  },
  [S.PLACED]: {
    [S.RESTAURANT_ACCEPTED]: { actors: ['RESTAURANT', 'ADMIN'] },
    [S.REJECTED_BY_RESTAURANT]: { actors: ['RESTAURANT', 'SYSTEM', 'ADMIN'], requiresReason: true }, // SYSTEM = accept timeout
    [S.CANCELLED]: { actors: ['CUSTOMER', 'ADMIN'], requiresReason: false },
  },
  [S.RESTAURANT_ACCEPTED]: {
    [S.PREPARING]: { actors: ['RESTAURANT', 'ADMIN'] },
    [S.CANCELLED]: { actors: ['CUSTOMER', 'RESTAURANT', 'ADMIN'], requiresReason: true }, // customer may cancel until cooking starts
  },
  [S.PREPARING]: {
    [S.READY_FOR_PICKUP]: { actors: ['RESTAURANT', 'ADMIN'] },
    [S.CANCELLED]: { actors: ['RESTAURANT', 'ADMIN'], requiresReason: true }, // e.g. ingredient shortage; customer can no longer cancel
  },
  [S.READY_FOR_PICKUP]: {
    [S.RIDER_ASSIGNED]: { actors: ['SYSTEM'], precondition: 'ACCEPTED_ASSIGNMENT' },
    [S.CANCELLED]: { actors: ['ADMIN'], requiresReason: true },
  },
  [S.RIDER_ASSIGNED]: {
    [S.PICKED_UP]: { actors: ['RIDER'] },
    [S.READY_FOR_PICKUP]: { actors: ['SYSTEM', 'ADMIN'], requiresReason: true }, // rider dropped / reassigned → back to dispatch
    [S.CANCELLED]: { actors: ['ADMIN'], requiresReason: true },
  },
  [S.PICKED_UP]: {
    [S.ON_THE_WAY]: { actors: ['RIDER'] },
    [S.DELIVERY_FAILED]: { actors: ['RIDER', 'ADMIN'], requiresReason: true },
  },
  [S.ON_THE_WAY]: {
    [S.DELIVERED]: { actors: ['RIDER', 'ADMIN'] },
    [S.DELIVERY_FAILED]: { actors: ['RIDER', 'ADMIN'], requiresReason: true },
  },
  // Terminal states: no outgoing transitions.
  [S.DELIVERED]: {},
  [S.REJECTED_BY_RESTAURANT]: {},
  [S.CANCELLED]: {},
  [S.PAYMENT_FAILED]: {},
  [S.DELIVERY_FAILED]: {},
};

export const TERMINAL_STATUSES: readonly OrderStatus[] = (Object.keys(ORDER_TRANSITIONS) as OrderStatus[]).filter(
  (s) => Object.keys(ORDER_TRANSITIONS[s]).length === 0,
);

export const isTerminal = (s: OrderStatus): boolean => TERMINAL_STATUSES.includes(s);

export class InvalidOrderTransitionError extends DomainError {
  constructor(from: OrderStatus, to: OrderStatus, reason: string) {
    super('INVALID_ORDER_TRANSITION', `Cannot move order from ${from} to ${to}: ${reason}`, 409, { from, to });
  }
}

export function getRule(from: OrderStatus, to: OrderStatus): TransitionRule | undefined {
  return ORDER_TRANSITIONS[from]?.[to];
}

export function allowedTransitions(from: OrderStatus, actor: TransitionActor): OrderStatus[] {
  return (Object.entries(ORDER_TRANSITIONS[from]) as [OrderStatus, TransitionRule][])
    .filter(([, rule]) => rule.actors.includes(actor))
    .map(([to]) => to);
}

/** Throws unless `actor` may move an order from `from` to `to`. Returns the matching rule. */
export function assertTransition(
  from: OrderStatus,
  to: OrderStatus,
  actor: TransitionActor,
  reason?: string,
): TransitionRule {
  const rule = getRule(from, to);
  if (!rule) throw new InvalidOrderTransitionError(from, to, 'transition does not exist');
  if (!rule.actors.includes(actor)) {
    throw new DomainError('FORBIDDEN_ORDER_TRANSITION', `${actor} may not move an order from ${from} to ${to}`, 403, { from, to });
  }
  if (rule.requiresReason && !reason?.trim()) {
    throw new DomainError('REASON_REQUIRED', `A reason is required to move an order to ${to}`, 422, { to });
  }
  return rule;
}
