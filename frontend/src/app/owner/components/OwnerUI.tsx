import { useState, useEffect, Dispatch, SetStateAction } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Plus } from 'lucide-react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { DHAKA_AREAS } from '@/lib/location';
import type { OwnerRestaurant } from '@/lib/types';
import { useCuisines } from '@/hooks/queries';

interface RegisterRestaurantModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (restaurant: OwnerRestaurant) => void;
}

export function RegisterRestaurantModal({ open, onOpenChange, onSuccess }: RegisterRestaurantModalProps) {
  const qc = useQueryClient();
  const { data: cuisines = [] } = useCuisines();

  const [regName, setRegName] = useState('');
  const [regPhone, setRegPhone] = useState('+8801712345678');
  const [regAddress, setRegAddress] = useState('');
  const [regCity, setRegCity] = useState('Dhaka');
  const [regArea, setRegArea] = useState(DHAKA_AREAS[0].label);
  const [regCuisineIds, setRegCuisineIds] = useState<string[]>([]);

  const registerMutation = useMutation({
    mutationFn: async () => {
      const area = DHAKA_AREAS.find((a) => a.label === regArea) ?? DHAKA_AREAS[0];
      return api.post<OwnerRestaurant>('/owner/restaurants', {
        name: regName.trim(),
        phone: regPhone.trim(),
        addressLine: regAddress.trim(),
        city: regCity.trim(),
        lat: area.lat,
        lng: area.lng,
        cuisineIds: regCuisineIds.slice(0, 5),
      });
    },
    onSuccess: (newRest) => {
      toast.success('Restaurant registered');
      onOpenChange(false);
      void qc.invalidateQueries({ queryKey: ['owner-restaurants'] });
      onSuccess(newRest);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not register restaurant'),
  });

  const isValid = regName.trim() && regCuisineIds.length > 0 && regAddress.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogTitle>Register your restaurant</DialogTitle>
        <DialogDescription>Fill in the details to create a new restaurant profile.</DialogDescription>
        <div className="mt-4 space-y-4">
          <div>
            <label htmlFor="reg-name" className="block text-sm font-medium">Restaurant Name</label>
            <input id="reg-name" value={regName} onChange={(e) => setRegName(e.target.value)} required placeholder="e.g. Sultan's Dine Banani" className="mt-1 block w-full rounded-control border border-border p-2" />
          </div>
          <div>
            <label htmlFor="reg-phone" className="block text-sm font-medium">Phone (E.164)</label>
            <input id="reg-phone" value={regPhone} onChange={(e) => setRegPhone(e.target.value)} required placeholder="+8801712345678" className="mt-1 block w-full rounded-control border border-border p-2" />
          </div>
          <div>
            <label htmlFor="reg-area" className="block text-sm font-medium">Dhaka Area</label>
            <select id="reg-area" value={regArea} onChange={(e) => setRegArea(e.target.value)} className="mt-1 block w-full rounded-control border border-border p-2">
              {DHAKA_AREAS.map((a) => (
                <option key={a.label} value={a.label}>{a.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="reg-address" className="block text-sm font-medium">Street Address</label>
            <input id="reg-address" value={regAddress} onChange={(e) => setRegAddress(e.target.value)} required placeholder="House 10, Road 11" className="mt-1 block w-full rounded-control border border-border p-2" />
          </div>
          <div>
            <label className="block text-sm font-medium">Cuisines (max 5)</label>
            <div className="mt-1.5 flex flex-wrap gap-1.5 max-h-32 overflow-y-auto p-1 border border-border rounded-tile">
              {cuisines.map((c) => {
                const selected = regCuisineIds.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setRegCuisineIds((prev) => selected ? prev.filter((id) => id !== c.id) : prev.length < 5 ? [...prev, c.id] : prev)}
                    className={`rounded-full px-2.5 py-1 text-xs font-semibold border ${selected ? 'bg-ink text-ink-foreground border-ink' : 'border-border hover:bg-panel'}`}
                  >
                    {c.name}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button disabled={!isValid} onClick={() => registerMutation.mutate()} loading={registerMutation.isPending}>Submit Registration</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Owner top bar component (restaurant selector + register button)
interface OwnerTopBarProps {
  restaurants: OwnerRestaurant[];
  currentRestaurant: OwnerRestaurant | null;
  onSelect: (id: string) => void;
  onRegisterOpen: () => void;
}

export function OwnerTopBar({ restaurants, currentRestaurant, onSelect, onRegisterOpen }: OwnerTopBarProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 bg-background p-4 rounded-card border border-border">
      {restaurants.length > 0 && currentRestaurant ? (
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm font-bold flex items-center gap-2">
            Restaurant:
            <select
              value={currentRestaurant.id}
              onChange={(e) => onSelect(e.target.value)}
              className="h-10 rounded-control border border-border bg-background px-3 font-semibold text-sm"
            >
              {restaurants.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.approvalStatus})
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <h1 className="font-display text-2xl font-extrabold">Welcome to FoodFlow Owner Console</h1>
      )}
      <Button size="sm" onClick={onRegisterOpen}>
        <Plus className="h-4 w-4 mr-1" /> Register New Restaurant
      </Button>
    </div>
  );
}

// Tab navigation component
import { ShoppingBag, Utensils, Clock, CheckCircle2, DollarSign } from 'lucide-react';

type OwnerTab = 'orders' | 'menu' | 'hours' | 'setup' | 'analytics';

interface OwnerTabsProps {
  activeTab: OwnerTab;
  setActiveTab: Dispatch<SetStateAction<OwnerTab>>;
}

export function OwnerTabs({ activeTab, setActiveTab }: OwnerTabsProps) {
  const tabs: { id: OwnerTab; label: string; icon: typeof ShoppingBag }[] = [
    { id: 'orders', label: 'Kitchen Orders', icon: ShoppingBag },
    { id: 'menu', label: 'Menu Editor', icon: Utensils },
    { id: 'hours', label: 'Hours & Zones', icon: Clock },
    { id: 'setup', label: 'Setup & Readiness', icon: CheckCircle2 },
    { id: 'analytics', label: 'Analytics & Coupons', icon: DollarSign },
  ];

  return (
    <div className="flex overflow-x-auto border-b border-border gap-2 pb-1" role="tablist">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const active = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 whitespace-nowrap rounded-t-lg px-4 py-2.5 text-sm font-bold border-b-2 transition ${
              active ? 'border-ink bg-panel text-ink' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon className="h-4 w-4" />
            <span>{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

