'use client';
import { useEffect, useState } from 'react';
import { usePageTitle } from '@/hooks/use-page-title';
import { LocationPicker } from '@/components/location-picker';
import { RestaurantCard, RestaurantCardSkeleton } from '@/components/restaurant-card';
import { EmptyState, ErrorState } from '@/components/states';
import { Input } from '@/components/ui/form';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/misc';
import { useCuisines, useRestaurants } from '@/hooks/queries';
import { useDebounced } from '@/hooks/use-debounced';
import { useDeliveryLocation } from '@/lib/location';
import { ChevronLeft, ChevronRight, Filter, Heart, Search, Sparkles, Tag, X } from 'lucide-react';

const SORTS = [
  ['recommended', 'Recommended'],
  ['delivery_time', 'Fastest'],
  ['distance', 'Nearest'],
  ['rating', 'Top rated'],
  ['delivery_fee', 'Lowest delivery fee'],
] as const;

const EMPTY: Record<string, { title: string; body: string }> = {
  NO_RESTAURANTS_IN_AREA: { title: 'No restaurants deliver here yet', body: 'Try a nearby area. We are adding restaurants all the time.' },
  ALL_CLOSED: { title: 'Everything nearby is closed right now', body: 'Check back later. Opening hours are shown on each restaurant page.' },
  FILTERS_TOO_STRICT: { title: 'Nothing matches those filters', body: 'Clear the search or the filters to see everything open near you.' },
};

export default function Discover() {
  const { location, ready } = useDeliveryLocation();
  usePageTitle(location ? `Restaurants near ${location.label}` : 'Food delivery in Dhaka');

  const [q, setQ] = useState('');
  const [cuisine, setCuisine] = useState<string[]>([]);
  const [sort, setSort] = useState('recommended');
  const [page, setPage] = useState(1);
  const [priceTier, setPriceTier] = useState<number[]>([]);
  const [minRating, setMinRating] = useState<number | undefined>(undefined);
  const [maxDeliveryFee, setMaxDeliveryFee] = useState<number | undefined>(undefined);
  const [maxEtaMinutes, setMaxEtaMinutes] = useState<number | undefined>(undefined);
  const [showFilters, setShowFilters] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [favorites, setFavorites] = useState<string[]>([]);

  // Load favorites from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem('ff.favorites');
      if (stored) setFavorites(JSON.parse(stored));
    } catch {
      // ignore
    }
  }, []);

  const dq = useDebounced(q.trim(), 300);
  const cuisines = useCuisines();

  // Reset page when search or filters change
  useEffect(() => {
    setPage(1);
  }, [dq, cuisine, priceTier, minRating, maxDeliveryFee, maxEtaMinutes, sort]);

  const list = useRestaurants(
    location
      ? {
          lat: location.lat,
          lng: location.lng,
          q: dq || undefined,
          cuisine: cuisine.length ? cuisine : undefined,
          priceTier: priceTier.length ? priceTier : undefined,
          minRating,
          maxDeliveryFee: maxDeliveryFee ? maxDeliveryFee * 100 : undefined, // API expects paisa
          maxEtaMinutes,
          sort,
          page,
          limit: 30,
        }
      : null,
  );

  if (!ready) {
    return (
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <RestaurantCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (!location) {
    return (
      <section className="mx-auto max-w-2xl py-6">
        <h1 className="text-4xl font-extrabold leading-tight sm:text-5xl">What's open near you?</h1>
        <p className="mb-8 mt-3 text-lg text-muted-foreground">
          Tell us where to deliver and we'll show only the restaurants that can reach you, with accurate delivery times.
        </p>
        <LocationPicker />
      </section>
    );
  }

  const activeFilterCount =
    (priceTier.length > 0 ? 1 : 0) +
    (minRating !== undefined ? 1 : 0) +
    (maxDeliveryFee !== undefined ? 1 : 0) +
    (maxEtaMinutes !== undefined ? 1 : 0);

  const clearAllFilters = () => {
    setQ('');
    setCuisine([]);
    setPriceTier([]);
    setMinRating(undefined);
    setMaxDeliveryFee(undefined);
    setMaxEtaMinutes(undefined);
    setFavoritesOnly(false);
  };

  const rawItems = list.data?.items ?? [];
  const displayItems = favoritesOnly
    ? rawItems.filter((r) => favorites.includes(r.id))
    : rawItems;

  const totalPages = list.data ? Math.ceil(list.data.total / list.data.limit) : 1;

  return (
    <div className="space-y-6">
      {/* Promotional Banner */}
      <div className="rounded-card bg-gradient-to-r from-ink to-ink/90 p-5 text-ink-foreground flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-bold text-primary">
            <Sparkles className="h-4 w-4" /> SPECIAL OFFERS IN DHAKA
          </div>
          <h2 className="font-display text-2xl font-extrabold">Craving hot biryani or spicy tehari?</h2>
          <p className="text-sm text-ink-foreground/80">Get free delivery and up to ৳200 off with code FOODFLOW50 at checkout.</p>
        </div>
        <div className="ticket px-4 py-2 font-display text-base font-extrabold flex items-center gap-1.5">
          <Tag className="h-4 w-4" /> FOODFLOW50
        </div>
      </div>

      {/* Search Bar & Filter Toggle */}
      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search restaurants, burgers, biryani, or dishes"
            aria-label="Search restaurants or dishes"
            className="h-14 pl-12 text-lg"
          />
        </div>
        <Button
          type="button"
          variant={showFilters || activeFilterCount > 0 ? 'dark' : 'outline'}
          onClick={() => setShowFilters(!showFilters)}
          className="h-14 px-5 text-base flex items-center gap-2"
        >
          <Filter className="h-5 w-5" />
          <span className="hidden sm:inline">Filters</span>
          {activeFilterCount > 0 && (
            <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-bold text-primary-foreground">
              {activeFilterCount}
            </span>
          )}
        </Button>
      </div>

      {/* Expanded Filter Panel */}
      {showFilters && (
        <div className="rounded-card border border-border bg-panel/60 p-5 space-y-4">
          <div className="flex items-center justify-between pb-2 border-b border-border">
            <h3 className="font-bold text-base flex items-center gap-2">
              <Filter className="h-4 w-4 text-primary" /> Filter Restaurants
            </h3>
            {activeFilterCount > 0 && (
              <Button variant="ghost" size="sm" onClick={clearAllFilters} className="text-xs">
                <X className="h-3.5 w-3.5 mr-1" /> Reset all
              </Button>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
            {/* Price Tier */}
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Price Tier</p>
              <div className="flex gap-1.5">
                {[1, 2, 3, 4].map((tier) => {
                  const on = priceTier.includes(tier);
                  const label = '৳'.repeat(tier);
                  return (
                    <button
                      key={tier}
                      type="button"
                      onClick={() => setPriceTier((p) => (on ? p.filter((x) => x !== tier) : [...p, tier]))}
                      aria-pressed={on}
                      className="flex-1 rounded-control border border-border py-1.5 text-center text-sm font-bold hover:bg-background aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-ink-foreground transition-colors"
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Minimum Rating */}
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Minimum Rating</p>
              <div className="flex gap-1.5">
                {[3.5, 4.0, 4.5].map((r) => {
                  const on = minRating === r;
                  return (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setMinRating(on ? undefined : r)}
                      aria-pressed={on}
                      className="flex-1 rounded-control border border-border py-1.5 text-center text-sm font-semibold hover:bg-background aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-ink-foreground transition-colors"
                    >
                      ★ {r}+
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Max Delivery Fee */}
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Max Delivery Fee</p>
              <div className="flex gap-1.5">
                {[50, 80, 120].map((fee) => {
                  const on = maxDeliveryFee === fee;
                  return (
                    <button
                      key={fee}
                      type="button"
                      onClick={() => setMaxDeliveryFee(on ? undefined : fee)}
                      aria-pressed={on}
                      className="flex-1 rounded-control border border-border py-1.5 text-center text-sm font-semibold hover:bg-background aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-ink-foreground transition-colors"
                    >
                      ≤ ৳{fee}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Max ETA */}
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Speed</p>
              <div className="flex gap-1.5">
                {[30, 45, 60].map((eta) => {
                  const on = maxEtaMinutes === eta;
                  return (
                    <button
                      key={eta}
                      type="button"
                      onClick={() => setMaxEtaMinutes(on ? undefined : eta)}
                      aria-pressed={on}
                      className="flex-1 rounded-control border border-border py-1.5 text-center text-sm font-semibold hover:bg-background aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-ink-foreground transition-colors"
                    >
                      ≤ {eta}m
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Cuisines Pill Row */}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Cuisines">
        <button
          type="button"
          aria-pressed={favoritesOnly}
          onClick={() => setFavoritesOnly(!favoritesOnly)}
          className="rounded-full border border-border px-3.5 py-1.5 text-sm font-semibold hover:bg-panel aria-pressed:border-destructive aria-pressed:bg-destructive aria-pressed:text-white flex items-center gap-1.5 transition-colors"
        >
          <Heart className={`h-3.5 w-3.5 ${favoritesOnly ? 'fill-current' : ''}`} />
          Favorites {favorites.length > 0 && `(${favorites.length})`}
        </button>

        {cuisines.data?.map((c) => {
          const on = cuisine.includes(c.slug);
          return (
            <button
              key={c.id}
              type="button"
              aria-pressed={on}
              onClick={() => setCuisine((s) => (on ? s.filter((x) => x !== c.slug) : [...s, c.slug]))}
              className="rounded-full border border-border px-4 py-2 text-sm font-semibold hover:bg-panel aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-ink-foreground transition-colors"
            >
              {c.name}
            </button>
          );
        })}
      </div>

      {/* Heading & Sorting */}
      <div className="flex items-end justify-between gap-4">
        <h1 className="text-2xl font-extrabold">
          {list.data ? (
            favoritesOnly ? (
              `${displayItems.length} favorite restaurants`
            ) : (
              `${list.data.total} open near ${location.label}`
            )
          ) : (
            'Looking for restaurants…'
          )}
        </h1>
        <label className="flex items-center gap-2 text-sm font-semibold">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="h-10 rounded-control border border-border bg-background px-3 font-normal"
          >
            {SORTS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Restaurant List Grid */}
      {list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : list.isPending ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <RestaurantCardSkeleton key={i} />
          ))}
        </div>
      ) : displayItems.length === 0 ? (
        <EmptyState title={favoritesOnly ? 'No favorites match this area' : EMPTY[list.data.emptyReason ?? 'NO_RESTAURANTS_IN_AREA'].title}>
          {favoritesOnly
            ? 'Heart your favorite restaurants to find them quickly here.'
            : EMPTY[list.data.emptyReason ?? 'NO_RESTAURANTS_IN_AREA'].body}
        </EmptyState>
      ) : (
        <div className={`grid gap-5 sm:grid-cols-2 lg:grid-cols-3 ${list.isPlaceholderData ? 'opacity-60' : ''}`}>
          {displayItems.map((r, i) => (
            <RestaurantCard
              key={r.id}
              r={r}
              featured={i === 0 && !dq && cuisine.length === 0 && displayItems.length >= 4}
            />
          ))}
        </div>
      )}

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 pt-4 pb-8">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => {
              setPage((p) => Math.max(1, p - 1));
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          >
            <ChevronLeft className="h-4 w-4 mr-1" /> Previous
          </Button>

          <span className="text-sm font-semibold text-muted-foreground">
            Page {page} of {totalPages}
          </span>

          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => {
              setPage((p) => p + 1);
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          >
            Next <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
      )}
    </div>
  );
}
