import { Star } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatEta } from '@/lib/format';

/**
 * The order ticket: FoodFlow's one memorable shape. A notched turmeric slip with a perforated divider, like the
 * tickets a kitchen prints for every order. It carries the answer to the customer's first question: how soon?
 */
export function Ticket({ range, className }: { range: { min: number; max: number }; className?: string }) {
  return (
    <div className={cn('ticket inline-flex items-center gap-2.5 px-3.5 py-1.5', className)} aria-label={`Delivery in ${range.min} to ${range.max} minutes`}>
      <span className="font-display text-lg font-extrabold leading-none">{formatEta(range)}</span>
      <span className="perforation pl-2.5 text-xs font-semibold leading-tight">min</span>
    </div>
  );
}

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Stand-in for food photography until a restaurant uploads some: a plate on a tinted tile, tinted per restaurant. */
export function Plate({ name, className }: { name: string; className?: string }) {
  const hue = 35 + (hash(name) % 110); // warm to green: spices, herbs, rice
  return (
    <div className={cn('relative flex items-center justify-center overflow-hidden', className)} style={{ backgroundColor: `hsl(${hue} 38% 90%)` }} role="img" aria-label={`${name} (no photo yet)`}>
      <div className="flex aspect-square h-[62%] items-center justify-center rounded-full border-[6px] bg-white font-display text-3xl font-extrabold" style={{ borderColor: `hsl(${hue} 40% 78%)`, color: `hsl(${hue} 45% 26%)` }}>
        {name.trim().charAt(0).toUpperCase()}
      </div>
    </div>
  );
}

export function Photo({ url, name, className }: { url?: string | null; name: string; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt="" loading="lazy" className={cn('object-cover', className)} /> : <Plate name={name} className={className} />;
}

export function Rating({ avg, count }: { avg: number; count: number }) {
  if (count === 0) return <span className="text-sm font-semibold text-primary-deep">New</span>;
  return (
    <span className="inline-flex items-center gap-1 text-sm font-semibold" aria-label={`Rated ${avg.toFixed(1)} out of 5 by ${count} people`}>
      <Star className="h-4 w-4 fill-primary text-primary" aria-hidden /> {avg.toFixed(1)} <span className="font-normal text-muted-foreground">({count})</span>
    </span>
  );
}
