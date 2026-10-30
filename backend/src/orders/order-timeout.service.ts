import { OrderStatus, Role } from '@prisma/client';
import { createLogger } from '../common/logger';
import { DomainError } from '../common/errors/domain-error';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { OrderTransitionService } from './order-transition.service';

const BATCH = 50;

/**
 * A restaurant that never answers must not leave a customer waiting forever: after
 * `order.restaurantAcceptTimeoutSeconds` an unanswered PLACED order is rejected by the SYSTEM (stock, coupon and
 * pending cash payment are released by the transition itself).
 * Safe on several instances at once: every transition locks the order row and re-checks its status, so a
 * duplicate attempt just fails with an invalid-transition error that this job ignores.
 */
export class OrderTimeoutService {
  private readonly logger = createLogger(OrderTimeoutService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly transitions: OrderTransitionService,
    private readonly settings: SettingsService,
    private readonly config: Env,
  ) {}
  async tick() {
    if (!this.config.JOBS_ENABLED || this.running) return;
    this.running = true;
    try {
      await this.rejectUnansweredOrders();
    } catch (err) {
      this.logger.error(`Order timeout sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async rejectUnansweredOrders(now = new Date()): Promise<number> {
    const s = await this.settings.get();
    const cutoff = new Date(now.getTime() - s['order.restaurantAcceptTimeoutSeconds'] * 1000);
    const stale = await this.prisma.order.findMany({
      where: { status: OrderStatus.PLACED, placedAt: { lt: cutoff } },
      orderBy: { placedAt: 'asc' },
      take: BATCH,
      select: { id: true },
    });
    let done = 0;
    for (const { id } of stale) {
      try {
        await this.transitions.transition({ orderId: id, to: OrderStatus.REJECTED_BY_RESTAURANT, actor: { role: 'SYSTEM' }, reason: 'Restaurant did not respond in time' });
        done++;
      } catch (err) {
        if (!(err instanceof DomainError)) this.logger.error(`Could not time out order ${id}: ${(err as Error).message}`); // DomainError = someone else got there first
      }
    }
    if (done) this.logger.log(`Rejected ${done} unanswered order(s)`);
    return done;
  }
}
