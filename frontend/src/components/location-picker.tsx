'use client';
import { Crosshair, Map, MapPin } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { toast } from 'sonner';
import { useAddresses } from '@/hooks/queries';
import { useAuth } from '@/lib/auth';
import { DHAKA_AREAS, useDeliveryLocation } from '@/lib/location';
import { Button } from './ui/button';

const MapPicker = dynamic(() => import('./map-picker').then((m) => m.MapPicker), {
  ssr: false,
  loading: () => <div className="h-[260px] w-full rounded-tile bg-panel animate-pulse flex items-center justify-center text-sm text-muted-foreground">Loading interactive map…</div>,
});

export function LocationPicker({ onDone }: { onDone?: () => void }) {
  const { location, set, setFromAddress, useMyLocation } = useDeliveryLocation();
  const { user } = useAuth();
  const addresses = useAddresses();
  const [busy, setBusy] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [pinLat, setPinLat] = useState(location?.lat ?? 23.7925);
  const [pinLng, setPinLng] = useState(location?.lng ?? 90.4078);

  const locate = async () => {
    setBusy(true);
    const r = await useMyLocation();
    setBusy(false);
    if (r === 'ok') onDone?.();
    else toast.error(r === 'denied' ? 'Location is blocked in your browser. Pick your area below instead.' : 'We could not find your position. Pick your area below instead.');
  };

  const confirmMapPin = () => {
    // Find closest known area or label as Custom Pin
    let closestArea = 'Dhaka';
    let minD = Infinity;
    for (const a of DHAKA_AREAS) {
      const d = Math.hypot(a.lat - pinLat, a.lng - pinLng);
      if (d < minD) {
        minD = d;
        closestArea = a.label;
      }
    }
    set({
      lat: pinLat,
      lng: pinLng,
      label: minD < 0.02 ? closestArea : `Near ${closestArea}`,
      source: 'gps',
    });
    onDone?.();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={locate} loading={busy} variant="dark">
          <Crosshair className="h-4 w-4 mr-1.5" aria-hidden /> Use my current location
        </Button>
        <Button
          variant={showMap ? 'default' : 'outline'}
          onClick={() => setShowMap(!showMap)}
        >
          <Map className="h-4 w-4 mr-1.5" aria-hidden /> {showMap ? 'Hide map' : 'Choose on map'}
        </Button>
      </div>

      {showMap && (
        <div className="space-y-3 rounded-tile border border-border bg-panel/30 p-4">
          <MapPicker lat={pinLat} lng={pinLng} onChange={(la, ln) => { setPinLat(la); setPinLng(ln); }} />
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={confirmMapPin}>
              Confirm map location
            </Button>
          </div>
        </div>
      )}

      {user?.role === 'CUSTOMER' && addresses.data && addresses.data.length > 0 && (
        <section aria-labelledby="saved-h">
          <h3 id="saved-h" className="mb-2 text-base font-bold">Your saved addresses</h3>
          <ul className="space-y-2">
            {addresses.data.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => { setFromAddress(a); onDone?.(); }}
                  className="flex w-full items-start gap-3 rounded-tile border border-border p-3 text-left hover:bg-panel"
                >
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <span>
                    <span className="font-semibold">{a.label}</span><br />
                    <span className="text-sm text-muted-foreground">{a.line1}{a.area ? `, ${a.area}` : ''}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="area-h">
        <h3 id="area-h" className="mb-2 text-base font-bold">Or choose your area in Dhaka</h3>
        <div className="flex flex-wrap gap-2">
          {DHAKA_AREAS.map((a) => (
            <button
              key={a.label}
              type="button"
              aria-pressed={location?.label === a.label}
              onClick={() => { set({ lat: a.lat, lng: a.lng, label: a.label, source: 'area' }); onDone?.(); }}
              className="rounded-full border border-border px-4 py-2 text-sm font-semibold hover:bg-panel aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-ink-foreground transition-colors"
            >
              {a.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-sm text-muted-foreground">You will confirm your exact address at checkout.</p>
      </section>
    </div>
  );
}
