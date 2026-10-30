import { PrismaService } from '../prisma/prisma.service';
import { notFound } from '../common/errors/domain-error';
import { UpdateProfileDto } from '../schemas/users';
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        phone: true,
        role: true,
        emailVerifiedAt: true,
        createdAt: true,
        profile: { select: { fullName: true, avatarUrl: true, marketingConsent: true } },
        riderProfile: { select: { approvalStatus: true, isOnline: true, vehicleType: true } },
      },
    });
    if (!user) throw notFound('User not found');
    return user; // credentials are in a separate table and are never selected here
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    await this.prisma.profile.update({ where: { userId }, data: dto });
    return this.getMe(userId);
  }
}
