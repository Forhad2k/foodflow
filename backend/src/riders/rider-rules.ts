import { ApprovalStatus, DocumentType, OrderStatus, VehicleType } from '@prisma/client';

/** Documents a rider must have APPROVED before going live. Motorised vehicles also need licence + registration. */
export function requiredDocuments(vehicle: VehicleType | null): DocumentType[] {
  const base: DocumentType[] = [DocumentType.NATIONAL_ID, DocumentType.SELFIE];
  return vehicle === VehicleType.MOTORCYCLE || vehicle === VehicleType.CAR
    ? [...base, DocumentType.DRIVING_LICENSE, DocumentType.VEHICLE_REGISTRATION]
    : base;
}

const LABEL: Record<DocumentType, string> = {
  NATIONAL_ID: 'national ID', SELFIE: 'selfie', DRIVING_LICENSE: 'driving licence', VEHICLE_REGISTRATION: 'vehicle registration', OTHER: 'document',
};

export function missingForRiderApproval(vehicle: VehicleType | null, docs: readonly { type: DocumentType; status: ApprovalStatus }[]): string[] {
  const missing: string[] = [];
  if (!vehicle) missing.push('Choose a vehicle type');
  for (const type of requiredDocuments(vehicle)) {
    const doc = docs.find((d) => d.type === type);
    if (!doc) missing.push(`Upload your ${LABEL[type]}`);
    else if (doc.status !== ApprovalStatus.APPROVED) missing.push(`Your ${LABEL[type]} is ${doc.status === ApprovalStatus.REJECTED ? 'rejected' : 'awaiting review'}`);
  }
  return missing;
}

/** Object keys must live under the rider's own prefix, so a rider can never attach someone else's file. */
export function isOwnStorageKey(userId: string, key: string): boolean {
  return new RegExp(`^riders/${userId.replace(/[^a-zA-Z0-9-]/g, '')}/[A-Za-z0-9._-]{1,120}$`).test(key) && !key.includes('..');
}

export interface DeliveryVisibility {
  restaurantExact: boolean; // exact pickup address + phone
  customerFirstName: boolean;
  customerAddress: boolean; // exact drop-off address, instructions
  customerPhone: boolean;
}

/**
 * Least-privilege disclosure for a rider who has ACCEPTED a delivery.
 * The customer's exact address and phone appear only once the food is in the rider's hands, and disappear again
 * as soon as the order is over (history keeps no personal contact data).
 */
export function deliveryVisibility(status: OrderStatus): DeliveryVisibility {
  switch (status) {
    case OrderStatus.RESTAURANT_ACCEPTED:
    case OrderStatus.PREPARING:
    case OrderStatus.READY_FOR_PICKUP:
    case OrderStatus.RIDER_ASSIGNED:
      return { restaurantExact: true, customerFirstName: true, customerAddress: false, customerPhone: false };
    case OrderStatus.PICKED_UP:
    case OrderStatus.ON_THE_WAY:
      return { restaurantExact: true, customerFirstName: true, customerAddress: true, customerPhone: true };
    default:
      return { restaurantExact: false, customerFirstName: false, customerAddress: false, customerPhone: false };
  }
}
