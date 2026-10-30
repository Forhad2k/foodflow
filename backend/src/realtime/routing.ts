import { haversineMeters } from '../common/geo/distance';

export interface RouteEstimate { minutes: number; meters: number; source: string }
export interface RoutingProvider {
  estimate(from: { lat: number; lng: number }, to: { lat: number; lng: number }): Promise<RouteEstimate>;
}

/**
 * DEFAULT ADAPTER: straight-line distance × a detour factor at an assumed city speed. No external service is called.
 * For road-accurate ETAs implement RoutingProvider with Google Directions / Mapbox (needs an API key) and pass it
 * to the container; responses carry `etaSource` so clients can tell estimates from routed times.
 */
export class StraightLineRouting implements RoutingProvider {
  constructor(private readonly speedKmh: () => Promise<number>) {}
  async estimate(from: { lat: number; lng: number }, to: { lat: number; lng: number }): Promise<RouteEstimate> {
    const meters = Math.round(haversineMeters(from.lat, from.lng, to.lat, to.lng) * 1.35);
    const minutes = Math.max(1, Math.round((meters / 1000 / Math.max(await this.speedKmh(), 1)) * 60));
    return { minutes, meters, source: 'estimate' };
  }
}
