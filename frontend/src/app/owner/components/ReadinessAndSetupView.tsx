'use client';
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card, Badge, Skeleton } from '@/components/ui/misc';
import { Input, Label, Textarea } from '@/components/ui/form';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { CheckCircle2, XCircle, Pause, Play } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import type { OwnerRestaurant } from '@/lib/types';

export function ReadinessAndSetupView({ restaurant }: { restaurant: OwnerRestaurant }) {
  const qc = useQueryClient();

  // Guard: restaurant data may still be loading
  if (!restaurant) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  const [name, setName] = useState(restaurant.name ?? '');
  const [phone, setPhone] = useState(restaurant.phone ?? '');
  const [addressLine, setAddressLine] = useState(restaurant.addressLine ?? '');
  const [city, setCity] = useState(restaurant.city ?? '');
  const [description, setDescription] = useState(restaurant.description ?? '');
  const [minOrderTaka, setMinOrderTaka] = useState(((restaurant.minOrderMinor ?? 0) / 100).toString());
  const [baseFeeTaka, setBaseFeeTaka] = useState(((restaurant.baseDeliveryFeeMinor ?? 0) / 100).toString());
  // Safely convert avgPrepMinutes
  const [avgPrep, setAvgPrep] = useState(restaurant?.avgPrepMinutes?.toString() ?? '');

  useEffect(() => {
    setName(restaurant.name ?? '');
    setPhone(restaurant.phone ?? '');
    setAddressLine(restaurant.addressLine ?? '');
    setCity(restaurant.city ?? '');
    setDescription(restaurant.description ?? '');
    setMinOrderTaka(((restaurant.minOrderMinor ?? 0) / 100).toString());
    setBaseFeeTaka(((restaurant.baseDeliveryFeeMinor ?? 0) / 100).toString());
    setAvgPrep(restaurant.avgPrepMinutes?.toString() ?? '');
  }, [restaurant]);

  const updateMutation = useMutation({
    mutationFn: () =>
      api.patch(`/owner/restaurants/${restaurant.id}`, {
        name: name.trim(),
        phone: phone.trim(),
        addressLine: addressLine.trim(),
        city: city.trim(),
        description: description.trim() || undefined,
        minOrderMinor: Math.round(parseFloat(minOrderTaka) * 100),
        baseDeliveryFeeMinor: Math.round(parseFloat(baseFeeTaka) * 100),
        avgPrepMinutes: parseInt(avgPrep, 10) || 20,
      }),
    onSuccess: () => {
      toast.success('Restaurant profile updated');
      void qc.invalidateQueries({ queryKey: ['owner-restaurant', restaurant.id] });
      void qc.invalidateQueries({ queryKey: ['owner-restaurants'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update restaurant'),
  });

  const togglePauseMutation = useMutation({
    mutationFn: () =>
      api.patch(`/owner/restaurants/${restaurant.id}/availability`, { isPaused: !restaurant.isPaused }),
    onSuccess: () => {
      toast.success(restaurant.isPaused ? 'Restaurant resumed taking orders' : 'Restaurant paused');
      void qc.invalidateQueries({ queryKey: ['owner-restaurant', restaurant.id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not change availability'),
  });

  const resubmitMutation = useMutation({
    mutationFn: () => api.post(`/owner/restaurants/${restaurant.id}/resubmit`),
    onSuccess: () => {
      toast.success('Resubmitted for admin review');
      void qc.invalidateQueries({ queryKey: ['owner-restaurant', restaurant.id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not resubmit'),
  });

  const ready = restaurant.readiness?.ready ?? false;
  const missing = restaurant.readiness?.missing ?? [];

  return (
    <div className="space-y-8">
      {/* Approval & Readiness Checklist Banner */}
      <Card className="p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-display text-xl font-bold">Readiness & Approval Status</h2>
              <Badge tone={restaurant.approvalStatus === 'APPROVED' ? 'success' : restaurant.approvalStatus === 'REJECTED' ? 'danger' : 'accent'}>
                {restaurant.approvalStatus}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">Admin review requires all checklist items to be satisfied.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={restaurant.isPaused ? 'default' : 'outline'}
              size="sm"
              onClick={() => togglePauseMutation.mutate()}
              loading={togglePauseMutation.isPending}
            >
              {restaurant.isPaused ? (
                <>
                  <Play className="h-4 w-4 mr-1" /> Resume Taking Orders
                </>
              ) : (
                <>
                  <Pause className="h-4 w-4 mr-1" /> Pause Orders
                </>
              )}
            </Button>
          </div>
        </div>
        {restaurant.approvalStatus === 'REJECTED' && (
          <div className="rounded-tile border border-destructive/30 bg-destructive-soft p-4 space-y-2">
            <p className="font-bold text-destructive text-sm">Application Rejected by Admin</p>
            {restaurant.rejectionReason && (
              <p className="text-xs text-foreground/90">Reason: {restaurant.rejectionReason}</p>
            )}
            <Button size="sm" onClick={() => resubmitMutation.mutate()} loading={resubmitMutation.isPending} className="mt-2">
              Resubmit for Review
            </Button>
          </div>
        )}
        {/* Readiness Checklist */}
        <div className="rounded-tile bg-panel p-4 space-y-2">
          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Platform Readiness Checklist ({ready ? 'Ready for approval' : `${missing.length} missing`})
          </p>
          <div className="grid gap-2 sm:grid-cols-2 pt-1 text-sm">
            <div className="flex items-center gap-2">
              {!missing.includes('cuisines') ? (
                <CheckCircle2 className="h-4 w-4 text-success" />
              ) : (
                <XCircle className="h-4 w-4 text-destructive" />
              )}
              <span>Cuisine assigned</span>
            </div>
            <div className="flex items-center gap-2">
              {!missing.includes('delivery_zones') ? (
                <CheckCircle2 className="h-4 w-4 text-success" />
              ) : (
                <XCircle className="h-4 w-4 text-destructive" />
              )}
              <span>Active delivery zone configured</span>
            </div>
            <div className="flex items-center gap-2">
              {!missing.includes('hours') ? (
                <CheckCircle2 className="h-4 w-4 text-success" />
              ) : (
                <XCircle className="h-4 w-4 text-destructive" />
              )}
              <span>Weekly opening hours set</span>
            </div>
            <div className="flex items-center gap-2">
              {!missing.includes('menu_items') ? (
                <CheckCircle2 className="h-4 w-4 text-success" />
              ) : (
                <XCircle className="h-4 w-4 text-destructive" />
              )}
              <span>At least 1 available menu item</span>
            </div>
          </div>
        </div>
      </Card>

      {/* Profile Form */}
      <Card className="p-6 space-y-5">
        <h2 className="font-display text-xl font-bold">Restaurant Profile & Details</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            updateMutation.mutate();
          }}
          className="space-y-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="r-name">Restaurant Name</Label>
              <Input id="r-name" value={name} onChange={(e) => setName(e.target.value)} required className="mt-1" />
            </div>
            <div>
              <Label htmlFor="r-phone">Contact Phone (E.164)</Label>
              <Input id="r-phone" value={phone} onChange={(e) => setPhone(e.target.value)} required className="mt-1" />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="r-addr">Address Line</Label>
              <Input id="r-addr" value={addressLine} onChange={(e) => setAddressLine(e.target.value)} required className="mt-1" />
            </div>
            <div>
              <Label htmlFor="r-city">City</Label>
              <Input id="r-city" value={city} onChange={(e) => setCity(e.target.value)} required className="mt-1" />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <Label htmlFor="r-prep">Avg Prep Time (mins)</Label>
              <Input id="r-prep" type="number" value={avgPrep} onChange={(e) => setAvgPrep(e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label htmlFor="r-min">Min Order (৳)</Label>
              <Input id="r-min" type="number" value={minOrderTaka} onChange={(e) => setMinOrderTaka(e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label htmlFor="r-fee">Base Delivery Fee (৳)</Label>
              <Input id="r-fee" type="number" value={baseFeeTaka} onChange={(e) => setBaseFeeTaka(e.target.value)} className="mt-1" />
            </div>
          </div>
          <div>
            <Label htmlFor="r-desc">Description (optional)</Label>
            <Textarea id="r-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="mt-1" />
          </div>
          <div className="pt-2">
            <Button type="submit" loading={updateMutation.isPending}>Save Restaurant Details</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
