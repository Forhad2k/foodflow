import { ApprovalStatus, AssignmentStatus, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/errors/domain-error';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalAction, applyApprovalAction } from '../restaurants/approval';
import { isOwnStorageKey, missingForRiderApproval } from '../riders/rider-rules';
import { AdminListRidersDto, ReviewDocumentDto } from '../schemas/admin';
import { RiderDocumentStorage } from '../riders/document-storage';
export class AdminRidersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly documentStorage: RiderDocumentStorage,
  ) {}

  async list(q: AdminListRidersDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const where: Prisma.RiderProfileWhereInput = {
      ...(q.status && { approvalStatus: q.status }),
      ...(q.q && { user: { OR: [{ email: { contains: q.q.toLowerCase() } }, { profile: { fullName: { contains: q.q, mode: 'insensitive' } } }] } }),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.riderProfile.count({ where }),
      this.prisma.riderProfile.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { userId: 'asc' }], skip: (page - 1) * limit, take: limit,
        select: {
          userId: true, approvalStatus: true, vehicleType: true, isOnline: true, createdAt: true,
          user: { select: { email: true, phone: true, profile: { select: { fullName: true } } } },
          documents: { select: { id: true, type: true, status: true } },
        },
      }),
    ]);
    return {
      items: items.map((rider) => ({
        id: rider.userId,
        fullName: rider.user.profile?.fullName ?? '',
        email: rider.user.email,
        phone: rider.user.phone,
        approvalStatus: rider.approvalStatus,
        vehicleType: rider.vehicleType,
        isOnline: rider.isOnline,
        documents: rider.documents,
        missing: missingForRiderApproval(rider.vehicleType, rider.documents),
      })),
      page, limit, total,
    };
  }

  async get(riderId: string) {
    const r = await this.prisma.riderProfile.findUnique({
      where: { userId: riderId },
      include: { user: { select: { email: true, phone: true, status: true, profile: { select: { fullName: true } } } }, documents: true },
    });
    if (!r) throw new DomainError('RIDER_NOT_FOUND', 'Rider not found', 404);
    const { lastLat: _a, lastLng: _b, location: _c, ...rest } = r as typeof r & { location?: unknown }; // never show an off-duty rider's coordinates here
    return { ...rest, missing: missingForRiderApproval(r.vehicleType, r.documents) };
  }

  async documentPreviewUrl(riderId: string, documentId: string) {
    const document = await this.prisma.riderVerificationDocument.findFirst({
      where: { id: documentId, riderId },
      select: { storageKey: true },
    });
    if (!document) throw new DomainError('RIDER_DOCUMENT_NOT_FOUND', 'Rider document not found', 404);
    if (!isOwnStorageKey(riderId, document.storageKey)) {
      throw new DomainError('INVALID_STORAGE_KEY', 'Rider document storage key is invalid', 422);
    }
    return { url: await this.documentStorage.createPreviewUrl(document.storageKey) };
  }

  async reviewDocument(adminId: string, riderId: string, documentId: string, dto: ReviewDocumentDto, ip?: string) {
    if (!dto.approve && !dto.reason?.trim()) throw new DomainError('REASON_REQUIRED', 'Tell the rider why the document was rejected', 422);
    return this.prisma.$transaction(async (tx) => {
      const doc = await tx.riderVerificationDocument.findFirst({ where: { id: documentId, riderId } });
      if (!doc) throw new DomainError('DOCUMENT_NOT_FOUND', 'Document not found', 404);
      const status = dto.approve ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED;
      await tx.riderVerificationDocument.update({
        where: { id: documentId },
        data: { status, reviewedById: adminId, reviewedAt: new Date(), rejectionReason: dto.approve ? null : dto.reason!.trim() },
      });
      await this.audit.log({ actorId: adminId, action: dto.approve ? 'rider.document_approve' : 'rider.document_reject', entityType: 'RiderDocument', entityId: documentId, ip, metadata: { riderId, type: doc.type } }, tx);
      return { id: documentId, status };
    });
  }

  /** approve (needs every required document approved) · reject · suspend · reinstate. */
  async act(adminId: string, riderId: string, action: Exclude<ApprovalAction, 'resubmit'>, reason: string | undefined, ip?: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "userId" FROM "rider_profiles" WHERE "userId" = ${riderId}::uuid FOR UPDATE`;
      const r = await tx.riderProfile.findUnique({ where: { userId: riderId }, include: { documents: { select: { type: true, status: true } } } });
      if (!r) throw new DomainError('RIDER_NOT_FOUND', 'Rider not found', 404);
      const to = applyApprovalAction(r.approvalStatus, action, reason);
      if (action === 'approve') {
        const missing = missingForRiderApproval(r.vehicleType, r.documents);
        if (missing.length) throw new DomainError('RIDER_NOT_READY', 'The rider has not completed verification', 422, { missing });
      }
      await tx.riderProfile.update({
        where: { userId: riderId },
        data: {
          approvalStatus: to, reviewedById: adminId, reviewedAt: new Date(), rejectionReason: action === 'reject' ? reason!.trim() : null,
          ...(to !== ApprovalStatus.APPROVED && { isOnline: false, lastLat: null, lastLng: null, lastLocationAt: null }),
        },
      });
      if (to !== ApprovalStatus.APPROVED) {
        // A rider who loses approval receives no further offers; accepted deliveries are reassigned by an admin.
        await tx.deliveryAssignment.updateMany({ where: { riderId, status: AssignmentStatus.OFFERED }, data: { status: AssignmentStatus.CANCELLED, respondedAt: new Date(), rejectReason: `Rider ${to.toLowerCase()}` } });
      }
      await this.audit.log({ actorId: adminId, action: `rider.${action}`, entityType: 'RiderProfile', entityId: riderId, ip, metadata: { from: r.approvalStatus, to, ...(reason && { reason: reason.trim() }) } }, tx);
      return { userId: riderId, approvalStatus: to };
    });
  }
}
