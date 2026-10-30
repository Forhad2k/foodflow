const R = 6_371_000; // mean Earth radius, metres
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. For display/rough checks; authoritative distance queries use PostGIS. */
export function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const MAX_PLAUSIBLE_MPS = 55; // ≈ 200 km/h: faster than any delivery vehicle in a city

/** Cheap anti-spoofing: rejects position updates that imply impossible speeds (GPS glitches and teleporting fakes). */
export function isPlausibleMove(prev: { lat: number; lng: number; at: Date } | null, next: { lat: number; lng: number; at: Date }): boolean {
  if (!prev) return true;
  const seconds = (next.at.getTime() - prev.at.getTime()) / 1000;
  const meters = haversineMeters(prev.lat, prev.lng, next.lat, next.lng);
  if (meters < 500) return true; // jitter
  if (seconds <= 0) return false;
  return meters / seconds <= MAX_PLAUSIBLE_MPS;
}
