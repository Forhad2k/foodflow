import { DomainError } from '../common/errors/domain-error';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAddressDto, UpdateAddressDto } from '../schemas/addresses';

const MAX_ADDRESSES = 10;
export class AddressesService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.address.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async create(userId: string, dto: CreateAddressDto) {
    return this.prisma.$transaction(async (tx) => {
      // Serialise per user so the address cap and the single-default rule hold under concurrency.
      await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId}::uuid FOR UPDATE`;
      const count = await tx.address.count({ where: { userId, deletedAt: null } });
      if (count >= MAX_ADDRESSES) throw new DomainError('ADDRESS_LIMIT', `You can save up to ${MAX_ADDRESSES} addresses`, 422);
      const makeDefault = dto.isDefault === true || count === 0;
      if (makeDefault) await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
      return tx.address.create({ data: { ...dto, userId, isDefault: makeDefault } });
    });
  }

  async update(userId: string, id: string, dto: UpdateAddressDto) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId}::uuid FOR UPDATE`;
      const existing = await tx.address.findFirst({ where: { id, userId, deletedAt: null } });
      if (!existing) throw new DomainError('ADDRESS_NOT_FOUND', 'Address not found', 404); // same answer for "not yours"
      if (dto.isDefault === true) await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
      // Unsetting the only default is ignored: a customer with addresses always has one.
      const { isDefault, ...rest } = dto;
      return tx.address.update({ where: { id }, data: { ...rest, ...(isDefault === true && { isDefault: true }) } });
    });
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId}::uuid FOR UPDATE`;
      const existing = await tx.address.findFirst({ where: { id, userId, deletedAt: null } });
      if (!existing) throw new DomainError('ADDRESS_NOT_FOUND', 'Address not found', 404);
      // Soft delete: past orders keep their own immutable address snapshot.
      await tx.address.update({ where: { id }, data: { deletedAt: new Date(), isDefault: false } });
      if (existing.isDefault) {
        const next = await tx.address.findFirst({ where: { userId, deletedAt: null }, orderBy: { createdAt: 'desc' } });
        if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    });
  }
}
