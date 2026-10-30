'use client';

import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RoleShell } from '@/components/role-shell';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/misc';
import { EmptyState } from '@/components/states';
import { useOwnerRestaurants } from '@/hooks/queries';
import type { OwnerRestaurant } from '@/lib/types';

// View components (each <300 lines)
import { KitchenOrdersView } from '@/app/owner/components/KitchenOrdersView';
import { MenuManagementView } from '@/app/owner/components/MenuManagementView';
import { HoursAndZonesView } from '@/app/owner/components/HoursAndZonesView';
import { ReadinessAndSetupView } from '@/app/owner/components/ReadinessAndSetupView';
import { AnalyticsAndCouponsView } from '@/app/owner/components/AnalyticsAndCouponsView';

// UI helpers
import { OwnerTopBar, OwnerTabs } from '@/app/owner/components/OwnerUI';
import { RegisterRestaurantModal } from '@/app/owner/components/RegisterRestaurantModal';

export default function OwnerPage() {
  const qc = useQueryClient();
  const { data: restaurants = [], isLoading } = useOwnerRestaurants();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'orders' | 'menu' | 'hours' | 'setup' | 'analytics'>('orders');
  const [registerOpen, setRegisterOpen] = useState(false);

  const currentRestaurant = restaurants.find((r) => r.id === selectedId) ?? (restaurants[0] ?? null);

  // Auto‑select the first restaurant when the list loads.
  useEffect(() => {
    if (!selectedId && restaurants.length) setSelectedId(restaurants[0].id);
  }, [restaurants, selectedId]);

  const handleRegisterSuccess = (newRest: OwnerRestaurant) => {
    setSelectedId(newRest.id);
    // Invalidate to refresh the list.
    void qc.invalidateQueries({ queryKey: ['owner-restaurants'] });
  };

  if (isLoading) return <Skeleton className="h-64" />;

  return (
    <RoleShell role="RESTAURANT_OWNER" title="Restaurant Console">
      <OwnerTopBar
        restaurants={restaurants}
        currentRestaurant={currentRestaurant}
        onSelect={setSelectedId}
        onRegisterOpen={() => setRegisterOpen(true)}
      />

      {currentRestaurant ? (
        <>
          <OwnerTabs activeTab={activeTab} setActiveTab={setActiveTab} />

          {activeTab === 'orders' && <KitchenOrdersView restaurantId={currentRestaurant.id} />}
          {activeTab === 'menu' && <MenuManagementView restaurantId={currentRestaurant.id} />}
          {activeTab === 'hours' && <HoursAndZonesView restaurant={currentRestaurant} />}
          {activeTab === 'setup' && <ReadinessAndSetupView restaurant={currentRestaurant} />}
          {activeTab === 'analytics' && <AnalyticsAndCouponsView restaurantId={currentRestaurant.id} />}
        </>
      ) : (
        <EmptyState
          title="You haven't registered a restaurant yet"
          action={<Button onClick={() => setRegisterOpen(true)}>Register Restaurant Now</Button>}
        >
          Get started by registering your restaurant, then configure menu, hours, zones, and more.
        </EmptyState>
      )}

      <RegisterRestaurantModal
        open={registerOpen}
        onOpenChange={setRegisterOpen}
        onSuccess={handleRegisterSuccess}
      />
    </RoleShell>
  );
}
