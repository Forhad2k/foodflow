'use client';
import { Minus, Plus, Trash2 } from 'lucide-react';
import { usePageTitle } from '@/hooks/use-page-title';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { Card, Skeleton } from '@/components/ui/misc';
import { useCartMutations } from '@/hooks/mutations';
import { useCart } from '@/hooks/queries';
import { ApiError } from '@/lib/api';
import { useRequireRole } from '@/lib/auth';
import { formatMoney } from '@/lib/format';

export default function CartPage() {
  const { ready } = useRequireRole('CUSTOMER');
  const cart = useCart();
  const m = useCartMutations();
  usePageTitle('Your cart');
  const [code, setCode] = useState('');
  const fail = (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');

  if (!ready || cart.isPending) return <div className="mx-auto max-w-3xl space-y-3"><Skeleton className="h-10 w-1/3" /><Skeleton className="h-32" /><Skeleton className="h-32" /></div>;
  if (cart.isError) return <ErrorState error={cart.error} onRetry={() => cart.refetch()} />;
  const c = cart.data;
  if (!c.restaurant || c.items.length === 0) return <EmptyState title="Your cart is empty" action={<Button asChild><Link href="/">Find something to eat</Link></Button>}>Add dishes from a restaurant and they will show up here.</EmptyState>;
  const blocked = c.issues.length > 0 || c.items.some((i) => !i.valid);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div><h1 className="text-3xl font-extrabold">Your cart</h1><p className="text-muted-foreground">From <Link href={`/r/${c.restaurant.slug}`} className="font-semibold text-foreground underline underline-offset-4">{c.restaurant.name}</Link></p></div>

      {c.issues.length > 0 && <ul role="alert" className="space-y-1 rounded-card border border-warning/30 bg-warning-soft p-4 text-sm font-semibold">{c.issues.map((i, k) => <li key={k}>{i.message}</li>)}</ul>}

      <ul className="space-y-3">
        {c.items.map((l) => (
          <li key={l.id}><Card className={`flex gap-4 p-4 ${l.valid ? '' : 'border-destructive/40'}`}>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-bold">{l.name}{l.variantName && <span className="font-normal text-muted-foreground"> · {l.variantName}</span>}</h2>
              {l.addons.length > 0 && <p className="text-sm text-muted-foreground">{l.addons.map((a) => a.name).join(', ')}</p>}
              {l.notes && <p className="text-sm italic text-muted-foreground">“{l.notes}”</p>}
              {!l.valid && <p className="mt-1 text-sm font-semibold text-destructive">This item can't be ordered right now. Remove it to continue.</p>}
              <div className="mt-3 flex items-center gap-3">
                <div className="flex items-center rounded-control border border-border" role="group" aria-label={`Quantity of ${l.name}`}>
                  <Button variant="ghost" size="icon" aria-label="Fewer" disabled={l.quantity <= 1 || m.update.isPending} onClick={() => m.update.mutate({ id: l.id, quantity: l.quantity - 1 }, { onError: fail })}><Minus className="h-4 w-4" /></Button>
                  <span className="w-8 text-center font-bold" aria-live="polite">{l.quantity}</span>
                  <Button variant="ghost" size="icon" aria-label="More" disabled={l.quantity >= 99 || m.update.isPending} onClick={() => m.update.mutate({ id: l.id, quantity: l.quantity + 1 }, { onError: fail })}><Plus className="h-4 w-4" /></Button>
                </div>
                <Button variant="ghost" size="sm" onClick={() => m.remove.mutate(l.id, { onError: fail })} aria-label={`Remove ${l.name}`}><Trash2 className="h-4 w-4" aria-hidden /> Remove</Button>
              </div>
            </div>
            <p className="font-bold">{formatMoney(l.lineTotalMinor)}</p>
          </Card></li>
        ))}
      </ul>

      <Card className="space-y-4 p-5">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (code.trim()) m.setCoupon.mutate(code.trim(), { onSuccess: () => { toast.success('Coupon added. It is checked again at checkout.'); setCode(''); }, onError: fail }); }}>
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Coupon code" aria-label="Coupon code" className="uppercase" />
          <Button type="submit" variant="outline" loading={m.setCoupon.isPending}>Apply</Button>
        </form>
        {c.couponCode && <p className="flex items-center justify-between text-sm"><span>Coupon <b>{c.couponCode}</b></span><Button variant="link" size="sm" onClick={() => m.removeCoupon.mutate(undefined, { onError: fail })}>Remove</Button></p>}
        <p className="flex items-center justify-between text-lg"><span className="font-semibold">Subtotal</span><b>{formatMoney(c.subtotalMinor)}</b></p>
        <p className="text-sm text-muted-foreground">Delivery fee, service fee and discounts are added at checkout.</p>
        <Button asChild size="lg" className="w-full" disabled={blocked}><Link href="/checkout" aria-disabled={blocked}>Go to checkout</Link></Button>
      </Card>
    </div>
  );
}
