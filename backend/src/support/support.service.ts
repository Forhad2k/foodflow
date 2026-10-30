import { NotificationType, Prisma, Role, TicketCategory, TicketStatus } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import { DomainError, notFound } from '../common/errors/domain-error';
import type { NotificationService } from '../notifications/notification.service';
import type { PrismaService } from '../prisma/prisma.service';

const OPEN: TicketStatus[] = [TicketStatus.OPEN, TicketStatus.IN_PROGRESS, TicketStatus.AWAITING_CUSTOMER];

/**
 * Support, order issues and disputes. Any signed-in user can raise a ticket (about an order they are part of); the
 * conversation is private to them and the support team. Admin-only internal notes are never shown to the requester.
 */
export class SupportService {
  constructor(private readonly prisma: PrismaService, private readonly notifications: NotificationService, private readonly audit: AuditService) {}

  async create(user: { id: string; role: Role }, input: { category: TicketCategory; subject: string; description: string; orderId?: string }) {
    if ((await this.prisma.supportTicket.count({ where: { creatorId: user.id, createdAt: { gte: new Date(Date.now() - 3_600_000) } } })) >= 5) {
      throw new DomainError('RATE_LIMITED', 'You have opened several tickets recently. Please wait before opening another.', 429);
    }
    if (input.orderId && !(await this.isPartyToOrder(user, input.orderId))) throw notFound('Order not found'); // you cannot file a ticket about someone else's order
    return this.prisma.supportTicket.create({
      data: { creatorId: user.id, category: input.category, subject: input.subject.trim(), description: input.description.trim(), orderId: input.orderId ?? null },
      select: { id: true, status: true, category: true, subject: true, orderId: true, createdAt: true },
    });
  }

  async mine(userId: string, q: { status?: TicketStatus; page?: number; limit?: number }) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const where: Prisma.SupportTicketWhereInput = { creatorId: userId, ...(q.status && { status: q.status }) };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.findMany({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit, select: { id: true, category: true, status: true, subject: true, orderId: true, updatedAt: true } }),
    ]);
    return { items, page, limit, total };
  }

  async getMine(userId: string, id: string) {
    const t = await this.prisma.supportTicket.findFirst({
      where: { id, creatorId: userId },
      select: { id: true, category: true, status: true, subject: true, description: true, orderId: true, resolution: true, createdAt: true, resolvedAt: true, messages: { where: { isInternal: false }, orderBy: { createdAt: 'asc' }, select: { id: true, body: true, createdAt: true, authorId: true, author: { select: { role: true } } } } },
    });
    if (!t) throw notFound('Ticket not found'); // someone else's ticket is "not found"
    return { ...t, messages: t.messages.map(({ author, ...m }) => ({ ...m, fromSupport: author.role === Role.ADMIN })) };
  }

  async reply(userId: string, id: string, body: string) {
    const t = await this.prisma.supportTicket.findFirst({ where: { id, creatorId: userId }, select: { status: true } });
    if (!t) throw notFound('Ticket not found');
    if (t.status === TicketStatus.CLOSED) throw new DomainError('TICKET_CLOSED', 'This ticket is closed. Open a new one.', 409);
    return this.prisma.$transaction(async (tx) => {
      const m = await tx.ticketMessage.create({ data: { ticketId: id, authorId: userId, body: body.trim() }, select: { id: true, createdAt: true } });
      if (t.status === TicketStatus.AWAITING_CUSTOMER || t.status === TicketStatus.RESOLVED) await tx.supportTicket.update({ where: { id }, data: { status: TicketStatus.IN_PROGRESS, resolvedAt: null } });
      else await tx.supportTicket.update({ where: { id }, data: { updatedAt: new Date() } });
      return m;
    });
  }

  async close(userId: string, id: string) {
    const res = await this.prisma.supportTicket.updateMany({ where: { id, creatorId: userId, status: { not: TicketStatus.CLOSED } }, data: { status: TicketStatus.CLOSED } });
    if (res.count === 0) throw notFound('Ticket not found');
    return { id, status: TicketStatus.CLOSED };
  }

  // ───────── admin ─────────
  async adminList(q: { status?: TicketStatus; category?: TicketCategory; assigneeId?: string; unassigned?: boolean; open?: boolean; page?: number; limit?: number }) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const where: Prisma.SupportTicketWhereInput = { ...(q.status && { status: q.status }), ...(q.open && { status: { in: OPEN } }), ...(q.category && { category: q.category }), ...(q.assigneeId && { assigneeId: q.assigneeId }), ...(q.unassigned && { assigneeId: null }) };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit, select: { id: true, category: true, status: true, subject: true, orderId: true, assigneeId: true, createdAt: true, creator: { select: { id: true, email: true, role: true } } } }),
    ]);
    return { items, page, limit, total };
  }

  async adminGet(id: string) {
    const t = await this.prisma.supportTicket.findUnique({ where: { id }, include: { creator: { select: { id: true, email: true, role: true, profile: { select: { fullName: true } } } }, order: { select: { id: true, orderNumber: true, status: true, totalMinor: true } }, messages: { orderBy: { createdAt: 'asc' } } } });
    if (!t) throw notFound('Ticket not found');
    return t;
  }

  async adminReply(adminId: string, id: string, input: { body: string; isInternal?: boolean }) {
    const t = await this.prisma.supportTicket.findUnique({ where: { id }, select: { creatorId: true, status: true, subject: true, assigneeId: true } });
    if (!t) throw notFound('Ticket not found');
    return this.prisma.$transaction(async (tx) => {
      const m = await tx.ticketMessage.create({ data: { ticketId: id, authorId: adminId, body: input.body.trim(), isInternal: input.isInternal ?? false }, select: { id: true, isInternal: true, createdAt: true } });
      if (!input.isInternal) {
        await tx.supportTicket.update({ where: { id }, data: { status: TicketStatus.AWAITING_CUSTOMER, assigneeId: t.assigneeId ?? adminId } });
        await this.notifications.create(tx, { userId: t.creatorId, type: NotificationType.SUPPORT, title: 'Support replied', body: `New reply on "${t.subject}".`, data: { ticketId: id } });
      }
      return m;
    });
  }

  async assign(adminId: string, id: string, assigneeId: string | null, ip?: string) {
    if (assigneeId && !(await this.prisma.user.findFirst({ where: { id: assigneeId, role: Role.ADMIN, status: 'ACTIVE' }, select: { id: true } }))) throw new DomainError('INVALID_ASSIGNEE', 'Tickets can only be assigned to active admins', 422);
    const res = await this.prisma.supportTicket.updateMany({ where: { id }, data: { assigneeId, ...(assigneeId && { status: TicketStatus.IN_PROGRESS }) } });
    if (res.count === 0) throw notFound('Ticket not found');
    await this.audit.log({ actorId: adminId, action: 'support.assign', entityType: 'SupportTicket', entityId: id, ip, metadata: { assigneeId } });
    return { id, assigneeId };
  }

  async setStatus(adminId: string, id: string, status: TicketStatus, resolution?: string, ip?: string) {
    if (status === TicketStatus.RESOLVED && !resolution?.trim()) throw new DomainError('RESOLUTION_REQUIRED', 'Describe how the issue was resolved', 422);
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.supportTicket.findUnique({ where: { id }, select: { creatorId: true, subject: true } });
      if (!t) throw notFound('Ticket not found');
      await tx.supportTicket.update({ where: { id }, data: { status, ...(resolution && { resolution: resolution.trim() }), resolvedAt: status === TicketStatus.RESOLVED ? new Date() : null } });
      if (status === TicketStatus.RESOLVED) await this.notifications.create(tx, { userId: t.creatorId, type: NotificationType.SUPPORT, title: 'Issue resolved', body: `"${t.subject}": ${resolution!.trim()}`, data: { ticketId: id } });
      await this.audit.log({ actorId: adminId, action: 'support.status', entityType: 'SupportTicket', entityId: id, ip, metadata: { status } }, tx);
      return { id, status };
    });
  }

  private async isPartyToOrder(user: { id: string; role: Role }, orderId: string): Promise<boolean> {
    const o = await this.prisma.order.findUnique({ where: { id: orderId }, select: { customerId: true, restaurant: { select: { ownerId: true } }, assignments: { select: { riderId: true } } } });
    if (!o) return false;
    return o.customerId === user.id || o.restaurant.ownerId === user.id || o.assignments.some((a) => a.riderId === user.id);
  }
}
