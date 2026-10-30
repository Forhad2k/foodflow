import type { Container } from './container';

/**
 * Background jobs as plain timers. Every job is safe to run on several instances at once (they lock rows and
 * re-check state), so scaling the API out needs no leader election. Returns a function that stops them.
 */
export function startJobs(c: Container): () => void {
  if (!c.env.JOBS_ENABLED) return () => undefined;
  const timers = [
    setInterval(() => void c.dispatch.tick(), 5_000), // expire stale offers, offer waiting orders, drop silent riders
    setInterval(() => void c.orderTimeout.tick(), 30_000), // reject orders the restaurant never answered
    setInterval(() => void c.payments.reconcilePending().catch(() => undefined), 60_000), // lost payment callbacks + payment timeout
    setInterval(() => void c.refunds.processPending().catch(() => undefined), 30_000), // pay out approved refunds
    setInterval(() => void Promise.all([c.tracking.purgeOld(), c.chat.purgeExpired()]).catch(() => undefined), 3_600_000), // retention policy: precise positions and old chats are deleted
  ];
  timers.forEach((t) => t.unref());
  return () => timers.forEach(clearInterval);
}
