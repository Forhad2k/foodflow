import type { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { ZodTypeAny, z } from 'zod';
import { resolveSession } from '../auth/session-auth';
import { DomainError, unauthorized } from '../common/errors/domain-error';
import { createLogger } from '../common/logger';
import type { Container } from '../container';
import { chatReadSocket, chatSendSocket, orderRef, riderLocationSocket } from '../schemas/realtime';
import { parse } from '../http/validate';
import { rooms } from './hub';

const log = createLogger('realtime');
type Ack = (r: unknown) => void;
const EVENTS_PER_10S = 100;

/**
 * Socket.IO glue. Deliberately thin: every rule lives in ChatService / TrackingService, which are also what the REST
 * fallbacks call.  What this layer guarantees:
 *  - the handshake needs a valid access token for a live session (same check as HTTP)
 *  - the session is re-checked on EVERY event, so a logout or suspension cuts a connected socket off immediately
 *  - rooms are joined only after the server authorizes the order; the client can never name a room directly
 *  - handlers never throw to the client: they acknowledge { ok: true, … } or { ok: false, error: { code, message } }
 */
export class RealtimeGateway {
  readonly io: Server;
  /** orderId → tracking-room watchers on THIS instance (drives the end/stale sweep). */
  private readonly watched = new Map<string, { stale: boolean }>();

  constructor(private readonly c: Container, server: HttpServer) {
    this.io = new Server(server, { cors: { origin: c.env.CORS_ORIGINS, credentials: true }, maxHttpBufferSize: 16 * 1024, serveClient: false });
    c.hub.attach(this.io);
    this.io.use(async (socket, next) => {
      try {
        const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
        if (typeof token !== 'string') throw unauthorized('Missing token');
        socket.data.user = await resolveSession(c, token);
        next();
      } catch {
        next(new Error('UNAUTHORIZED'));
      }
    });
    this.io.on('connection', (socket) => this.onConnection(socket));
  }

  private onConnection(socket: Socket) {
    const user = socket.data.user;
    void socket.join(rooms.user(user.id)); // own notifications only
    let budget = EVENTS_PER_10S;
    const refill = setInterval(() => (budget = EVENTS_PER_10S), 10_000);
    refill.unref();

    const on = <S extends ZodTypeAny>(event: string, schema: S, handler: (data: z.output<S>) => Promise<Record<string, unknown> | void>) => {
      socket.on(event, async (payload: unknown, ack?: Ack) => {
        const reply = typeof ack === 'function' ? ack : () => undefined;
        try {
          if (--budget < 0) throw new DomainError('RATE_LIMITED', 'Too many events', 429);
          await this.revalidate(socket);
          reply({ ok: true, ...((await handler(parse(schema, payload))) ?? {}) });
        } catch (e) {
          reply({ ok: false, error: this.errorOf(e) }); // tell the client first…
          if (e instanceof DomainError && e.code === 'UNAUTHORIZED') {
            socket.emit('auth:expired', {}); // …then cut the connection off
            setTimeout(() => socket.disconnect(true), 50).unref();
          }
        }
      });
    };

    // ── notifications ──
    on('notifications:sync', z.object({}).strict(), async () => ({ unreadCount: await this.c.notifications.unreadCount(user.id) }));

    // ── tracking ──
    on('tracking:subscribe', orderRef, async ({ orderId }) => {
      const ctx = await this.c.tracking.authorizeViewer(user, orderId);
      await socket.join(rooms.tracking(orderId));
      (socket.data.tracked ??= new Set<string>()).add(orderId);
      if (!this.watched.has(orderId)) this.watched.set(orderId, { stale: false });
      return await this.c.tracking.latest(orderId, ctx.assignmentId);
    });
    on('tracking:unsubscribe', orderRef, async ({ orderId }) => {
      await socket.leave(rooms.tracking(orderId));
      socket.data.tracked?.delete(orderId);
    });
    on('rider:location', riderLocationSocket, async (input) => {
      const payload = await this.c.tracking.record(user.id, input);
      const room = rooms.tracking(input.orderId);
      const ctx = await this.c.tracking.authorizeViewer(user, input.orderId); // who may receive it, decided now
      const allowed = new Set([ctx.riderId, (await this.c.prisma.order.findUniqueOrThrow({ where: { id: input.orderId }, select: { customerId: true } })).customerId]);
      const admins = await this.adminsIn(room);
      await this.c.hub.prune(room, new Set([...allowed, ...admins]));
      this.io.to(room).emit('tracking:location', payload);
      const w = this.watched.get(input.orderId);
      if (w?.stale) { w.stale = false; this.io.to(room).emit('tracking:fresh', { orderId: input.orderId }); }
      return { recordedAt: payload.recordedAt };
    });

    // ── chat ──
    on('chat:join', orderRef, async ({ orderId }) => {
      const history = await this.c.chat.history(user.id, orderId); // authorizes (membership + retention) as a side effect
      await socket.join(rooms.chat(orderId));
      return history;
    });
    on('chat:leave', orderRef, async ({ orderId }) => { await socket.leave(rooms.chat(orderId)); });
    on('chat:send', chatSendSocket, async ({ orderId, body, clientMessageId }) => {
      const { message, duplicate } = await this.c.chat.send(user.id, orderId, { body, clientMessageId });
      return { message, duplicate };
    });
    on('chat:read', chatReadSocket, async ({ orderId, upToMessageId }) => this.c.chat.markRead(user.id, orderId, upToMessageId));

    socket.on('disconnect', () => {
      clearInterval(refill);
      // A rider whose app dropped: tell the people watching so they are not misled by a frozen marker.
      if (user.role === 'RIDER') for (const orderId of socket.data.tracked ?? []) this.io.to(rooms.tracking(orderId)).emit('tracking:rider_disconnected', { orderId, at: new Date() });
    });
  }

  /** Periodic sweep for tracking rooms on this instance: end finished deliveries, flag silent riders. Public for tests. */
  async tick(now = new Date()) {
    const { ended, silent } = await this.c.tracking.inspect([...this.watched.keys()], now);
    for (const { orderId, reason } of ended) {
      const room = rooms.tracking(orderId);
      this.io.to(room).emit('tracking:ended', { orderId, reason });
      this.io.in(room).socketsLeave(room);
      this.watched.delete(orderId);
    }
    for (const [orderId, w] of this.watched) {
      const at = silent.get(orderId);
      if (at && !w.stale) { w.stale = true; this.io.to(rooms.tracking(orderId)).emit('tracking:stale', { orderId, lastUpdateAt: at }); }
    }
    return { ended: ended.length, silent: silent.size };
  }

  private async adminsIn(room: string): Promise<string[]> {
    return (await this.io.in(room).fetchSockets()).filter((s) => s.data.user?.role === 'ADMIN').map((s) => s.data.user.id);
  }

  private async revalidate(socket: Socket) {
    const u = await this.c.prisma.session.findUnique({ where: { id: socket.data.user.sessionId }, select: { revokedAt: true, expiresAt: true } });
    const current = await resolveSessionFromSocket(this.c, socket);
    if (!u || u.revokedAt || u.expiresAt < new Date() || current.role !== socket.data.user.role) throw unauthorized('Session ended');
  }

  private errorOf(e: unknown) {
    if (e instanceof DomainError) return { code: e.code, message: e.message, ...(e.details !== undefined && { details: e.details }) };
    log.error(e instanceof Error ? e.stack ?? e.message : String(e));
    return { code: 'INTERNAL_ERROR', message: 'Something went wrong' };
  }

  close(): Promise<void> {
    return new Promise((r) => this.io.close(() => r()));
  }
}

async function resolveSessionFromSocket(c: Container, socket: Socket) {
  const u = await c.prisma.user.findUnique({ where: { id: socket.data.user.id }, select: { id: true, role: true, status: true } });
  if (!u || u.status !== 'ACTIVE') throw unauthorized('Account unavailable');
  return u;
}
