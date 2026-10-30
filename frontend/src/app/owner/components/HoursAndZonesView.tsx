'use client';
import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card, Badge, Skeleton } from '@/components/ui/misc';
import { Input, Label } from '@/components/ui/form';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Plus, Trash2 } from 'lucide-react';
import { useOwnerZones } from '@/hooks/queries';
import { formatMoney } from '@/lib/format';
import { api, ApiError } from '@/lib/api';
import type { OwnerRestaurant, OperatingHour } from '@/lib/types';

// Helper time conversion functions
function formatMinutesToTime(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}
function parseTimeToMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const ZoneMapEditor = dynamic(
  () => import('@/components/zone-map-editor').then((module) => module.ZoneMapEditor),
  {
    ssr: false,
    loading: () => <div className="h-[360px] w-full animate-pulse rounded-tile bg-panel" />,
  },
);

export function HoursAndZonesView({ restaurant }: { restaurant: OwnerRestaurant }) {
  const qc = useQueryClient();
  const zonesQuery = useOwnerZones(restaurant.id);

  const [schedule, setSchedule] = useState<{ dayOfWeek: number; open: string; close: string; active: boolean }[]>([
    { dayOfWeek: 0, open: '10:00', close: '22:00', active: true },
    { dayOfWeek: 1, open: '10:00', close: '22:00', active: true },
    { dayOfWeek: 2, open: '10:00', close: '22:00', active: true },
    { dayOfWeek: 3, open: '10:00', close: '22:00', active: true },
    { dayOfWeek: 4, open: '10:00', close: '22:00', active: true },
    { dayOfWeek: 5, open: '10:00', close: '23:00', active: true },
    { dayOfWeek: 6, open: '10:00', close: '23:00', active: true },
  ]);

  const [radiusZoneKm, setRadiusZoneKm] = useState(3.5);
  const [zoneFeeTaka, setZoneFeeTaka] = useState(60);

  const saveHoursMutation = useMutation({
    mutationFn: () => {
      const hours: OperatingHour[] = schedule
        .filter((s) => s.active)
        .map((s) => ({
          dayOfWeek: s.dayOfWeek,
          opensAtMin: parseTimeToMinutes(s.open),
          closesAtMin: parseTimeToMinutes(s.close),
        }));
      return api.put(`/owner/restaurants/${restaurant.id}/hours`, { hours });
    },
    onSuccess: () => {
      toast.success('Opening hours saved');
      void qc.invalidateQueries({ queryKey: ['owner-restaurant', restaurant.id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save opening hours'),
  });

  const createRadiusZoneMutation = useMutation({
    mutationFn: () =>
      api.post(`/owner/restaurants/${restaurant.id}/zones`, {
        type: 'RADIUS',
        name: `${radiusZoneKm} km Standard Radius`,
        radiusMeters: Math.round(radiusZoneKm * 1000),
        deliveryFeeMinor: Math.round(zoneFeeTaka * 100),
      }),
    onSuccess: () => {
      toast.success('Radius delivery zone created');
      void qc.invalidateQueries({ queryKey: ['owner-zones', restaurant.id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not create radius zone'),
  });

  const createPolygonZoneMutation = useMutation({
    mutationFn: (polygon: [number, number][]) =>
      api.post(`/owner/restaurants/${restaurant.id}/zones`, {
        type: 'POLYGON',
        name: 'Custom Coverage Polygon',
        polygon,
        deliveryFeeMinor: Math.round(zoneFeeTaka * 100),
      }),
    onSuccess: () => {
      toast.success('Polygon delivery zone created');
      void qc.invalidateQueries({ queryKey: ['owner-zones', restaurant.id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not create polygon zone'),
  });

  const deleteZoneMutation = useMutation({
    mutationFn: (zoneId: string) => api.delete(`/owner/restaurants/${restaurant.id}/zones/${zoneId}`),
    onSuccess: () => {
      toast.success('Zone removed');
      void qc.invalidateQueries({ queryKey: ['owner-zones', restaurant.id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not remove zone'),
  });

  const zones = zonesQuery.data ?? [];

  return (
    <div className="space-y-8">
      {/* Hours Editor */}
      <Card className="p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-xl font-bold">Weekly Opening Hours</h2>
            <p className="text-sm text-muted-foreground">Define when your restaurant is open and accepting customer orders.</p>
          </div>
          <Button size="sm" onClick={() => saveHoursMutation.mutate()} loading={saveHoursMutation.isPending}>Save Hours Schedule</Button>
        </div>
        <div className="divide-y divide-border">
          {schedule.map((item, idx) => (
            <div key={item.dayOfWeek} className="py-2.5 flex items-center justify-between gap-4">
              <label className="flex items-center gap-2 cursor-pointer w-28">
                <input type="checkbox" checked={item.active} onChange={(e) => {
                  const next = [...schedule];
                  next[idx].active = e.target.checked;
                  setSchedule(next);
                }} className="rounded border-border text-primary" />
                <span className={`text-sm font-semibold ${item.active ? 'text-foreground' : 'text-muted-foreground line-through'}`}>{DAYS[item.dayOfWeek]}</span>
              </label>
              {item.active ? (
                <div className="flex items-center gap-2 text-sm">
                  <Input type="time" value={item.open} onChange={(e) => {
                    const next = [...schedule];
                    next[idx].open = e.target.value;
                    setSchedule(next);
                  }} className="h-8 w-28 text-xs font-mono" />
                  <span className="text-muted-foreground">to</span>
                  <Input type="time" value={item.close} onChange={(e) => {
                    const next = [...schedule];
                    next[idx].close = e.target.value;
                    setSchedule(next);
                  }} className="h-8 w-28 text-xs font-mono" />
                </div>
              ) : (
                <span className="text-xs text-muted-foreground italic">Closed</span>
              )}
            </div>
          ))}
        </div>
      </Card>

      {/* Zones Editor */}
      <Card className="p-6 space-y-5">
        <div>
          <h2 className="font-display text-xl font-bold">Delivery Coverage Zones</h2>
          <p className="text-sm text-muted-foreground">Only customers inside at least one active delivery zone can see and order from your restaurant.</p>
        </div>
        {/* Interactive Leaflet Map Editor */}
        <ZoneMapEditor
          centerLat={restaurant.lat}
          centerLng={restaurant.lng}
          zones={zones}
          onPolygonCreated={(poly) => createPolygonZoneMutation.mutate(poly)}
        />
        {/* Quick Add Radius Zone */}
        <div className="rounded-tile bg-panel p-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <div>
              <Label htmlFor="rad-km" className="text-xs">Radius (km)</Label>
              <Input id="rad-km" type="number" step="0.5" min="0.2" max="30" value={radiusZoneKm} onChange={(e) => setRadiusZoneKm(parseFloat(e.target.value))} className="h-8 w-24 text-xs font-mono mt-1" />
            </div>
            <div>
              <Label htmlFor="rad-fee" className="text-xs">Delivery Fee (৳)</Label>
              <Input id="rad-fee" type="number" step="5" value={zoneFeeTaka} onChange={(e) => setZoneFeeTaka(parseFloat(e.target.value))} className="h-8 w-24 text-xs font-mono mt-1" />
            </div>
          </div>
          <Button size="sm" onClick={() => createRadiusZoneMutation.mutate()} loading={createRadiusZoneMutation.isPending}>
            <Plus className="h-4 w-4 mr-1" /> Add Circular Radius Zone
          </Button>
        </div>
        {/* Existing Zones List */}
        <div className="space-y-2 pt-2">
          <h3 className="font-bold text-sm">Configured Zones ({zones.length}/10 max)</h3>
          {zones.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No delivery zones configured yet. Add a radius zone or draw a polygon on the map above.</p>
          ) : (
            <div className="divide-y divide-border">
              {zones.map((z) => (
                <div key={z.id} className="py-2.5 flex items-center justify-between gap-3">
                  <div>
                    <span className="font-semibold text-sm">{z.name}</span>
                    <span className="ml-2 font-mono text-xs text-muted-foreground">({z.type})</span>
                    {z.deliveryFeeMinor !== undefined && z.deliveryFeeMinor !== null && (
                      <span className="ml-2 text-xs text-muted-foreground">Fee: {formatMoney(z.deliveryFeeMinor)}</span>
                    )}
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => { if (confirm(`Remove zone "${z.name}"?`)) { deleteZoneMutation.mutate(z.id); } }} className="text-xs text-destructive h-8 px-2">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
