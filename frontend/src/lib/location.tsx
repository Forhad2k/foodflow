'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Address } from './types';

export interface DeliveryLocation { lat: number; lng: number; label: string; source: 'gps' | 'area' | 'address' }

/** Quick picks when location sharing is declined. Real coordinates, so discovery and delivery checks work without a map key. */
export const DHAKA_AREAS: { label: string; lat: number; lng: number }[] = [
  { label: 'Gulshan', lat: 23.7925, lng: 90.4078 }, { label: 'Banani', lat: 23.7937, lng: 90.4066 }, { label: 'Dhanmondi', lat: 23.7461, lng: 90.3742 },
  { label: 'Mirpur 10', lat: 23.8069, lng: 90.3687 }, { label: 'Uttara', lat: 23.8759, lng: 90.3795 }, { label: 'Mohammadpur', lat: 23.7662, lng: 90.3589 },
  { label: 'Motijheel', lat: 23.733, lng: 90.4172 }, { label: 'Bashundhara R/A', lat: 23.8193, lng: 90.4526 },
];

interface LocationState {
  location: DeliveryLocation | null;
  ready: boolean;
  set: (l: DeliveryLocation) => void;
  setFromAddress: (a: Address) => void;
  clear: () => void;
  /** Asks the browser for the position. Only ever called from a button the user pressed. */
  useMyLocation: () => Promise<'ok' | 'denied' | 'unavailable'>;
}
const Ctx = createContext<LocationState | null>(null);
const KEY = 'ff.location';

export function LocationProvider({ children }: { children: ReactNode }) {
  const [location, setLoc] = useState<DeliveryLocation | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const v = JSON.parse(raw) as DeliveryLocation;
        if (Number.isFinite(v.lat) && Number.isFinite(v.lng) && Math.abs(v.lat) <= 90 && Math.abs(v.lng) <= 180) setLoc(v);
      }
    } catch { /* ignore a corrupt value */ }
    setReady(true);
  }, []);

  const set = useCallback((l: DeliveryLocation) => { setLoc(l); try { localStorage.setItem(KEY, JSON.stringify(l)); } catch { /* private mode */ } }, []);
  const clear = useCallback(() => { setLoc(null); try { localStorage.removeItem(KEY); } catch { /* ignore */ } }, []);
  const setFromAddress = useCallback((a: Address) => set({ lat: a.lat, lng: a.lng, label: a.area ? `${a.label} · ${a.area}` : a.label, source: 'address' }), [set]);
  const useMyLocation = useCallback(
    () => new Promise<'ok' | 'denied' | 'unavailable'>((resolve) => {
      if (!('geolocation' in navigator)) return resolve('unavailable');
      navigator.geolocation.getCurrentPosition(
        (p) => { set({ lat: p.coords.latitude, lng: p.coords.longitude, label: 'Your current location', source: 'gps' }); resolve('ok'); },
        (e) => resolve(e.code === e.PERMISSION_DENIED ? 'denied' : 'unavailable'),
        { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
      );
    }),
    [set],
  );

  const value = useMemo(() => ({ location, ready, set, setFromAddress, clear, useMyLocation }), [location, ready, set, setFromAddress, clear, useMyLocation]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export function useDeliveryLocation() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDeliveryLocation must be used inside <LocationProvider>');
  return v;
}
