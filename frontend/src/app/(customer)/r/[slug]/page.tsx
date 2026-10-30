'use client';
import { Clock, MapPinOff } from 'lucide-react';
import { usePageTitle } from '@/hooks/use-page-title';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ItemDialog } from '@/components/item-dialog';
import { Photo, Rating, Ticket } from '@/components/food';
import { EmptyState, ErrorState } from '@/components/states';
import { Badge, Skeleton } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/misc';
import { useRestaurant, useRestaurantReviews } from '@/hooks/queries';
import { ApiError } from '@/lib/api';
import { formatDateTime, formatMoney } from '@/lib/format';
import { useDeliveryLocation } from '@/lib/location';
import type { MenuItemData } from '@/lib/types';
import { Star } from 'lucide-react';

export default function RestaurantPage() {
  const { slug } = useParams<{ slug: string }>();
  const { location, ready } = useDeliveryLocation();
  const q = useRestaurant(slug, location ? { lat: location.lat, lng: location.lng } : null);
  const [item, setItem] = useState<MenuItemData | null>(null);
  const reviewsQuery = useRestaurantReviews(slug);
  usePageTitle(q.data?.name);

  if (!ready || q.isPending) return <div className="space-y-4"><Skeleton className="h-56" /><Skeleton className="h-8 w-1/2" /><Skeleton className="h-40" /></div>;
  if (q.isError) return q.error instanceof ApiError && q.error.status === 404 ? <EmptyState title="This restaurant isn't available" action={<Button asChild><a href="/">See other restaurants</a></Button>}>It may be closed for good or not open for orders yet.</EmptyState> : <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data;
  const d = r.deliverability;

  return (
    <div className="space-y-6">
      <div className="overflow-hidden rounded-card border border-border">
        <Photo url={r.coverUrl ?? r.logoUrl} name={r.name} className="h-48 w-full sm:h-64" />
        <div className="space-y-3 p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h1 className="text-3xl font-extrabold sm:text-4xl">{r.name}</h1><p className="mt-1 text-muted-foreground">{r.cuisines.map((c) => c.name).join(', ')} · {r.addressLine}</p></div>
            {d?.deliverable && d.estimatedDeliveryMinutes && <Ticket range={d.estimatedDeliveryMinutes} />}
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <Rating avg={r.ratingAvg} count={r.ratingCount} />
            <span><b>{formatMoney(d?.deliveryFeeMinor ?? r.baseDeliveryFeeMinor)}</b> delivery</span>
            {(d?.minOrderMinor ?? r.minOrderMinor) > 0 && <span>Minimum order <b>{formatMoney(d?.minOrderMinor ?? r.minOrderMinor)}</b></span>}
            <Badge tone={r.isOpen ? 'success' : 'danger'}>{r.isOpen ? 'Open now' : 'Closed right now'}</Badge>
          </div>
          {r.description && <p className="max-w-prose text-muted-foreground">{r.description}</p>}
        </div>
      </div>

      {d && !d.deliverable && <div role="status" className="flex items-start gap-3 rounded-card border border-warning/30 bg-warning-soft p-4"><MapPinOff className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden /><p><b>This restaurant doesn't deliver to {location?.label}.</b> You can still look at the menu, or change your delivery location.</p></div>}
      {!r.isOpen && <div role="status" className="flex items-start gap-3 rounded-card border border-border bg-panel p-4"><Clock className="mt-0.5 h-5 w-5 shrink-0" aria-hidden /><p><b>Closed right now.</b> Ordering is switched off until it opens.</p></div>}

      {r.menu.length === 0 ? <EmptyState title="The menu isn't ready yet">This restaurant hasn't added dishes. Check back soon.</EmptyState> : (
        <div className="grid gap-8 lg:grid-cols-[200px_1fr]">
          <nav aria-label="Menu sections" className="hidden lg:block"><ul className="sticky top-24 space-y-1">{r.menu.map((c) => <li key={c.id}><a href={`#cat-${c.id}`} className="block rounded-control px-3 py-2 text-sm font-semibold hover:bg-panel">{c.name}</a></li>)}</ul></nav>
          <div className="space-y-10">
            {r.menu.map((c) => (
              <section key={c.id} id={`cat-${c.id}`} className="scroll-mt-24" aria-labelledby={`h-${c.id}`}>
                <h2 id={`h-${c.id}`} className="mb-4 text-2xl font-bold">{c.name}</h2>
                <ul className="grid gap-4 md:grid-cols-2">
                  {c.items.map((it) => {
                    const from = it.variants.length ? Math.min(...it.variants.filter((v) => v.isAvailable).map((v) => v.priceMinor), Infinity) : it.basePriceMinor;
                    const canOrder = it.isAvailable && r.isOpen;
                    return (
                      <li key={it.id} className="flex gap-4 rounded-card border border-border p-4">
                        <div className="min-w-0 flex-1">
                          <h3 className="text-lg font-bold">{it.name}</h3>
                          {it.description && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{it.description}</p>}
                          <p className="mt-2 font-semibold">{it.variants.length > 1 && Number.isFinite(from) ? 'From ' : ''}{formatMoney(Number.isFinite(from) ? from : it.basePriceMinor)}</p>
                          <Button size="sm" className="mt-3" variant={canOrder ? 'default' : 'outline'} disabled={!canOrder} onClick={() => setItem(it)} aria-label={`${canOrder ? 'Add' : 'Unavailable:'} ${it.name}`}>{it.isAvailable ? (r.isOpen ? 'Add' : 'Closed') : 'Sold out'}</Button>
                        </div>
                        <Photo url={it.images[0]?.url} name={it.name} className="h-24 w-24 shrink-0 rounded-tile" />
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        </div>
      )}

      {/* Customer Reviews Section */}
      <section className="pt-8 border-t border-border space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-2xl font-bold">Customer Reviews</h2>
            <p className="text-sm text-muted-foreground">Verified reviews from customers who ordered from this restaurant.</p>
          </div>
          {reviewsQuery.data && (
            <div className="flex items-center gap-2 rounded-ticket bg-panel px-3 py-1.5 border border-border">
              <Star className="h-4 w-4 fill-primary text-primary" />
              <span className="font-bold text-base">{reviewsQuery.data.rating.average.toFixed(1)}</span>
              <span className="text-xs text-muted-foreground">({reviewsQuery.data.rating.count} {reviewsQuery.data.rating.count === 1 ? 'review' : 'reviews'})</span>
            </div>
          )}
        </div>

        {reviewsQuery.isLoading ? (
          <Skeleton className="h-32" />
        ) : reviewsQuery.data && reviewsQuery.data.items.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2">
            {reviewsQuery.data.items.map((rev) => (
              <Card key={rev.id} className="p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-foreground text-sm">{rev.reviewer}</span>
                  <div className="flex items-center gap-1 text-xs font-bold text-primary-deep">
                    {'★'.repeat(rev.rating)}{'☆'.repeat(5 - rev.rating)}
                  </div>
                </div>
                {rev.comment ? (
                  <p className="text-sm text-foreground/90 italic">“{rev.comment}”</p>
                ) : (
                  <p className="text-xs text-muted-foreground italic">Left a rating without comment</p>
                )}
                <p className="text-[11px] text-muted-foreground">{formatDateTime(rev.createdAt)}</p>
              </Card>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground py-4">No reviews yet for this restaurant. Be the first to order and leave a review!</p>
        )}
      </section>

      {item && <ItemDialog key={item.id} item={item} open onOpenChange={(o) => !o && setItem(null)} />}
    </div>
  );
}
