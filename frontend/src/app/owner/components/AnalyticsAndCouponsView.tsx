'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card, Badge, Skeleton } from '@/components/ui/misc';
import { Input } from '@/components/ui/form';
import { Label } from '@/components/ui/form';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Plus } from 'lucide-react';
import { formatMoney } from '@/lib/format';
import { api, ApiError } from '@/lib/api';
import type { OwnerRestaurant } from '@/lib/types';
import { useOwnerStats, useOwnerCoupons, useOwnerEarnings, useOwnerPayouts } from '@/hooks/queries';

export function AnalyticsAndCouponsView({ restaurantId }: { restaurantId: string }) {
  const qc = useQueryClient();
  const statsQuery = useOwnerStats(restaurantId);
  const couponsQuery = useOwnerCoupons(restaurantId);
  const earningsQuery = useOwnerEarnings(restaurantId);
  const payoutsQuery = useOwnerPayouts();

  const [couponModalOpen, setCouponModalOpen] = useState(false);
  const [code, setCode] = useState('');
  const [discountPercent, setDiscountPercent] = useState('15');
  const [maxDiscountTaka, setMaxDiscountTaka] = useState('150');
  const [minSpendTaka, setMinSpendTaka] = useState('500');

  const createCouponMutation = useMutation({
    mutationFn: () =>
      api.post(`/owner/restaurants/${restaurantId}/coupons`, {
        code: code.trim().toUpperCase(),
        discountBps: Math.min(5000, parseInt(discountPercent, 10) * 100),
        maxDiscountMinor: Math.round(parseFloat(maxDiscountTaka) * 100),
        minSpendMinor: Math.round(parseFloat(minSpendTaka) * 100),
        isActive: true,
      }),
    onSuccess: () => {
      toast.success('Restaurant coupon created');
      setCouponModalOpen(false);
      setCode('');
      void qc.invalidateQueries({ queryKey: ['owner-coupons', restaurantId] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not create coupon'),
  });

  const toggleCouponMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch(`/owner/restaurants/${restaurantId}/coupons/${id}`, { isActive }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['owner-coupons', restaurantId] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update coupon'),
  });

  const stats = statsQuery.data;
  const coupons = couponsQuery.data?.items ?? [];
  const payouts = payoutsQuery.data ?? [];

  return (
    <div className="space-y-8">
      {/* Sales Stats Metric Tiles */}
      <div>
        <h2 className="font-display text-xl font-bold mb-3">Sales Performance (Last 30 Days)</h2>
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
          <Card className="p-4 space-y-1">
            <p className="text-xs font-bold text-muted-foreground uppercase">Gross Food Sales</p>
            <p className="font-display text-2xl font-extrabold text-foreground">
              {stats ? formatMoney(stats.grossSalesMinor) : '৳0'}
            </p>
          </Card>
          <Card className="p-4 space-y-1">
            <p className="text-xs font-bold text-muted-foreground uppercase">Net Earnings</p>
            <p className="font-display text-2xl font-extrabold text-success">
              {stats ? formatMoney(stats.netSalesMinor) : '৳0'}
            </p>
          </Card>
          <Card className="p-4 space-y-1">
            <p className="text-xs font-bold text-muted-foreground uppercase">Orders Delivered</p>
            <p className="font-display text-2xl font-extrabold text-foreground">
              {stats?.ordersDelivered ?? 0}
            </p>
          </Card>
          <Card className="p-4 space-y-1">
            <p className="text-xs font-bold text-muted-foreground uppercase">Customer Rating</p>
            <p className="font-display text-2xl font-extrabold text-primary-deep flex items-center gap-1">
              ★ {stats?.ratingAvg?.toFixed(1) ?? '5.0'}
            </p>
          </Card>
        </div>
      </div>

      {/* Coupons Manager */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-xl font-bold">Restaurant Coupons</h2>
            <p className="text-sm text-muted-foreground">Self-funded discounts to boost your kitchen orders (max 50%).</p>
          </div>
          <Button size="sm" onClick={() => setCouponModalOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> Create Coupon
          </Button>
        </div>
        {coupons.length === 0 ? (
          <p className="text-sm text-muted-foreground italic py-3 text-center border border-dashed border-border rounded-tile">
            No active coupons. Create a promotional code to attract more orders.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {coupons.map((c) => (
              <div key={c.id} className="py-3 flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-extrabold text-base bg-primary/20 px-2 py-0.5 rounded text-foreground">
                      {c.code}
                    </span>
                    <Badge tone={c.isActive ? 'success' : 'neutral'}>{c.isActive ? 'Active' : 'Inactive'}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {c.type === 'PERCENTAGE' ? `${c.value}% off` : c.type === 'FIXED_AMOUNT' ? `${formatMoney(c.value)} off` : 'Free delivery'}{' '}
                    {c.minSubtotalMinor ? `· Min spend ${formatMoney(c.minSubtotalMinor)}` : ''}{' '}
                    {c.maxDiscountMinor ? `· Max discount ${formatMoney(c.maxDiscountMinor)}` : ''} · Used {c.redemptions} times
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => toggleCouponMutation.mutate({ id: c.id, isActive: !c.isActive })}
                  className="text-xs"
                >
                  {c.isActive ? 'Deactivate' : 'Activate'}
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Coupon Modal */}
      <Dialog open={couponModalOpen} onOpenChange={setCouponModalOpen}>
        <DialogContent>
          <DialogTitle>Create restaurant coupon</DialogTitle>
          <div className="mt-4 space-y-4">
            <div>
              <Label htmlFor="coup-code">Promo Code</Label>
              <Input id="coup-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. YUMMY20" required />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label htmlFor="coup-disc">Discount (%)</Label>
                <Input id="coup-disc" type="number" max="50" value={discountPercent} onChange={(e) => setDiscountPercent(e.target.value)} required />
              </div>
              <div>
                <Label htmlFor="coup-max">Max Cap (৳)</Label>
                <Input id="coup-max" type="number" value={maxDiscountTaka} onChange={(e) => setMaxDiscountTaka(e.target.value)} required />
              </div>
              <div>
                <Label htmlFor="coup-min">Min Order (৳)</Label>
                <Input id="coup-min" type="number" value={minSpendTaka} onChange={(e) => setMinSpendTaka(e.target.value)} required />
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <Button variant="outline" onClick={() => setCouponModalOpen(false)}>Cancel</Button>
              <Button disabled={!code.trim()} onClick={() => createCouponMutation.mutate()} loading={createCouponMutation.isPending}>Create Coupon</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
