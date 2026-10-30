import { Prisma } from '@prisma/client';
import { createLogger } from '../common/logger';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  actorId?: string | null;
  action: string; // e.g. "auth.login_failed", "restaurant.approve"
  entityType?: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
  ip?: string;
}
export class AuditService {
  private readonly logger = createLogger(AuditService.name);
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Pass `tx` for sensitive admin actions so the audit row commits atomically with the change.
   * Without `tx` the write is best-effort and never breaks the calling request.
   * Never put passwords, tokens or precise locations in metadata.
   */
  async log(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    const data = {
      actorId: entry.actorId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      metadata: entry.metadata,
      ip: entry.ip,
    };
    if (tx) {
      await tx.auditLog.create({ data });
      return;
    }
    try {
      await this.prisma.auditLog.create({ data });
    } catch (err) {
      this.logger.error(`Failed to write audit log for ${entry.action}: ${(err as Error).message}`);
    }
  }
}
