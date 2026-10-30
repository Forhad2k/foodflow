'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { usePageTitle } from '@/hooks/use-page-title';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { EmptyState, ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioItem } from '@/components/ui/choice';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Field, Input, Label, Textarea } from '@/components/ui/form';
import { Card, Skeleton } from '@/components/ui/misc';
import { useAddresses, useCart } from '@/hooks/queries';
import { api, ApiError } from '@/lib/api';
import { useRequireRole } from '@/lib/auth';
import { formatEta, formatMoney } from '@/lib/format';
import { useDeliveryLocation } from '@/lib/location';
import { normalizePhone } from '@/lib/phone';
import type { Address, OrderView, PaymentMethod, Quote } from '@/lib/types';

const addressSchema = z.object({ label: z.string().trim().min(1, 'Name this address, e.g. Home'), line1: z.string().trim().min(3, 'Enter house, road and block'), area: z.string().trim().optional(), city: z.string().trim().min(2, 'Enter the city'), instructions: z.string().trim().max(300).optional() });

function AddAddress({ onAdded }: { onAdded: (a: Address) => void }) {
  const { location } = useDeliveryLocation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { register, handleSubmit, formState: { errors, isSubmitting }, reset } = useForm<z.infer<typeof addressSchema>>({ resolver: zodResolver(addressSchema), defaultValues: { label: 'Home', city: 'Dhaka', area: location && location.source === 'area' ? location.label : '' } });
  const submit = handleSubmit(async (v) => {
    if (!location) return toast.error('Set your delivery location first so we can pin this address.');
    try {
      const a = await api.post<Address>('/addresses', { ...v, area: v.area || undefined, instructions: v.instructions || undefined, lat: location.lat, lng: location.lng });
      await qc.invalidateQueries({ queryKey: ['addresses'] });
      onAdded(a); setOpen(false); reset();
    } catch (e) { toast.error(e instanceof ApiError ? e.message : 'Could not save the address.'); }
  });
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" aria-hidden /> Add a new address</Button>
      <Dialog open={open} onOpenChange={setOpen}><DialogContent>
        <DialogTitle>New delivery address</DialogTitle>
        <DialogDescription className="mt-1 text-muted-foreground">{location ? <>Pinned to <b>{location.label}</b>. Change it from the location button at the top if that's wrong.</> : 'Set your delivery location first.'}</DialogDescription>
        <form onSubmit={submit} className="mt-5 space-y-4" noValidate>
          <Field id="label" label="Name" error={errors.label?.message}><Input id="label" {...register('label')} /></Field>
          <Field id="line1" label="House, road, block" error={errors.line1?.message}><Input id="line1" autoComplete="address-line1" {...register('line1')} /></Field>
          <div className="grid gap-4 sm:grid-cols-2"><Field id="area" label="Area" error={errors.area?.message}><Input id="area" {...register('area')} /></Field><Field id="city" label="City" error={errors.city?.message}><Input id="city" {...register('city')} /></Field></div>
          <Field id="instr" label="Directions for the rider (optional)" error={errors.instructions?.message}><Textarea id="instr" placeholder="Gate 3, 4th floor, ring the bell twice" {...register('instructions')} /></Field>
          <Button type="submit" size="lg" className="w-full" loading={isSubmitting}>Save address</Button>
        </form>
      </DialogContent></Dialog>
    </>
  );
}

export default function Checkout() {
  const { ready, user } = useRequireRole('CUSTOMER');
  const router = useRouter();
  usePageTitle('Checkout');
  const qc = useQueryClient();
  const cart = useCart();
  const addresses = useAddresses();
  const [addressId, setAddressId] = useState<string>();
  const [method, setMethod] = useState<PaymentMethod>('CASH_ON_DELIVERY');
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState<string>();
  const [instructions, setInstructions] = useState('');
  const [note, setNote] = useState('');
  const attempt = useRef<{ sig: string; key: string } | null>(null);
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<{ phone: string | null }>('/users/me'), enabled: ready });

  useEffect(() => { if (!addressId && addresses.data?.length) setAddressId((addresses.data.find((a) => a.isDefault) ?? addresses.data[0]).id); }, [addresses.data, addressId]);
  const lines = cart.data?.items ?? [];
  const quote = useQuery({
    queryKey: ['quote', addressId, cart.data?.couponCode, lines.map((l) => `${l.id}:${l.quantity}`).join(',')], enabled: !!addressId && lines.length > 0,
    queryFn: () => api.post<Quote>('/checkout/quote', { addressId }), retry: false,
  });
  useEffect(() => { if (quote.data && !quote.data.paymentMethods.includes(method)) setMethod(quote.data.paymentMethods[0]); }, [quote.data, method]);

  const place = useMutation({
    mutationFn: async () => {
      const phoneValue = phone.trim() ? normalizePhone(phone) : null;
      if (phone.trim() && !phoneValue) throw Object.assign(new Error('phone'), { field: 'phone' });
      const sig = JSON.stringify([addressId, method, phoneValue, instructions, note, cart.data?.couponCode, lines.map((l) => [l.id, l.quantity])]);
      // The same key is reused for retries of the SAME checkout, so a double-click or a flaky network can never create two orders.
      if (attempt.current?.sig !== sig) attempt.current = { sig, key: `ck-${crypto.randomUUID()}` };
      return api.post<OrderView>('/orders', { addressId, paymentMethod: method, ...(phoneValue && { contactPhone: phoneValue }), ...(instructions.trim() && { deliveryInstructions: instructions.trim() }), ...(note.trim() && { customerNote: note.trim() }) }, { idempotencyKey: attempt.current.key });
    },
    onSuccess: async (order) => {
      await qc.invalidateQueries({ queryKey: ['cart'] });
      if (order.payment?.redirectUrl) window.location.assign(order.payment.redirectUrl);
      else { toast.success('Order placed. The restaurant has been notified.'); router.replace(`/orders/${order.id}`); }
    },
    onError: (e: unknown) => {
      if ((e as { field?: string }).field === 'phone') return setPhoneError('Use a Bangladesh mobile number like 01712345678');
      if (e instanceof ApiError && e.code === 'CONTACT_PHONE_REQUIRED') return setPhoneError('Add a phone number so the rider can reach you.');
      if (e instanceof ApiError && e.code === 'CHECKOUT_BLOCKED') { void quote.refetch(); void cart.refetch(); return toast.error('Something changed in your order. Review it and try again.'); }
      toast.error(e instanceof ApiError ? e.message : 'Could not place the order. Please try again.');
    },
  });

  if (!ready || cart.isPending || addresses.isPending) return <div className="mx-auto max-w-4xl space-y-3"><Skeleton className="h-10 w-1/3" /><Skeleton className="h-48" /></div>;
  if (cart.isError || addresses.isError) return <ErrorState error={cart.error ?? addresses.error} onRetry={() => { void cart.refetch(); void addresses.refetch(); }} />;
  if (lines.length === 0) return <EmptyState title="Your cart is empty" action={<Button asChild><Link href="/">Find something to eat</Link></Button>}>Add dishes before checking out.</EmptyState>;
  const q = quote.data;
  const needsPhone = !me.data?.phone;

  return (
    <div className="mx-auto grid max-w-5xl gap-8 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-8">
        <h1 className="text-3xl font-extrabold">Checkout</h1>

        <section aria-labelledby="addr-h" className="space-y-3">
          <h2 id="addr-h" className="text-xl font-bold">Deliver to</h2>
          {addresses.data.length === 0 ? <p className="text-muted-foreground">Add the address where your food should arrive.</p> : (
            <RadioGroup value={addressId} onValueChange={setAddressId} className="space-y-2">
              {addresses.data.map((a) => (
                <label key={a.id} className="flex cursor-pointer items-start gap-3 rounded-tile border border-border p-3.5 has-[[data-state=checked]]:border-ink has-[[data-state=checked]]:bg-panel">
                  <RadioItem value={a.id} className="mt-1" aria-label={a.label} /><MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span><b>{a.label}</b><br /><span className="text-sm text-muted-foreground">{a.line1}{a.area ? `, ${a.area}` : ''}, {a.city}</span></span>
                </label>
              ))}
            </RadioGroup>
          )}
          <AddAddress onAdded={(a) => setAddressId(a.id)} />
        </section>

        <section aria-labelledby="contact-h" className="space-y-4">
          <h2 id="contact-h" className="text-xl font-bold">Contact and notes</h2>
          <Field id="phone" label={needsPhone ? 'Mobile number' : 'Mobile number (optional: leave empty to use your profile number)'} error={phoneError} hint="The rider calls this number if they cannot find you.">
            <Input id="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="01712345678" value={phone} aria-invalid={!!phoneError} onChange={(e) => { setPhone(e.target.value); setPhoneError(undefined); }} />
          </Field>
          <div className="space-y-1.5"><Label htmlFor="di">Delivery instructions (optional)</Label><Textarea id="di" value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={300} placeholder="Leave at the gate, call on arrival…" /></div>
          <div className="space-y-1.5"><Label htmlFor="note">Note for the restaurant (optional)</Label><Textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></div>
        </section>

        <section aria-labelledby="pay-h" className="space-y-3">
          <h2 id="pay-h" className="text-xl font-bold">Payment</h2>
          <RadioGroup value={method} onValueChange={(v) => setMethod(v as PaymentMethod)} className="space-y-2">
            {(q?.paymentMethods ?? ['CASH_ON_DELIVERY']).map((p) => (
              <label key={p} className="flex cursor-pointer items-center gap-3 rounded-tile border border-border p-3.5 has-[[data-state=checked]]:border-ink has-[[data-state=checked]]:bg-panel">
                <RadioItem value={p} aria-label={p === 'ONLINE' ? 'Pay online' : 'Cash on delivery'} />
                <span><b>{p === 'ONLINE' ? 'Pay online' : 'Cash on delivery'}</b><br /><span className="text-sm text-muted-foreground">{p === 'ONLINE' ? 'You will be sent to the payment page. The restaurant sees your order once payment is confirmed.' : 'Pay the rider in cash when your food arrives.'}</span></span>
              </label>
            ))}
          </RadioGroup>
        </section>
      </div>

      <aside aria-labelledby="sum-h"><Card className="sticky top-24 space-y-4 p-5">
        <h2 id="sum-h" className="text-xl font-bold">{q?.restaurant.name ?? cart.data?.restaurant?.name}</h2>
        {quote.isError && <p role="alert" className="text-sm font-semibold text-destructive">{quote.error instanceof ApiError ? quote.error.message : 'Could not calculate your total.'}</p>}
        {!addressId && <p className="text-sm text-muted-foreground">Add a delivery address to see your total.</p>}
        {quote.isFetching && !q && <Skeleton className="h-32" />}
        {q && (<>
          <ul className="space-y-1 text-sm">{q.items.map((i) => <li key={i.id} className="flex justify-between gap-3"><span>{i.quantity} × {i.name}{i.variantName ? ` (${i.variantName})` : ''}</span><span>{formatMoney(i.lineTotalMinor)}</span></li>)}</ul>
          <dl className="space-y-1.5 border-t border-border pt-3 text-sm">
            <div className="flex justify-between"><dt>Subtotal</dt><dd>{formatMoney(q.totals.subtotalMinor)}</dd></div>
            <div className="flex justify-between"><dt>Delivery</dt><dd>{formatMoney(q.totals.deliveryFeeMinor)}</dd></div>
            <div className="flex justify-between"><dt>Service fee</dt><dd>{formatMoney(q.totals.serviceFeeMinor)}</dd></div>
            {q.totals.taxMinor > 0 && <div className="flex justify-between"><dt>Tax</dt><dd>{formatMoney(q.totals.taxMinor)}</dd></div>}
            {q.totals.discountMinor > 0 && <div className="flex justify-between font-semibold text-success"><dt>Discount{q.coupon ? ` (${q.coupon.code})` : ''}</dt><dd>−{formatMoney(q.totals.discountMinor)}</dd></div>}
            <div className="flex justify-between border-t border-border pt-2 text-lg font-extrabold"><dt>Total</dt><dd>{formatMoney(q.totals.totalMinor)}</dd></div>
          </dl>
          {q.delivery && <p className="text-sm text-muted-foreground">Estimated delivery {formatEta(q.delivery.estimatedMinutes)} min</p>}
          {q.issues.length > 0 && <ul role="alert" className="space-y-1 rounded-control bg-destructive-soft p-3 text-sm font-semibold text-destructive">{q.issues.map((i, k) => <li key={k}>{i.message}</li>)}</ul>}
          <Button size="lg" className="w-full" disabled={!q.canCheckout || (needsPhone && !phone.trim())} loading={place.isPending} onClick={() => place.mutate()}>Place order · {formatMoney(q.totals.totalMinor)}</Button>
          {needsPhone && !phone.trim() && <p className="text-sm text-muted-foreground">Add your mobile number to place the order.</p>}
        </>)}
      </Card></aside>
    </div>
  );
}
