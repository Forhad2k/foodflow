'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { usePageTitle } from '@/hooks/use-page-title';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { Suspense, useState } from 'react';
import { toast } from 'sonner';
import { AlertCircle, CreditCard, HelpCircle, MessageSquare, RefreshCw, RotateCcw, Star } from 'lucide-react';
import { EmptyState, ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, Textarea } from '@/components/ui/form';
import { Badge, Card, Skeleton } from '@/components/ui/misc';
import { OrderChat } from '@/components/order-chat';
import { useOrder } from '@/hooks/queries';
import { api, ApiError } from '@/lib/api';
import { useRequireRole } from '@/lib/auth';
import { formatDateTime, formatMoney, isActiveStatus, STATUS_LABEL } from '@/lib/format';
import type { OrderView, TicketCategory } from '@/lib/types';

const LiveTrackingMap = dynamic(
  () => import('@/components/live-tracking-map').then((m) => m.LiveTrackingMap),
  {
    ssr: false,
    loading: () => <div className="h-64 w-full rounded-card bg-panel animate-pulse flex items-center justify-center text-sm text-muted-foreground">Loading live map…</div>,
  },
);

function CancelOrder({ order }: { order: OrderView }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const needsReason = order.status === 'RESTAURANT_ACCEPTED';
  const cancel = useMutation({
    mutationFn: () => api.post<OrderView>(`/orders/${order.id}/cancel`, reason.trim() ? { reason: reason.trim() } : {}),
    onSuccess: (o) => {
      qc.setQueryData(['order', order.id], o);
      void qc.invalidateQueries({ queryKey: ['orders'] });
      toast.success('Order cancelled');
      setOpen(false);
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.code === 'FORBIDDEN_ORDER_TRANSITION' || e.code === 'INVALID_ORDER_TRANSITION')) {
        toast.error('The restaurant has already started on this order, so it can no longer be cancelled.');
        void qc.invalidateQueries({ queryKey: ['order', order.id] });
        setOpen(false);
      } else {
        toast.error(e instanceof ApiError ? e.message : 'Could not cancel. Please try again.');
      }
    },
  });
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>Cancel order</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Cancel this order?</DialogTitle>
          <DialogDescription className="mt-1 text-muted-foreground">
            You can cancel until the restaurant starts preparing it. Any online payment is refunded.
          </DialogDescription>
          <div className="mt-4 space-y-1.5">
            <Label htmlFor="why">Reason{needsReason ? '' : ' (optional)'}</Label>
            <Textarea id="why" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
          </div>
          <div className="mt-5 flex gap-3">
            <Button variant="destructive" loading={cancel.isPending} disabled={needsReason && reason.trim().length < 3} onClick={() => cancel.mutate()}>
              Yes, cancel it
            </Button>
            <Button variant="outline" onClick={() => setOpen(false)}>Keep my order</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ReviewDialog({ order, open, onOpenChange }: { order: OrderView; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [restaurantRating, setRestaurantRating] = useState(5);
  const [riderRating, setRiderRating] = useState(5);
  const [comment, setComment] = useState('');

  const submitReview = useMutation({
    mutationFn: () =>
      api.post(`/orders/${order.id}/review`, {
        restaurantRating,
        riderRating,
        comment: comment.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success('Thank you for your review!');
      void qc.invalidateQueries({ queryKey: ['order', order.id] });
      onOpenChange(false);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'ALREADY_REVIEWED') {
        toast.info('You have already reviewed this order.');
        onOpenChange(false);
      } else {
        toast.error(e instanceof ApiError ? e.message : 'Could not submit review');
      }
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Review your order</DialogTitle>
        <DialogDescription>
          Rate your food from {order.restaurant.name} and delivery.
        </DialogDescription>
        <div className="mt-4 space-y-4">
          <div>
            <Label>Food & Restaurant rating</Label>
            <div className="flex gap-2 pt-1.5">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  type="button"
                  onClick={() => setRestaurantRating(star)}
                  className="p-1 hover:scale-110 transition-transform"
                >
                  <Star className={`h-6 w-6 ${star <= restaurantRating ? 'fill-primary text-primary' : 'text-border'}`} />
                </button>
              ))}
            </div>
          </div>

          <div>
            <Label>Rider delivery rating</Label>
            <div className="flex gap-2 pt-1.5">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  type="button"
                  onClick={() => setRiderRating(star)}
                  className="p-1 hover:scale-110 transition-transform"
                >
                  <Star className={`h-6 w-6 ${star <= riderRating ? 'fill-primary text-primary' : 'text-border'}`} />
                </button>
              ))}
            </div>
          </div>

          <div>
            <Label htmlFor="rev-comment">Comments (optional)</Label>
            <Textarea
              id="rev-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="How was the taste, packaging, and delivery speed?"
              maxLength={500}
              className="mt-1"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={() => submitReview.mutate()} loading={submitReview.isPending}>
              Submit Review
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RefundDialog({ order, open, onOpenChange }: { order: OrderView; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [amountTaka, setAmountTaka] = useState((order.totals.totalMinor / 100).toString());

  const submitRefund = useMutation({
    mutationFn: () => {
      const amountMinor = Math.round(parseFloat(amountTaka) * 100);
      return api.post(`/orders/${order.id}/refund-requests`, {
        reason: reason.trim(),
        amountMinor: amountMinor > 0 ? amountMinor : undefined,
      });
    },
    onSuccess: () => {
      toast.success('Refund request submitted for admin review');
      void qc.invalidateQueries({ queryKey: ['order', order.id] });
      onOpenChange(false);
    },
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : 'Could not submit refund request');
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Request a refund</DialogTitle>
        <DialogDescription>
          Requests are reviewed within 24 hours. Online payments are refunded to the original method.
        </DialogDescription>
        <div className="mt-4 space-y-4">
          <div>
            <Label htmlFor="ref-amount">Refund amount (৳)</Label>
            <Input
              id="ref-amount"
              type="number"
              step="1"
              max={order.totals.totalMinor / 100}
              value={amountTaka}
              onChange={(e) => setAmountTaka(e.target.value)}
              className="mt-1 font-mono"
            />
            <p className="mt-1 text-xs text-muted-foreground">Up to total {formatMoney(order.totals.totalMinor)}</p>
          </div>

          <div>
            <Label htmlFor="ref-reason">Reason for refund</Label>
            <Textarea
              id="ref-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain what went wrong (e.g. food spoiled, wrong order, delivery damaged)"
              required
              minLength={5}
              maxLength={500}
              className="mt-1"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => submitRefund.mutate()}
              loading={submitRefund.isPending}
              disabled={!reason.trim()}
            >
              Submit Refund Request
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ReportProblemDialog({ order, open, onOpenChange }: { order: OrderView; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [category, setCategory] = useState<TicketCategory>('ORDER_ISSUE');
  const [subject, setSubject] = useState(`Issue with order #${order.orderNumber}`);
  const [description, setDescription] = useState('');

  const submitTicket = useMutation({
    mutationFn: () =>
      api.post('/support/tickets', {
        category,
        subject: subject.trim(),
        description: description.trim(),
        orderId: order.id,
      }),
    onSuccess: () => {
      toast.success('Support ticket created. Our team will contact you shortly.');
      onOpenChange(false);
      setDescription('');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not create support ticket'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Report a problem</DialogTitle>
        <DialogDescription>
          Tell our support team what happened with order #{order.orderNumber}.
        </DialogDescription>
        <div className="mt-4 space-y-4">
          <div>
            <Label htmlFor="prob-cat">Problem type</Label>
            <select
              id="prob-cat"
              value={category}
              onChange={(e) => setCategory(e.target.value as TicketCategory)}
              className="mt-1 h-10 w-full rounded-control border border-border bg-background px-3 text-sm"
            >
              <option value="MISSING_ITEM">Missing item or incorrect dish</option>
              <option value="ORDER_ISSUE">Food quality or packaging issue</option>
              <option value="DELIVERY_COMPLAINT">Rider delivery complaint</option>
              <option value="PAYMENT">Payment or billing question</option>
              <option value="OTHER">Other problem</option>
            </select>
          </div>

          <div>
            <Label htmlFor="prob-desc">Description</Label>
            <Textarea
              id="prob-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Please describe which item was missing or what occurred."
              required
              minLength={5}
              maxLength={1000}
              className="mt-1"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={() => submitTicket.mutate()} loading={submitTicket.isPending} disabled={!description.trim()}>
              Send Report
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OrderContent() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const paymentReturn = searchParams.get('payment') === 'return';

  const { ready } = useRequireRole('CUSTOMER');
  const qc = useQueryClient();
  const q = useOrder(id);

  const [reviewOpen, setReviewOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [problemOpen, setProblemOpen] = useState(false);
  const [simulatingPayment, setSimulatingPayment] = useState(false);

  usePageTitle(q.data ? `Order #${q.data.orderNumber}` : 'Order');

  if (!ready || q.isPending) {
    return (
      <div className="mx-auto max-w-3xl space-y-3">
        <Skeleton className="h-32" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (q.isError) {
    return q.error instanceof ApiError && q.error.status === 404 ? (
      <EmptyState title="We couldn't find that order">It may belong to another account.</EmptyState>
    ) : (
      <ErrorState error={q.error} onRetry={() => q.refetch()} />
    );
  }

  const o = q.data;
  const active = isActiveStatus(o.status);

  // Dev payment simulator
  const handleSimulatePayment = async (outcome: 'PAID' | 'FAILED') => {
    setSimulatingPayment(true);
    try {
      // Find providerRef from payment redirectUrl or simulate directly
      const ref = o.payment?.redirectUrl ? o.payment.redirectUrl.split('/').pop() : null;
      if (ref) {
        await api.post(`/dev/payments/${ref}/simulate`, { outcome });
        toast.success(outcome === 'PAID' ? 'Simulated payment succeeded!' : 'Payment marked failed');
        await q.refetch();
        void qc.invalidateQueries({ queryKey: ['orders'] });
      } else {
        toast.error('No pending dev payment session found');
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Simulation failed');
    } finally {
      setSimulatingPayment(false);
    }
  };

  const showTrackingMap = ['READY_FOR_PICKUP', 'RIDER_ASSIGNED', 'PICKED_UP', 'ON_THE_WAY'].includes(o.status);
  const showChat = ['RIDER_ASSIGNED', 'PICKED_UP', 'ON_THE_WAY', 'DELIVERED'].includes(o.status);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Pending Payment Alert & Dev Simulator */}
      {o.status === 'PENDING_PAYMENT' && (
        <div className="rounded-card border-2 border-primary bg-primary/10 p-5 space-y-3">
          <div className="flex items-center gap-2 font-bold text-foreground">
            <CreditCard className="h-5 w-5 text-primary-deep" />
            <span>Complete your online payment</span>
          </div>
          <p className="text-sm text-foreground/85">
            Your items and coupon are reserved. As soon as the payment gateway confirms your transaction, your order is sent straight to the restaurant kitchen.
          </p>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            {o.payment?.redirectUrl && (
              <Button asChild size="sm">
                <a href={o.payment.redirectUrl} target="_blank" rel="noopener noreferrer">
                  Open Payment Gateway
                </a>
              </Button>
            )}

            {o.payment?.redirectUrl?.includes('/dev/payments/') && (
              <Button
                variant="outline"
                size="sm"
                loading={simulatingPayment}
                onClick={() => handleSimulatePayment('PAID')}
                className="bg-background"
              >
                Simulate Payment Success (Dev)
              </Button>
            )}

            <Button variant="ghost" size="sm" onClick={() => q.refetch()} className="text-xs">
              <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh status
            </Button>
          </div>
        </div>
      )}

      {/* The ticket: order number and where it is right now */}
      <div className="rounded-card bg-ink p-6 text-ink-foreground">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm text-ink-foreground/70">{o.restaurant.name}</p>
            <h1 className="font-display text-3xl font-extrabold">Order #{o.orderNumber}</h1>
          </div>
          <div className="ticket px-4 py-2 font-display text-lg font-extrabold" aria-live="polite">
            {STATUS_LABEL[o.status] ?? o.status}
          </div>
        </div>
        {active && o.estimatedDeliveryAt && (
          <p className="mt-4 text-ink-foreground/80">
            Expected by about <b className="text-ink-foreground">{formatDateTime(o.estimatedDeliveryAt)}</b>. This page updates by itself.
          </p>
        )}
        {o.cancelReason && <p className="mt-4 text-ink-foreground/80">Reason: {o.cancelReason}</p>}
      </div>

      {/* Live Rider Tracking Map */}
      {showTrackingMap && (
        <LiveTrackingMap
          orderId={o.id}
          destinationLat={o.deliveryAddress?.lat}
          destinationLng={o.deliveryAddress?.lng}
          destinationLabel={o.deliveryAddress?.line1 ?? 'Delivery address'}
          restaurantName={o.restaurant.name}
        />
      )}

      {/* Progress & Delivery Details */}
      <div className="grid gap-6 md:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-3 text-lg font-bold">Progress</h2>
          <ol className="space-y-4 border-l-2 border-border pl-5">
            {[...o.timeline].reverse().map((t, i) => (
              <li key={`${t.to}-${t.at}`} className="relative">
                <span
                  className={`absolute -left-[27px] top-1 h-3 w-3 rounded-full border-2 border-background ${
                    i === 0 ? 'bg-primary ring-2 ring-ink' : 'bg-border'
                  }`}
                  aria-hidden
                />
                <p className={i === 0 ? 'font-bold' : 'text-muted-foreground'}>{STATUS_LABEL[t.to] ?? t.to}</p>
                <p className="text-sm text-muted-foreground">
                  {formatDateTime(t.at)}
                  {t.reason ? ` · ${t.reason}` : ''}
                </p>
              </li>
            ))}
          </ol>
        </Card>

        <Card className="space-y-3 p-5">
          <h2 className="text-lg font-bold">Delivery</h2>
          {o.deliveryAddress && (
            <p>
              {o.deliveryAddress.line1}
              {o.deliveryAddress.line2 ? `, ${o.deliveryAddress.line2}` : ''}
              <br />
              <span className="text-muted-foreground">
                {[o.deliveryAddress.area, o.deliveryAddress.city].filter(Boolean).join(', ')}
              </span>
            </p>
          )}
          {o.deliveryInstructions && (
            <p className="text-sm text-muted-foreground">“{o.deliveryInstructions}”</p>
          )}
          <p className="text-sm">
            <span className="text-muted-foreground">Contact:</span> {o.contactPhone}
          </p>

          <h3 className="pt-2 font-bold">Payment</h3>
          <p className="text-sm">
            {o.paymentMethod === 'ONLINE' ? 'Paid online' : 'Cash on delivery'}{' '}
            <Badge tone={o.payments[0]?.status === 'SUCCESSFUL' ? 'success' : 'neutral'} className="ml-1">
              {(o.payments[0]?.status ?? 'PENDING').toLowerCase()}
            </Badge>
          </p>

          {/* Quick Support Actions */}
          <div className="pt-3 border-t border-border flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setProblemOpen(true)}
              className="text-xs"
            >
              <HelpCircle className="h-3.5 w-3.5 mr-1" /> Report a problem
            </Button>

            {o.status === 'DELIVERED' && (
              <>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => setReviewOpen(true)}
                  className="text-xs"
                >
                  <Star className="h-3.5 w-3.5 mr-1" /> Review order
                </Button>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRefundOpen(true)}
                  className="text-xs text-destructive hover:bg-destructive/10"
                >
                  <RotateCcw className="h-3.5 w-3.5 mr-1" /> Request refund
                </Button>
              </>
            )}
          </div>
        </Card>
      </div>

      {/* Live Order Chat */}
      {showChat && (
        <div>
          <h2 className="mb-3 text-lg font-bold flex items-center gap-2">
            <MessageSquare className="h-5 w-5 text-primary" /> Delivery Chat
          </h2>
          <OrderChat orderId={o.id} orderNumber={o.orderNumber} currentUserRole="CUSTOMER" />
        </div>
      )}

      {/* Order Item List & Receipt */}
      <Card className="p-5">
        <h2 className="mb-3 text-lg font-bold">Your order receipt</h2>
        <ul className="divide-y divide-border">
          {o.items.map((i, k) => (
            <li key={k} className="flex justify-between gap-4 py-2.5">
              <div>
                <p className="font-semibold">
                  {i.quantity} × {i.name}
                  {i.variant ? ` (${i.variant})` : ''}
                </p>
                {i.addons.length > 0 && (
                  <p className="text-sm text-muted-foreground">{i.addons.map((a) => a.name).join(', ')}</p>
                )}
                {i.notes && <p className="text-sm italic text-muted-foreground">“{i.notes}”</p>}
              </div>
              <p className="font-semibold">{formatMoney(i.lineTotalMinor)}</p>
            </li>
          ))}
        </ul>
        <dl className="mt-3 space-y-1.5 border-t border-border pt-3 text-sm">
          <div className="flex justify-between"><dt>Subtotal</dt><dd>{formatMoney(o.totals.subtotalMinor)}</dd></div>
          <div className="flex justify-between"><dt>Delivery</dt><dd>{formatMoney(o.totals.deliveryFeeMinor)}</dd></div>
          <div className="flex justify-between"><dt>Service fee</dt><dd>{formatMoney(o.totals.serviceFeeMinor)}</dd></div>
          {o.totals.taxMinor > 0 && <div className="flex justify-between"><dt>Tax</dt><dd>{formatMoney(o.totals.taxMinor)}</dd></div>}
          {o.totals.discountMinor > 0 && (
            <div className="flex justify-between font-semibold text-success">
              <dt>Discount{o.couponCode ? ` (${o.couponCode})` : ''}</dt>
              <dd>−{formatMoney(o.totals.discountMinor)}</dd>
            </div>
          )}
          <div className="flex justify-between pt-1 text-lg font-extrabold"><dt>Total</dt><dd>{formatMoney(o.totals.totalMinor)}</dd></div>
        </dl>
      </Card>

      {o.customerActions.includes('CANCELLED') && <CancelOrder order={o} />}

      <ReviewDialog order={o} open={reviewOpen} onOpenChange={setReviewOpen} />
      <RefundDialog order={o} open={refundOpen} onOpenChange={setRefundOpen} />
      <ReportProblemDialog order={o} open={problemOpen} onOpenChange={setProblemOpen} />
    </div>
  );
}

export default function OrderPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64" />}>
      <OrderContent />
    </Suspense>
  );
}
