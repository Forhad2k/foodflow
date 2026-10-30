'use client';
import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { AlertTriangle, Clock, MapPin, Navigation, WifiOff } from 'lucide-react';
import { realtime } from '@/lib/socket';
import { formatDistance } from '@/lib/format';
import type { TrackingLocation } from '@/lib/types';

interface LiveTrackingMapProps {
  orderId: string;
  destinationLat?: number;
  destinationLng?: number;
  destinationLabel?: string;
  restaurantLat?: number;
  restaurantLng?: number;
  restaurantName?: string;
}

export function LiveTrackingMap({
  orderId,
  destinationLat,
  destinationLng,
  destinationLabel = 'Delivery address',
  restaurantLat,
  restaurantLng,
  restaurantName = 'Restaurant',
}: LiveTrackingMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const riderMarkerRef = useRef<L.Marker | null>(null);

  const [location, setLocation] = useState<TrackingLocation | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [isDisconnected, setIsDisconnected] = useState(false);
  const [endedReason, setEndedReason] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    // Initialize map
    const defaultCenter: [number, number] = [
      destinationLat ?? restaurantLat ?? 23.7925,
      destinationLng ?? restaurantLng ?? 90.4078,
    ];

    const map = L.map(containerRef.current, {
      center: defaultCenter,
      zoom: 14,
      scrollWheelZoom: false,
    });
    mapRef.current = map;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 19,
    }).addTo(map);

    // Restaurant marker icon
    const restIcon = L.divIcon({
      className: 'custom-rest-icon',
      html: `
        <div style="background:#10261C; color:#FFF; padding:6px; border-radius:50%; border:2px solid #F7B500; display:flex; align-items:center; justify-content:center; box-shadow:0 2px 6px rgba(0,0,0,0.3);">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>
        </div>
      `,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });

    if (restaurantLat && restaurantLng) {
      L.marker([restaurantLat, restaurantLng], { icon: restIcon })
        .addTo(map)
        .bindPopup(`<b>${restaurantName}</b>`);
    }

    // Customer destination marker icon
    const destIcon = L.divIcon({
      className: 'custom-dest-icon',
      html: `
        <div style="background:#F7B500; color:#10261C; padding:6px; border-radius:50%; border:2px solid #10261C; display:flex; align-items:center; justify-content:center; box-shadow:0 2px 6px rgba(0,0,0,0.3);">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
        </div>
      `,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });

    if (destinationLat && destinationLng) {
      L.marker([destinationLat, destinationLng], { icon: destIcon })
        .addTo(map)
        .bindPopup(`<b>${destinationLabel}</b>`);
    }

    return () => {
      map.remove();
      mapRef.current = null;
      riderMarkerRef.current = null;
    };
  }, [destinationLat, destinationLng, restaurantLat, restaurantLng, restaurantName, destinationLabel]);

  // Connect to realtime tracking
  useEffect(() => {
    let mounted = true;

    // Initial subscription
    realtime.subscribeTracking(orderId).then((res) => {
      if (!mounted) return;
      if (res.ok && res.location) {
        setLocation(res.location);
        setIsStale(res.location.stale ?? false);
      }
    });

    const unLocation = realtime.onTrackingLocation((loc) => {
      if (!mounted || loc.orderId !== orderId) return;
      setLocation(loc);
      setIsStale(false);
      setIsDisconnected(false);

      if (mapRef.current) {
        // Rider marker icon with heading rotation
        const heading = loc.headingDeg ?? 0;
        const riderIcon = L.divIcon({
          className: 'custom-rider-icon',
          html: `
            <div style="background:#1B7F51; color:#FFF; padding:6px; border-radius:50%; border:2px solid #FFF; display:flex; align-items:center; justify-content:center; box-shadow:0 2px 8px rgba(0,0,0,0.4); transform:rotate(${heading}deg);">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="12 2 19 21 12 17 5 21 12 2"/></svg>
            </div>
          `,
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        });

        if (!riderMarkerRef.current) {
          riderMarkerRef.current = L.marker([loc.lat, loc.lng], { icon: riderIcon })
            .addTo(mapRef.current)
            .bindPopup('<b>Rider is here</b>');
        } else {
          riderMarkerRef.current.setLatLng([loc.lat, loc.lng]);
          riderMarkerRef.current.setIcon(riderIcon);
        }

        // Fit bounds to show rider and destination
        if (destinationLat && destinationLng) {
          const bounds = L.latLngBounds([
            [loc.lat, loc.lng],
            [destinationLat, destinationLng],
          ]);
          mapRef.current.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
        }
      }
    });

    const unStale = realtime.onTrackingStale((data) => {
      if (mounted && data.orderId === orderId) setIsStale(true);
    });

    const unFresh = realtime.onTrackingFresh((data) => {
      if (mounted && data.orderId === orderId) setIsStale(false);
    });

    const unDisc = realtime.onTrackingRiderDisconnected((data) => {
      if (mounted && data.orderId === orderId) setIsDisconnected(true);
    });

    const unEnd = realtime.onTrackingEnded((data) => {
      if (mounted && data.orderId === orderId) setEndedReason(data.reason);
    });

    return () => {
      mounted = false;
      realtime.unsubscribeTracking(orderId);
      unLocation();
      unStale();
      unFresh();
      unDisc();
      unEnd();
    };
  }, [orderId, destinationLat, destinationLng]);

  return (
    <div className="space-y-3">
      {/* Live Status Indicators */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-success" />
          </span>
          <span className="font-bold text-sm">Live Rider Tracking</span>
        </div>

        {location && location.etaMinutes !== undefined && (
          <div className="flex items-center gap-1.5 rounded-ticket bg-primary px-3 py-1 text-primary-foreground font-bold text-sm">
            <Clock className="h-4 w-4" /> ETA: ~{location.etaMinutes} mins
            {location.distanceMeters && ` (${formatDistance(location.distanceMeters)})`}
          </div>
        )}
      </div>

      {/* Warnings & Alerts */}
      {isStale && (
        <div className="flex items-center gap-2 rounded-tile border border-warning/30 bg-warning-soft px-3.5 py-2 text-xs font-semibold text-warning-deep">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          <span>Rider’s GPS location is stale. Searching for updated GPS signal…</span>
        </div>
      )}

      {isDisconnected && (
        <div className="flex items-center gap-2 rounded-tile border border-warning/30 bg-warning-soft px-3.5 py-2 text-xs font-semibold text-warning-deep">
          <WifiOff className="h-4 w-4 shrink-0 text-warning" />
          <span>Rider’s app temporarily lost connection. Waiting for reconnect…</span>
        </div>
      )}

      {endedReason && (
        <div className="rounded-tile bg-panel p-2.5 text-xs text-muted-foreground text-center">
          Tracking finished ({endedReason.toLowerCase()}).
        </div>
      )}

      {/* Leaflet Map Box */}
      <div className="overflow-hidden rounded-card border border-border">
        <div ref={containerRef} className="h-64 sm:h-80 w-full" />
      </div>
    </div>
  );
}

