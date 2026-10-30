
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { Check, Plus, Undo } from 'lucide-react';
import { Button } from './ui/button';
import type { DeliveryZone } from '@/lib/types';

interface ZoneMapEditorProps {
  centerLat: number;
  centerLng: number;
  zones: DeliveryZone[];
  onPolygonCreated: (coords: [number, number][]) => void;
  height?: string;
}

const isValidCoordinate = (
  lat: unknown,
  lng: unknown
): lat is number => {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
};

export function ZoneMapEditor({
  centerLat,
  centerLng,
  zones,
  onPolygonCreated,
  height = '360px',
}: ZoneMapEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const centerMarkerRef = useRef<L.Marker | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const drawingLayerRef = useRef<L.LayerGroup | null>(null);

  const [isDrawing, setIsDrawing] = useState(false);
  const [points, setPoints] = useState<[number, number][]>([]);

  const validCoordinates = isValidCoordinate(centerLat, centerLng);

  // Initialize the map only when valid coordinates are available.
  useEffect(() => {
    if (!containerRef.current || mapRef.current || !validCoordinates) {
      return;
    }

    const map = L.map(containerRef.current, {
      center: [centerLat, centerLng],
      zoom: 13,
      scrollWheelZoom: true,
    });

    mapRef.current = map;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    const centerIcon = L.divIcon({
      className: 'rest-center-icon',
      html: `
        <div style="
          background:#10261C;
          color:#F7B500;
          padding:6px;
          border-radius:50%;
          border:2px solid #F7B500;
          display:flex;
          align-items:center;
          justify-content:center;
          box-shadow:0 2px 6px rgba(0,0,0,0.3);
        ">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
          >
            <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>
            <circle cx="12" cy="10" r="3"/>
          </svg>
        </div>
      `,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });

    centerMarkerRef.current = L.marker([centerLat, centerLng], {
      icon: centerIcon,
    })
      .addTo(map)
      .bindPopup('<b>Restaurant Location</b>');

    layerGroupRef.current = L.layerGroup().addTo(map);
    drawingLayerRef.current = L.layerGroup().addTo(map);

    // Leaflet sometimes needs an explicit size refresh after rendering.
    requestAnimationFrame(() => {
      map.invalidateSize();
    });

    return () => {
      map.remove();

      mapRef.current = null;
      centerMarkerRef.current = null;
      layerGroupRef.current = null;
      drawingLayerRef.current = null;
    };
  }, [centerLat, centerLng, validCoordinates]);

  // Update the map center and marker when restaurant coordinates change.
  useEffect(() => {
    if (!validCoordinates) return;

    const map = mapRef.current;
    if (!map) return;

    map.setView([centerLat, centerLng], map.getZoom());

    centerMarkerRef.current?.setLatLng([centerLat, centerLng]);
  }, [centerLat, centerLng, validCoordinates]);

  // Render existing delivery zones.
  useEffect(() => {
    const layerGroup = layerGroupRef.current;
    if (!layerGroup) return;

    layerGroup.clearLayers();

    zones.forEach((zone) => {
      if (
        zone.type === 'RADIUS' &&
        typeof zone.radiusMeters === 'number' &&
        Number.isFinite(zone.radiusMeters) &&
        zone.radiusMeters > 0 &&
        validCoordinates
      ) {
        L.circle([centerLat, centerLng], {
          radius: zone.radiusMeters,
          color: '#1B7F51',
          fillColor: '#1B7F51',
          fillOpacity: 0.15,
          weight: 2,
        })
          .addTo(layerGroup)
          .bindPopup(
            `<b>${zone.name}</b><br/>Radius: ${(zone.radiusMeters / 1000).toFixed(1)} km`
          );
      } else if (
        zone.type === 'POLYGON' &&
        Array.isArray(zone.polygon) &&
        zone.polygon.length >= 3
      ) {
        // Backend polygon coordinates use [lng, lat].
        const latLngs: [number, number][] = zone.polygon
          .filter(
            (point): point is [number, number] =>
              Array.isArray(point) &&
              point.length >= 2 &&
              typeof point[0] === 'number' &&
              typeof point[1] === 'number' &&
              Number.isFinite(point[0]) &&
              Number.isFinite(point[1]) &&
              point[0] >= -180 &&
              point[0] <= 180 &&
              point[1] >= -90 &&
              point[1] <= 90
          )
          .map(([lng, lat]) => [lat, lng]);

        if (latLngs.length >= 3) {
          L.polygon(latLngs, {
            color: '#F7B500',
            fillColor: '#F7B500',
            fillOpacity: 0.2,
            weight: 2,
          })
            .addTo(layerGroup)
            .bindPopup(`<b>${zone.name}</b><br/>Polygon zone`);
        }
      }
    });
  }, [zones, centerLat, centerLng, validCoordinates]);

  // Handle map clicks during polygon drawing.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const onClick = (event: L.LeafletMouseEvent) => {
      if (!isDrawing) return;

      const newPoint: [number, number] = [
        event.latlng.lat,
        event.latlng.lng,
      ];

      setPoints((previous) => [...previous, newPoint]);
    };

    map.on('click', onClick);

    return () => {
      map.off('click', onClick);
    };
  }, [isDrawing]);

  // Render the polygon currently being drawn.
  useEffect(() => {
    const drawingLayer = drawingLayerRef.current;
    if (!drawingLayer) return;

    drawingLayer.clearLayers();

    if (points.length === 0) return;

    points.forEach(([lat, lng], index) => {
      L.circleMarker([lat, lng], {
        radius: 6,
        color: '#10261C',
        fillColor: '#F7B500',
        fillOpacity: 1,
        weight: 2,
      })
        .addTo(drawingLayer)
        .bindTooltip(`Point ${index + 1}`);
    });

    if (points.length > 1) {
      L.polyline(points, {
        color: '#C7341A',
        weight: 3,
        dashArray: '6, 6',
      }).addTo(drawingLayer);
    }
  }, [points]);

  const finishDrawing = useCallback(() => {
    if (points.length < 3) return;

    // Convert Leaflet [lat, lng] to backend [lng, lat].
    const ring: [number, number][] = points.map(([lat, lng]) => [
      lng,
      lat,
    ]);

    // Close the polygon ring.
    const first = ring[0];
    const last = ring[ring.length - 1];

    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([first[0], first[1]]);
    }

    onPolygonCreated(ring);
    setIsDrawing(false);
    setPoints([]);
  }, [points, onPolygonCreated]);

  const cancelDrawing = useCallback(() => {
    setIsDrawing(false);
    setPoints([]);
  }, []);

  const undoLastPoint = useCallback(() => {
    setPoints((previous) => previous.slice(0, -1));
  }, []);

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-tile border border-border">
        {validCoordinates ? (
          <div
            ref={containerRef}
            style={{ height, width: '100%' }}
          />
        ) : (
          <div
            className="flex items-center justify-center bg-panel p-6 text-center text-sm text-muted-foreground"
            style={{ height }}
          >
            Restaurant coordinates are missing or invalid. Please select a
            valid restaurant location to display the map.
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-tile border border-border bg-panel p-3 text-xs">
        {isDrawing ? (
          <>
            <span className="font-semibold text-foreground">
              Click on the map to add vertices ({points.length} points).
              Minimum 3 points required.
            </span>

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={undoLastPoint}
                disabled={points.length === 0}
                className="h-8 px-2.5 text-xs"
              >
                <Undo className="mr-1 h-3 w-3" />
                Undo
              </Button>

              <Button
                size="sm"
                variant="outline"
                onClick={cancelDrawing}
                className="h-8 px-2.5 text-xs"
              >
                Cancel
              </Button>

              <Button
                size="sm"
                onClick={finishDrawing}
                disabled={points.length < 3}
                className="h-8 px-2.5 text-xs"
              >
                <Check className="mr-1 h-3 w-3" />
                Finish Polygon
              </Button>
            </div>
          </>
        ) : (
          <>
            <span className="text-muted-foreground">
              Green circles = Radius zones. Yellow shapes = Custom polygon
              zones.
            </span>

            <Button
              size="sm"
              variant="default"
              onClick={() => {
                if (!validCoordinates || !mapRef.current) return;

                setPoints([]);
                setIsDrawing(true);
              }}
              disabled={!validCoordinates}
              className="h-8 text-xs"
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Draw Custom Zone
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
