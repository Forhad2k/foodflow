import { Prisma, ReportStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import type { AuditService } from '../audit/audit.service';
import { DomainError, notFound } from '../common/errors/domain-error';
import { isTerminal } from '../orders/order-state-machine';
import type { PrismaService } from '../prisma/prisma.service';
import type { SettingsService } from '../settings/settings.service';
import { rooms, RealtimeHub } from './hub';

type Party = 'CUSTOMER' | 'RIDER';
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const isUnique = (e: unknown) => (e as { code?: string })?.code === 'P2002';

/**
 * Order-specific rider chat. There is no global inbox and no directory: a conversation exists only for an order whose
 * delivery a rider has accepted, and its only members are that order's customer and the CURRENT rider.
 * Every operation (join, history, send, read, report) re-derives membership from the database. Nothing is cached
 * from connect time, so a replaced rider loses access on their very next action (and is evicted before any broadcast).
 */
export class ChatService {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly hub: RealtimeHub,
    private readonly audit: AuditService,
  ) {}

  /** Membership + state checks shared by every operation. Non-members get the same 404 as "no such chat". */
  async access(userId: string, orderId: string, mode: 'read' | 'send') {
    const s = await this.settings.get();
    const room = await this.prisma.orderChatRoom.findUnique({
      where: { orderId },
      include: { order: { select: { status: true, orderNumber: true } }, assignment: { select: { status: true } } },
    });
    const party: Party | null = !room ? null : userId === room.customerId ? 'CUSTOMER' : userId === room.riderId ? 'RIDER' : null;
    if (!room || !party) throw new DomainError('CHAT_NOT_AVAILABLE', 'Chat is not available for this order', 404);
    const expired = room.closedAt && room.closedAt.getTime() < Date.now() - s['chat.retentionDays'] * 86_400_000;
    if (expired) throw new DomainError('CHAT_NOT_AVAILABLE', 'Chat is not available for this order', 404);
    if (mode === 'send') {
      const closed = room.closedAt || isTerminal(room.order.status) || (party === 'RIDER' && room.assignment.status !== 'ACCEPTED');
      if (closed) throw new DomainError('CHAT_CLOSED', 'This conversation is closed', 409);
    }
    return { room, party, settings: s };
  }

  async history(userId: string, orderId: string, q: { before?: Date; limit?: number } = {}) {
    const { room, party } = await this.access(userId, orderId, 'read');
    const limit = q.limit ?? 50;
    // A rider only sees the conversation from the moment they took the delivery; the customer sees everything.
    const visible: Prisma.ChatMessageWhereInput = { roomId: room.id, ...(party === 'RIDER' && { createdAt: { gte: room.openedAt } }) };
    const rows = await this.prisma.chatMessage.findMany({
      where: { ...visible, ...(q.before && { createdAt: { lt: q.before } }) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit).reverse();
    return {
      messages: page.map((m) => this.view(m, room)),
      hasMore: rows.length > limit,
      unread: await this.prisma.chatMessage.count({ where: { ...visible, senderId: { not: userId }, readAt: null } }),
      room: { open: !room.closedAt && !isTerminal(room.order.status), orderNumber: room.order.orderNumber },
    };
  }

  async send(userId: string, orderId: string, input: { body: string; clientMessageId?: string }) {
    const { room, party, settings: s } = await this.access(userId, orderId, 'send');
    const body = input.body.replace(CONTROL, '').trim();
    if (!body) throw new DomainError('INVALID_MESSAGE', 'Message is empty', 422);
    if (body.length > s['chat.maxMessageLength']) throw new DomainError('MESSAGE_TOO_LONG', `Messages are limited to ${s['chat.maxMessageLength']} characters`, 422);
    const clientMessageId = input.clientMessageId ?? randomUUID();

    // Retrying with the same clientMessageId returns the original message and does not count against the limit.
    const existing = await this.prisma.chatMessage.findUnique({ where: { roomId_clientMessageId: { roomId: room.id, clientMessageId } } });
    if (existing) return { message: this.view(existing, room), duplicate: true };

    this.throttle(userId, s['chat.messagesPerMinute']);
    let row;
    try {
      row = await this.prisma.chatMessage.create({ data: { roomId: room.id, senderId: userId, body, clientMessageId } });
    } catch (e) {
      if (!isUnique(e)) throw e;
      const again = await this.prisma.chatMessage.findUniqueOrThrow({ where: { roomId_clientMessageId: { roomId: room.id, clientMessageId } } });
      return { message: this.view(again, room), duplicate: true };
    }

    const recipientId = party === 'CUSTOMER' ? room.riderId : room.customerId;
    const channel = rooms.chat(orderId);
    await this.hub.prune(channel, new Set([room.customerId, room.riderId])); // never broadcast to a stale member
    const message = this.view(row, room);
    this.hub.toRoom(channel, 'chat:message', message);
    if ((await this.hub.userIdsIn(channel)).has(recipientId)) {
      const deliveredAt = new Date();
      await this.prisma.chatMessage.update({ where: { id: row.id }, data: { deliveredAt } });
      message.deliveredAt = deliveredAt;
      this.hub.toRoom(channel, 'chat:delivered', { messageId: row.id, deliveredAt });
    }
    return { message, duplicate: false };
  }

  async markRead(userId: string, orderId: string, upToMessageId?: string) {
    const { room, party } = await this.access(userId, orderId, 'read');
    let upTo: Date | undefined;
    if (upToMessageId) upTo = (await this.prisma.chatMessage.findFirst({ where: { id: upToMessageId, roomId: room.id }, select: { createdAt: true } }))?.createdAt;
    const where: Prisma.ChatMessageWhereInput = { roomId: room.id, senderId: { not: userId }, readAt: null, ...(upTo && { createdAt: { lte: upTo } }), ...(party === 'RIDER' && { createdAt: { gte: room.openedAt, ...(upTo && { lte: upTo }) } }) };
    const readAt = new Date();
    await this.prisma.chatMessage.updateMany({ where: { ...where, deliveredAt: null }, data: { deliveredAt: readAt } });
    const res = await this.prisma.chatMessage.updateMany({ where, data: { readAt } });
    if (res.count) this.hub.toRoom(rooms.chat(orderId), 'chat:read', { readerId: userId, upToMessageId: upToMessageId ?? null, readAt });
    return { marked: res.count };
  }

  /** Abuse reporting: a participant reports a message sent by the OTHER party. */
  async report(userId: string, orderId: string, messageId: string, reason: string) {
    const { room, party } = await this.access(userId, orderId, 'read');
    const msg = await this.prisma.chatMessage.findFirst({
      where: { id: messageId, roomId: room.id, senderId: { not: userId }, ...(party === 'RIDER' && { createdAt: { gte: room.openedAt } }) },
      select: { id: true },
    });
    if (!msg) throw notFound('Message not found');
    try {
      const r = await this.prisma.chatMessageReport.create({ data: { messageId, reporterId: userId, reason: reason.trim() }, select: { id: true } });
      return { id: r.id };
    } catch (e) {
      if (isUnique(e)) throw new DomainError('ALREADY_REPORTED', 'You already reported this message', 409);
      throw e;
    }
  }

  // ───────── admin moderation ─────────
  async listReports(q: { status?: ReportStatus; page?: number; limit?: number }) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const where = q.status ? { status: q.status } : {};
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.chatMessageReport.count({ where }),
      this.prisma.chatMessageReport.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit,
        select: { id: true, reason: true, status: true, createdAt: true, reporter: { select: { id: true, email: true } }, message: { select: { id: true, body: true, createdAt: true, senderId: true, room: { select: { orderId: true, order: { select: { orderNumber: true } } } } } } },
      }),
    ]);
    return { items: rows, page, limit, total };
  }

  async reviewReport(adminId: string, id: string, status: ReportStatus, ip?: string) {
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.chatMessageReport.findUnique({ where: { id }, select: { status: true } });
      if (!r) throw notFound('Report not found');
      await tx.chatMessageReport.update({ where: { id }, data: { status } });
      await this.audit.log({ actorId: adminId, action: `chat.report_${status.toLowerCase()}`, entityType: 'ChatMessageReport', entityId: id, ip, metadata: { from: r.status } }, tx);
      return { id, status };
    });
  }

  /** Deletes conversations that ended more than `chat.retentionDays` ago. */
  async purgeExpired(now = new Date()): Promise<number> {
    const s = await this.settings.get();
    const cutoff = new Date(now.getTime() - s['chat.retentionDays'] * 86_400_000);
    return (await this.prisma.orderChatRoom.deleteMany({ where: { closedAt: { lt: cutoff } } })).count; // messages cascade
  }

  private view(m: { id: string; senderId: string; body: string; createdAt: Date; deliveredAt: Date | null; readAt: Date | null; roomId: string; clientMessageId: string }, room: { customerId: string; riderId: string; orderId: string }) {
    return {
      id: m.id, orderId: room.orderId, senderId: m.senderId, senderRole: (m.senderId === room.customerId ? 'CUSTOMER' : 'RIDER') as Party,
      body: m.body, clientMessageId: m.clientMessageId, createdAt: m.createdAt, deliveredAt: m.deliveredAt as Date | null, readAt: m.readAt as Date | null,
    };
  }

  /** Sliding-window limit per sender (in-memory; per instance). */
  private throttle(userId: string, perMinute: number) {
    const now = Date.now();
    const recent = (this.hits.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= perMinute) throw new DomainError('RATE_LIMITED', 'You are sending messages too quickly', 429);
    recent.push(now);
    this.hits.set(userId, recent);
  }
}
