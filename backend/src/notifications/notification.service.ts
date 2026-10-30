import type { Notification } from '@prisma/client';
import type { Db } from '../common/db';
import { notFound } from '../common/errors/domain-error';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationInput } from './order-events';

export const NOTIFY_CHANNEL = 'ff_notify';

/**
 * In-app notifications. Producers call `create(tx, …)` INSIDE the transaction that causes the event, so the
 * notification exists if and only if the change committed. `pg_notify` is transactional too: Postgres delivers it
 * only on commit, which is what wakes the realtime fan-out (see fanout.ts). That is the outbox: nothing is lost on
 * a crash (the row is persisted) and nothing is announced for a rolled-back change.
 * Email/push channels can later subscribe the same way (a column to claim deliveries is needed before running several).
 */
export class NotificationService {
  constructor(private readonly prisma: PrismaService) {}

  async create(db: Db, n: NotificationInput): Promise<Notification> {
    const row = await db.notification.create({ data: { userId: n.userId, type: n.type, title: n.title, body: n.body, data: n.data } });
    // pg_notify returns `void`, which Prisma cannot deserialize: select a plain value instead.
    await db.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_notify(${NOTIFY_CHANNEL}, ${row.id})) AS sent`;
    return row;
  }

  async createMany(db: Db, items: readonly NotificationInput[]): Promise<void> {
    for (const n of items) await this.create(db, n);
  }

  async list(userId: string, q: { unread?: boolean; page?: number; limit?: number }) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const where = { userId, ...(q.unread && { readAt: null }) };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.notification.count({ where }),
      this.prisma.notification.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit, select: { id: true, type: true, title: true, body: true, data: true, readAt: true, createdAt: true } }),
    ]);
    return { items, page, limit, total, unreadCount: await this.unreadCount(userId) };
  }

  unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  async markRead(userId: string, id: string) {
    const res = await this.prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
    if (res.count === 0 && !(await this.prisma.notification.findFirst({ where: { id, userId }, select: { id: true } }))) throw notFound('Notification not found');
    return { unreadCount: await this.unreadCount(userId) };
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
    return { unreadCount: 0 };
  }
}
