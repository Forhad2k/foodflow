'use client';
import { Minus, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useCartMutations } from '@/hooks/mutations';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatMoney } from '@/lib/format';
import type { MenuItemData } from '@/lib/types';
import { Button } from './ui/button';
import { Checkbox, RadioGroup, RadioItem } from './ui/choice';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Label, Textarea } from './ui/form';

/** Choose options, quantity and notes. The price shown is a preview: the server prices the cart from its own menu. */
export function ItemDialog({ item, open, onOpenChange }: { item: MenuItemData; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { user, status } = useAuth();
  const router = useRouter();
  const { add } = useCartMutations();
  const available = item.variants.filter((v) => v.isAvailable);
  const [variantId, setVariantId] = useState<string | undefined>(available.find((v) => v.isDefault)?.id ?? available[0]?.id);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState('');
  const [confirmReplace, setConfirmReplace] = useState(false);

  const addonIds = Object.values(picked).flat();
  const unit = useMemo(() => {
    const base = item.variants.length ? (item.variants.find((v) => v.id === variantId)?.priceMinor ?? 0) : item.basePriceMinor;
    const extras = item.addonGroups.flatMap((g) => g.addons).filter((a) => addonIds.includes(a.id)).reduce((s, a) => s + a.priceMinor, 0);
    return base + extras;
  }, [item, variantId, addonIds]);

  const problems = item.addonGroups.flatMap((g) => ((picked[g.id]?.length ?? 0) < g.minSelect ? [`Choose ${g.minSelect === 1 ? 'one' : `at least ${g.minSelect}`} from ${g.name}`] : []));
  if (item.variants.length && !variantId) problems.push('Choose an option');

  const toggle = (groupId: string, addonId: string, max: number) =>
    setPicked((p) => {
      const cur = p[groupId] ?? [];
      if (cur.includes(addonId)) return { ...p, [groupId]: cur.filter((x) => x !== addonId) };
      return { ...p, [groupId]: max === 1 ? [addonId] : cur.length >= max ? cur : [...cur, addonId] };
    });

  const submit = async (replaceCart = false) => {
    if (status !== 'authenticated') return router.push(`/login?next=${encodeURIComponent(window.location.pathname)}`);
    if (user?.role !== 'CUSTOMER') return toast.error('Sign in with a customer account to order.');
    try {
      await add.mutateAsync({ menuItemId: item.id, variantId, addonIds: addonIds.length ? addonIds : undefined, quantity: qty, notes: notes.trim() || undefined, replaceCart: replaceCart || undefined });
      toast.success(`Added ${qty} × ${item.name} to your cart`);
      onOpenChange(false);
      setConfirmReplace(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CART_RESTAURANT_MISMATCH') setConfirmReplace(true);
      else toast.error(e instanceof ApiError ? e.message : 'Could not add to cart. Please try again.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>{item.name}</DialogTitle>
        <DialogDescription className="mt-1 text-muted-foreground">{item.description}</DialogDescription>

        {confirmReplace ? (
          <div className="mt-6 space-y-4" role="alert">
            <p className="font-semibold">Your cart has items from another restaurant.</p>
            <p className="text-muted-foreground">You can order from one restaurant at a time. Start a new cart with this item?</p>
            <div className="flex gap-3"><Button variant="dark" onClick={() => submit(true)} loading={add.isPending}>Start a new cart</Button><Button variant="outline" onClick={() => setConfirmReplace(false)}>Keep my cart</Button></div>
          </div>
        ) : (
          <form className="mt-5 space-y-6" onSubmit={(e) => { e.preventDefault(); if (!problems.length) void submit(); }}>
            {item.variants.length > 0 && (
              <fieldset><legend className="mb-2 font-bold">Size or option</legend>
                <RadioGroup value={variantId} onValueChange={setVariantId} className="space-y-2">
                  {item.variants.map((v) => (
                    <label key={v.id} className={`flex items-center justify-between gap-3 rounded-tile border border-border p-3 ${v.isAvailable ? 'cursor-pointer' : 'opacity-50'}`}>
                      <span className="flex items-center gap-3"><RadioItem value={v.id} disabled={!v.isAvailable} aria-label={v.name} />{v.name}{!v.isAvailable && ' (sold out)'}</span>
                      <span className="font-semibold">{formatMoney(v.priceMinor)}</span>
                    </label>
                  ))}
                </RadioGroup>
              </fieldset>
            )}
            {item.addonGroups.map((g) => (
              <fieldset key={g.id}><legend className="mb-2 font-bold">{g.name} <span className="font-normal text-muted-foreground">{g.minSelect > 0 ? `(required, choose ${g.minSelect === g.maxSelect ? g.minSelect : `${g.minSelect}–${g.maxSelect}`})` : `(optional, up to ${g.maxSelect})`}</span></legend>
                {g.maxSelect === 1 ? (
                  <RadioGroup value={picked[g.id]?.[0] ?? ''} onValueChange={(v) => setPicked((p) => ({ ...p, [g.id]: [v] }))} className="space-y-2">
                    {g.addons.map((a) => (
                      <label key={a.id} className={`flex items-center justify-between gap-3 rounded-tile border border-border p-3 ${a.isAvailable ? 'cursor-pointer' : 'opacity-50'}`}>
                        <span className="flex items-center gap-3"><RadioItem value={a.id} disabled={!a.isAvailable} aria-label={a.name} />{a.name}</span>
                        {a.priceMinor > 0 && <span className="text-muted-foreground">+{formatMoney(a.priceMinor)}</span>}
                      </label>
                    ))}
                  </RadioGroup>
                ) : (
                  <div className="space-y-2">
                    {g.addons.map((a) => {
                      const on = picked[g.id]?.includes(a.id) ?? false;
                      const full = !on && (picked[g.id]?.length ?? 0) >= g.maxSelect;
                      return (
                        <label key={a.id} className={`flex items-center justify-between gap-3 rounded-tile border border-border p-3 ${a.isAvailable && !full ? 'cursor-pointer' : 'opacity-50'}`}>
                          <span className="flex items-center gap-3"><Checkbox checked={on} disabled={!a.isAvailable || full} onCheckedChange={() => toggle(g.id, a.id, g.maxSelect)} aria-label={a.name} />{a.name}</span>
                          {a.priceMinor > 0 && <span className="text-muted-foreground">+{formatMoney(a.priceMinor)}</span>}
                        </label>
                      );
                    })}
                  </div>
                )}
              </fieldset>
            ))}
            <div className="space-y-1.5"><Label htmlFor="notes">Special instructions (optional)</Label><Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={200} placeholder="No onion, extra spicy…" /></div>

            {problems.length > 0 && <ul className="text-sm text-destructive" role="alert">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
            <div className="flex items-center gap-4">
              <div className="flex items-center rounded-control border border-border" role="group" aria-label="Quantity">
                <Button type="button" variant="ghost" size="icon" onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="Fewer" disabled={qty <= 1}><Minus className="h-4 w-4" /></Button>
                <span className="w-8 text-center font-bold" aria-live="polite">{qty}</span>
                <Button type="button" variant="ghost" size="icon" onClick={() => setQty((q) => Math.min(99, q + 1))} aria-label="More"><Plus className="h-4 w-4" /></Button>
              </div>
              <Button type="submit" size="lg" className="flex-1" disabled={problems.length > 0} loading={add.isPending}>Add to cart · {formatMoney(unit * qty)}</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
