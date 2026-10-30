import { Client } from 'pg';
import { createLogger } from '../common/logger';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeHub } from '../realtime/hub';
import { NOTIFY_CHANNEL, NotificationService } from './notification.service';

const log = createLogger('NotificationFanout');

/**
 * Pushes new notifications to connected users the moment the producing transaction COMMITS (Postgres LISTEN/NOTIFY).
 * Works across several API instances (each pushes to its own sockets). If the listener connection drops it reconnects;
 * notifications are persisted, so a missed push only delays the badge until the client's next fetch.
 */
export class NotificationFanout {
  private client?: Client;
  private stopped = false;
  private retry?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService, private readonly notifications: NotificationService, private readonly hub: RealtimeHub, private readonly databaseUrl: string) {}

  async start(): Promise<void> {
    this.stopped = false;
    const url = new URL(this.databaseUrl);
    url.searchParams.delete('schema'); // a Prisma-only parameter
    const client = new Client({ connectionString: url.toString() });
    client.on('notification', (m) => { if (m.channel === NOTIFY_CHANNEL && m.payload) void this.deliver(m.payload); });
    const reconnect = () => { if (!this.stopped && !this.retry) this.retry = setTimeout(() => { this.retry = undefined; void this.start().catch(() => undefined); }, 2000); };
    client.on('error', (e) => { log.warn(`listener error: ${e.message}`); reconnect(); });
    client.on('end', reconnect);
    try {
      await client.connect();
      await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
      this.client = client;
    } catch (e) {
      log.warn(`could not start listener: ${(e as Error).message}`);
      reconnect();
    }
  }

  async deliver(id: string): Promise<void> {
    try {
      const row = await this.prisma.notification.findUnique({ where: { id } });
      if (!row) return;
      this.hub.toUser(row.userId, 'notification', {
        id: row.id, type: row.type, title: row.title, body: row.body, data: row.data, createdAt: row.createdAt, readAt: row.readAt, unreadCount: await this.notifications.unreadCount(row.userId),
      });
    } catch (e) {
      log.error(`fan-out of ${id} failed: ${(e as Error).message}`);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    const c = this.client;
    this.client = undefined;
    await c?.end().catch(() => undefined);
  }
}
