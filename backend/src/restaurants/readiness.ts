import type { Db } from '../common/db';
import { missingForApproval } from './approval';

export async function loadReadiness(db: Db, restaurantId: string) {
  const [activeZones, hourWindows, availableItems, cuisines] = await Promise.all([
    db.deliveryZone.count({ where: { restaurantId, isActive: true } }),
    db.operatingHour.count({ where: { restaurantId } }),
    db.menuItem.count({ where: { restaurantId, deletedAt: null, isAvailable: true } }),
    db.restaurantCuisine.count({ where: { restaurantId } }),
  ]);
  const missing = missingForApproval({ activeZones, hourWindows, availableItems, cuisines });
  return { ready: missing.length === 0, missing };
}
