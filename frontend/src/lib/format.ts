/** Money arrives from the API in minor units (paisa). ৳320.00 = 32000. */
export function formatMoney(minor: number): string {
  const taka = minor / 100;
  return `৳${Number.isInteger(taka) ? taka.toLocaleString('en-US') : taka.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatDistance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters / 10) * 10} m` : `${(meters / 1000).toFixed(1)} km`;
}

export function formatEta(range: { min: number; max: number }): string {
  return `${range.min}–${range.max}`;
}

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Dhaka' });
export const formatDateTime = (iso: string | Date) => dateFmt.format(typeof iso === 'string' ? new Date(iso) : iso);

/** Order statuses in plain customer language. */
export const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: 'Waiting for payment', PLACED: 'Sent to the restaurant', RESTAURANT_ACCEPTED: 'Accepted', PREPARING: 'Being prepared',
  READY_FOR_PICKUP: 'Ready, waiting for the rider', RIDER_ASSIGNED: 'Rider assigned', PICKED_UP: 'Picked up', ON_THE_WAY: 'On the way',
  DELIVERED: 'Delivered', REJECTED_BY_RESTAURANT: 'Declined by the restaurant', CANCELLED: 'Cancelled', PAYMENT_FAILED: 'Payment failed', DELIVERY_FAILED: 'Delivery failed',
};
export const ACTIVE_STATUSES = ['PENDING_PAYMENT', 'PLACED', 'RESTAURANT_ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'RIDER_ASSIGNED', 'PICKED_UP', 'ON_THE_WAY'];
export const isActiveStatus = (s: string) => ACTIVE_STATUSES.includes(s);

export const statusTone = (s: string) => (s === 'DELIVERED' ? 'success' : ['CANCELLED', 'REJECTED_BY_RESTAURANT', 'PAYMENT_FAILED', 'DELIVERY_FAILED'].includes(s) ? 'danger' : 'accent') as 'success' | 'danger' | 'accent';
