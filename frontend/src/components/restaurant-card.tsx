'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Heart } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatDistance, formatMoney } from '@/lib/format';
import type { RestaurantCardData } from '@/lib/types';
import { Photo, Rating, Ticket } from './food';

export function RestaurantCard({ r, featured }: { r: RestaurantCardData; featured?: boolean }) {
  const [isFav, setIsFav] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('ff.favorites');
      if (stored) {
        const arr = JSON.parse(stored) as string[];
        setIsFav(arr.includes(r.id));
      }
    } catch {
      // ignore
    }
  }, [r.id]);

  const toggleFav = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const stored = localStorage.getItem('ff.favorites');
      let arr: string[] = stored ? JSON.parse(stored) : [];
      if (arr.includes(r.id)) {
        arr = arr.filter((x) => x !== r.id);
        setIsFav(false);
      } else {
        arr.push(r.id);
        setIsFav(true);
      }
      localStorage.setItem('ff.favorites', JSON.stringify(arr));
    } catch {
      // ignore
    }
  };

  return (
    <div className={cn('relative group block overflow-hidden rounded-card border border-border bg-card', featured && 'sm:col-span-2')}>
      <Link href={`/r/${r.slug}`} className="block">
        <div className="relative">
          <Photo url={r.coverUrl ?? r.logoUrl} name={r.name} className={cn('w-full', featured ? 'h-52 sm:h-60' : 'h-40')} />
          <Ticket range={r.estimatedDeliveryMinutes} className="absolute bottom-3 left-3" />
        </div>
        <div className="space-y-1.5 p-4">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-lg font-bold leading-snug group-hover:underline">{r.name}</h3>
            <Rating avg={r.ratingAvg} count={r.ratingCount} />
          </div>
          <p className="text-sm text-muted-foreground">{r.cuisines.map((c) => c.name).join(', ')}</p>
          <p className="text-sm">
            <span className="font-semibold">{r.deliveryFeeMinor === 0 ? 'Free delivery' : `${formatMoney(r.deliveryFeeMinor)} delivery`}</span>
            <span className="text-muted-foreground">, {formatDistance(r.distanceMeters)} away{r.minOrderMinor > 0 && `, min ${formatMoney(r.minOrderMinor)}`}</span>
          </p>
        </div>
      </Link>
      <button
        type="button"
        onClick={toggleFav}
        aria-label={isFav ? `Remove ${r.name} from favorites` : `Add ${r.name} to favorites`}
        className="absolute top-3 right-3 p-2 rounded-full bg-background/80 backdrop-blur border border-border/60 hover:bg-background text-foreground transition-all z-10"
      >
        <Heart className={cn('h-4 w-4', isFav ? 'text-destructive fill-destructive' : 'text-muted-foreground')} />
      </button>
    </div>
  );
}

export function RestaurantCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-card border border-border" aria-hidden>
      <div className="h-40 animate-pulse bg-panel" />
      <div className="space-y-2 p-4"><div className="h-5 w-2/3 animate-pulse rounded bg-panel" /><div className="h-4 w-1/2 animate-pulse rounded bg-panel" /><div className="h-4 w-3/4 animate-pulse rounded bg-panel" /></div>
    </div>
  );
}
