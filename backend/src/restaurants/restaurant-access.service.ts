import type { Db } from '../common/db';
import { DomainError } from '../common/errors/domain-error';
import { PrismaService } from '../prisma/prisma.service';

/** Object-level authorization for owner endpoints. A restaurant that is not yours is simply "not found". */
export class RestaurantAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async assertOwner(userId: string, restaurantId: string, db: Db = this.prisma) {
    const restaurant = await db.restaurant.findFirst({ where: { id: restaurantId, ownerId: userId } });
    if (!restaurant) throw new DomainError('RESTAURANT_NOT_FOUND', 'Restaurant not found', 404);
    return restaurant;
  }
}
