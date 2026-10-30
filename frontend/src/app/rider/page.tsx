'use client';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bike,
  CheckCircle2,
  Clock,
  Compass,
  DollarSign,
  FileText,
  History,
  Lock,
  MapPin,
  MessageSquare,
  Navigation,
  Phone,
  Power,
  RefreshCw,
  Send,
  Upload,
  User,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { RoleShell } from '@/components/role-shell';
import { Button } from '@/components/ui/button';
import { Card, Badge, Skeleton } from '@/components/ui/misc';
import { Input, Label } from '@/components/ui/form';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { OrderChat } from '@/components/order-chat';
import {
  useRiderDeliveriesActive,
  useRiderDeliveriesHistory,
  useRiderEarnings,
  useRiderMe,
  useRiderOffers,
  useRiderPayouts,
} from '@/hooks/queries';
import { api, ApiError } from '@/lib/api';
import { realtime } from '@/lib/socket';
import { formatDateTime, formatDistance, formatMoney, STATUS_LABEL } from '@/lib/format';
import type { RiderDeliveryView, RiderOffer, RiderProfileData } from '@/lib/types';

// ─────────────────────────────────────────────────────────────
// Offer Countdown Card
// ─────────────────────────────────────────────────────────────
function OfferCard({ offer, onAccept, onReject }: { offer: RiderOffer; onAccept: (id: string) => void; onReject: (id: string) => void }) {
  const [secondsLeft, setSecondsLeft] = useState(45);

  useEffect(() => {
    const expiresAtMs = new Date(offer.expiresAt).getTime();
    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.round((expiresAtMs - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining <= 0) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
  }, [offer.expiresAt]);

  return (
    <Card className="p-5 border-2 border-primary bg-primary/5 space-y-4 shadow-md">
      <div className="flex items-center justify-between">
        <span className="font-display font-extrabold text-lg text-foreground">
          New Delivery Offer
        </span>
        <span className={`rounded-ticket px-3 py-1 font-mono font-extrabold text-sm ${secondsLeft <= 10 ? 'bg-destructive text-white animate-pulse' : 'bg-primary text-primary-foreground'}`}>
          {secondsLeft}s left
        </span>
      </div>

      <div className="space-y-1.5 text-sm">
        <p className="font-bold text-base">{offer.restaurantName}</p>
        <p className="text-muted-foreground flex items-center gap-1">
          <MapPin className="h-3.5 w-3.5 text-primary shrink-0" />
          <span>{offer.restaurantCity} → Dropoff: <b>{offer.customerArea}</b></span>
        </p>
        <div className="flex flex-wrap gap-3 pt-1 text-xs text-muted-foreground">
          <span>Pickup: ~{formatDistance(offer.pickupDistanceMeters)}</span>
          <span>Delivery: ~{formatDistance(offer.dropoffDistanceMeters)}</span>
          <span>Items: {offer.itemCount}</span>
        </div>
        {offer.cashToCollectMinor > 0 && (
          <div className="rounded-control bg-warning-soft p-2 text-xs font-bold text-warning-deep mt-2">
            Cash to collect from customer: {formatMoney(offer.cashToCollectMinor)}
          </div>
        )}
      </div>

      <div className="flex gap-3 pt-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onReject(offer.id)}
          className="flex-1"
        >
          Decline
        </Button>
        <Button
          size="sm"
          onClick={() => onAccept(offer.id)}
          disabled={secondsLeft <= 0}
          className="flex-1"
        >
          Accept Offer
        </Button>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// Active Delivery Card & GPS Streaming
// ─────────────────────────────────────────────────────────────
function ActiveDeliveryWorkflow({ delivery }: { delivery: RiderDeliveryView }) {
  const qc = useQueryClient();
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [gpsActive, setGpsActive] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [failReasonOpen, setFailReasonOpen] = useState(false);
  const [failReason, setFailReason] = useState('');

  // GPS streaming over socket during active delivery
  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setGpsError('Geolocation is not supported by your browser');
      return;
    }

    let watchId: number | null = null;
    let lastSent = 0;

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setGpsActive(true);
        setGpsError(null);

        const now = Date.now();
        // Send every ~4 seconds (interval enforced by server)
        if (now - lastSent >= 3800) {
          lastSent = now;
          realtime.sendRiderLocation({
            orderId: delivery.orderId,
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            headingDeg: pos.coords.heading ?? undefined,
            speedMps: pos.coords.speed ?? undefined,
            accuracyM: pos.coords.accuracy ?? undefined,
          });
        }
      },
      (err) => {
        setGpsActive(false);
        setGpsError(
          err.code === err.PERMISSION_DENIED
            ? 'GPS location permission denied. Customer cannot track delivery.'
            : 'GPS signal lost. Reconnecting…',
        );
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 10_000 },
    );

    return () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    };
  }, [delivery.orderId]);

  const stepMutation = useMutation({
    mutationFn: ({ step, reason }: { step: string; reason?: string }) =>
      api.post(`/rider/deliveries/${delivery.orderId}/${step}`, reason ? { reason } : {}),
    onSuccess: (_, v) => {
      toast.success(`Delivery updated: ${v.step}`);
      void qc.invalidateQueries({ queryKey: ['rider-deliveries-active'] });
      void qc.invalidateQueries({ queryKey: ['rider-earnings'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update delivery step'),
  });

  const releaseMutation = useMutation({
    mutationFn: (reason: string) =>
      api.post(`/rider/deliveries/${delivery.orderId}/release`, { reason }),
    onSuccess: () => {
      toast.success('Delivery released to redispatch');
      void qc.invalidateQueries({ queryKey: ['rider-deliveries-active'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not release delivery'),
  });

  const hasPickedUp = ['PICKED_UP', 'ON_THE_WAY', 'DELIVERED'].includes(delivery.status);

  return (
    <Card className="p-6 space-y-5 border-2 border-primary bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b border-border">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-display text-2xl font-extrabold">Active Delivery #{delivery.orderNumber}</h2>
            <Badge tone="accent">{STATUS_LABEL[delivery.status] ?? delivery.status}</Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">Assigned delivery in progress</p>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowChat(!showChat)}
          className="text-xs flex items-center gap-1.5"
        >
          <MessageSquare className="h-4 w-4" />
          {showChat ? 'Hide Chat' : 'Chat with Customer'}
        </Button>
      </div>

      {/* GPS Status Indicator */}
      <div className="flex items-center justify-between text-xs rounded-tile bg-panel p-2.5">
        <div className="flex items-center gap-2">
          <Navigation className={`h-4 w-4 ${gpsActive ? 'text-success animate-pulse' : 'text-muted-foreground'}`} />
          <span>{gpsActive ? 'Live GPS broadcasting to customer' : 'GPS standby'}</span>
        </div>
        {gpsError && <span className="text-destructive font-semibold">{gpsError}</span>}
      </div>

      {/* Cash to Collect Reminder */}
      {delivery.cashToCollectMinor > 0 && (
        <div className="rounded-tile bg-primary/20 border border-primary/40 p-4 space-y-1 text-foreground">
          <p className="text-xs uppercase font-extrabold tracking-wider text-primary-deep">Payment to Collect</p>
          <p className="font-display text-2xl font-extrabold">
            {formatMoney(delivery.cashToCollectMinor)} <span className="text-sm font-normal text-muted-foreground">(Cash on Delivery)</span>
          </p>
          <p className="text-xs text-muted-foreground">Collect exact cash from customer before handing over package.</p>
        </div>
      )}

      {/* Location Details: Restaurant vs Customer */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Step 1: Restaurant Pickup Location */}
        <div className="rounded-tile border border-border p-4 space-y-2 bg-panel/30">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">1. Pickup Restaurant</span>
            {delivery.restaurant.phone && (
              <a href={`tel:${delivery.restaurant.phone}`} className="text-xs font-semibold text-primary-deep hover:underline flex items-center gap-1">
                <Phone className="h-3 w-3" /> Call Restaurant
              </a>
            )}
          </div>
          <p className="font-bold text-base">{delivery.restaurant.name}</p>
          <p className="text-sm text-muted-foreground">{delivery.restaurant.addressLine}, {delivery.restaurant.city}</p>
        </div>

        {/* Step 2: Customer Destination (revealed after pickup) */}
        <div className="rounded-tile border border-border p-4 space-y-2 bg-panel/30">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">2. Customer Dropoff</span>
            {hasPickedUp && delivery.customer.phone && (
              <a href={`tel:${delivery.customer.phone}`} className="text-xs font-semibold text-primary-deep hover:underline flex items-center gap-1">
                <Phone className="h-3 w-3" /> Call Customer
              </a>
            )}
          </div>

          {hasPickedUp ? (
            <div>
              <p className="font-bold text-base">{delivery.customer.firstName ?? 'Customer'}</p>
              <p className="text-sm text-foreground">{delivery.customer.addressLine ?? delivery.customer.area}</p>
              {delivery.customer.instructions && (
                <p className="text-xs italic text-muted-foreground mt-1 bg-background p-2 rounded border border-border">
                  “{delivery.customer.instructions}”
                </p>
              )}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground space-y-1">
              <p className="font-semibold text-foreground">Area: {delivery.customer.area}</p>
              <p className="text-xs flex items-center gap-1 text-muted-foreground">
                <Lock className="h-3 w-3" /> Exact address and phone revealed upon pickup.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Action Buttons depending on delivery stage */}
      <div className="pt-2 border-t border-border flex flex-wrap items-center gap-3">
        {delivery.status === 'RIDER_ASSIGNED' && (
          <>
            <Button
              size="lg"
              onClick={() => stepMutation.mutate({ step: 'pickup' })}
              loading={stepMutation.isPending}
              className="flex-1"
            >
              Confirm Food Picked Up from Restaurant
            </Button>
            <Button
              variant="outline"
              size="lg"
              onClick={() => {
                const r = prompt('Reason for releasing delivery:');
                if (r) releaseMutation.mutate(r);
              }}
              className="text-xs"
            >
              Release Delivery
            </Button>
          </>
        )}

        {delivery.status === 'PICKED_UP' && (
          <Button
            size="lg"
            onClick={() => stepMutation.mutate({ step: 'on-the-way' })}
            loading={stepMutation.isPending}
            className="flex-1"
          >
            Start Journey (Mark On The Way)
          </Button>
        )}

        {delivery.status === 'ON_THE_WAY' && (
          <>
            <Button
              size="lg"
              onClick={() => stepMutation.mutate({ step: 'delivered' })}
              loading={stepMutation.isPending}
              className="flex-1 bg-success text-white hover:bg-success/90"
            >
              Confirm Delivered {delivery.cashToCollectMinor > 0 ? '& Cash Collected' : ''}
            </Button>
            <Button
              variant="destructive"
              size="lg"
              onClick={() => setFailReasonOpen(true)}
              className="text-xs"
            >
              Report Delivery Failed
            </Button>
          </>
        )}
      </div>

      {/* Embedded Chat */}
      {showChat && (
        <div className="pt-4 border-t border-border">
          <OrderChat orderId={delivery.orderId} orderNumber={delivery.orderNumber} currentUserRole="RIDER" />
        </div>
      )}

      {/* Failed Dialog */}
      <Dialog open={failReasonOpen} onOpenChange={setFailReasonOpen}>
        <DialogContent>
          <DialogTitle>Report delivery failed</DialogTitle>
          <DialogDescription>
            Only use this if customer is unreachable, address does not exist, or an emergency occurred.
          </DialogDescription>
          <div className="mt-4 space-y-3">
            <Label htmlFor="f-r">Reason for failure</Label>
            <Input
              id="f-r"
              value={failReason}
              onChange={(e) => setFailReason(e.target.value)}
              placeholder="e.g. Customer not responding to calls after 15 mins"
              required
            />
            <div className="flex justify-end gap-3 pt-2">
              <Button variant="outline" onClick={() => setFailReasonOpen(false)}>Cancel</Button>
              <Button
                variant="destructive"
                disabled={!failReason.trim()}
                onClick={() => {
                  stepMutation.mutate({ step: 'failed', reason: failReason.trim() });
                  setFailReasonOpen(false);
                }}
              >
                Confirm Failure
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// Rider Onboarding & Verification View
// ─────────────────────────────────────────────────────────────
interface RiderUploadSignature {
  cloudName: string;
  apiKey: string;
  publicId: string;
  timestamp: number;
  type: 'authenticated';
  signature: string;
  maxUploadBytes: number;
  expiresAt: number;
}

function RiderVerificationView({ rider }: { rider: RiderProfileData }) {
  const qc = useQueryClient();
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});
  const [vehicleType, setVehicleType] = useState(rider.vehicleType ?? 'BICYCLE');
  const [vehiclePlate, setVehiclePlate] = useState(rider.vehiclePlate ?? '');

  const saveVehicleMutation = useMutation({
    mutationFn: () =>
      api.put('/rider/vehicle', {
        vehicleType,
        vehiclePlate: vehicleType === 'BICYCLE' ? undefined : vehiclePlate.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success('Vehicle updated');
      void qc.invalidateQueries({ queryKey: ['rider-me'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save vehicle'),
  });

  const uploadDocMutation = useMutation({
    mutationFn: async ({ type, file }: { type: string; file: File }) => {
      const signature = await api.post<RiderUploadSignature>('/rider/documents/upload-signature');
      const form = new FormData();
      form.append('file', file);
      form.append('api_key', signature.apiKey);
      form.append('public_id', signature.publicId);
      form.append('timestamp', String(signature.timestamp));
      form.append('type', signature.type);
      form.append('overwrite', 'false');
      form.append('signature', signature.signature);

      const response = await fetch(
        `https://api.cloudinary.com/v1_1/${encodeURIComponent(signature.cloudName)}/image/upload`,
        { method: 'POST', body: form },
      );
      const result = await response.json() as { public_id?: string; error?: { message?: string } };
      if (!response.ok) {
        throw new Error(result.error?.message ?? 'Cloudinary could not upload this file.');
      }
      if (result.public_id !== signature.publicId) {
        throw new Error('Cloudinary returned an unexpected document ID.');
      }
      return api.put('/rider/documents', { type, storageKey: signature.publicId });
    },
    onSuccess: () => {
      toast.success('Document submitted for verification');
      void qc.invalidateQueries({ queryKey: ['rider-me'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not submit document'),
  });

  const resubmitMutation = useMutation({
    mutationFn: () => api.post('/rider/resubmit'),
    onSuccess: () => {
      toast.success('Application resubmitted for admin approval');
      void qc.invalidateQueries({ queryKey: ['rider-me'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not resubmit'),
  });

  const reqDocs = rider.requiredDocuments ?? ['NATIONAL_ID', 'SELFIE'];
  const submittedDocs = rider.documents ?? [];

  return (
    <div className="space-y-6">
      <Card className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-xl font-bold">Rider Application & Onboarding</h2>
            <p className="text-sm text-muted-foreground">Complete vehicle info and required documents for admin approval.</p>
          </div>
          <Badge tone={rider.approvalStatus === 'APPROVED' ? 'success' : rider.approvalStatus === 'REJECTED' ? 'danger' : 'accent'}>
            {rider.approvalStatus}
          </Badge>
        </div>

        {rider.approvalStatus === 'REJECTED' && (
          <div className="rounded-tile bg-destructive-soft border border-destructive/30 p-4 space-y-2">
            <p className="font-bold text-destructive text-sm">Application Rejected</p>
            {rider.rejectionReason && <p className="text-xs text-foreground">{rider.rejectionReason}</p>}
            <Button size="sm" onClick={() => resubmitMutation.mutate()} loading={resubmitMutation.isPending} className="mt-2">
              Resubmit Application
            </Button>
          </div>
        )}

        {/* Vehicle Selection */}
        <div className="pt-2 border-t border-border space-y-3">
          <h3 className="font-bold text-sm">1. Delivery Vehicle</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            {(['BICYCLE', 'MOTORCYCLE', 'CAR'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setVehicleType(v)}
                className={`p-3 rounded-tile border text-center transition-all ${
                  vehicleType === v ? 'border-ink bg-panel font-bold text-ink' : 'border-border text-muted-foreground'
                }`}
              >
                <Bike className="h-5 w-5 mx-auto mb-1 text-primary" />
                <span>{v}</span>
              </button>
            ))}
          </div>

          {vehicleType !== 'BICYCLE' && (
            <div className="max-w-xs pt-1">
              <Label htmlFor="v-plate">License Plate Number</Label>
              <Input
                id="v-plate"
                value={vehiclePlate}
                onChange={(e) => setVehiclePlate(e.target.value)}
                placeholder="DHAKA METRO HA-12-3456"
                className="mt-1"
              />
            </div>
          )}

          <Button size="sm" onClick={() => saveVehicleMutation.mutate()} loading={saveVehicleMutation.isPending}>
            Save Vehicle Info
          </Button>
        </div>

        {/* Document Checklist */}
        <div className="pt-4 border-t border-border space-y-3">
          <h3 className="font-bold text-sm">2. Verification Documents</h3>
          <div className="divide-y divide-border">
            {reqDocs.map((docType: string) => {
              const doc = submittedDocs.find((d) => d.type === docType);
              const isApproved = doc?.status === 'APPROVED';
              const isPending = doc?.status === 'PENDING';
              const isRejected = doc?.status === 'REJECTED';

              return (
                <div key={docType} className="py-3 flex items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm">{docType.replace('_', ' ')}</span>
                      {doc ? (
                        <Badge tone={isApproved ? 'success' : isRejected ? 'danger' : 'accent'}>
                          {doc.status}
                        </Badge>
                      ) : (
                        <Badge tone="neutral">Missing</Badge>
                      )}
                    </div>
                    {doc?.rejectionReason && (
                      <p className="text-xs text-destructive mt-0.5">Rejected: {doc.rejectionReason}</p>
                    )}
                  </div>

                  <input
                    ref={(input) => { fileInputs.current[docType] = input; }}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="sr-only"
                    aria-label={`${docType.replace('_', ' ')} image`}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = '';
                      if (!file) return;
                      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
                        toast.error('Choose a JPEG, PNG, or WebP image.');
                        return;
                      }
                      if (file.size > 10 * 1024 * 1024) {
                        toast.error('The document image must be 10 MB or smaller.');
                        return;
                      }
                      uploadDocMutation.mutate({ type: docType, file });
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => fileInputs.current[docType]?.click()}
                    loading={uploadDocMutation.isPending}
                    className="text-xs"
                  >
                    <Upload className="h-3.5 w-3.5 mr-1" />
                    {doc ? 'Replace Document' : 'Submit Document'}
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Rider Main Hub Component
// ─────────────────────────────────────────────────────────────
export default function RiderPage() {
  const qc = useQueryClient();
  const riderQuery = useRiderMe();
  const offersQuery = useRiderOffers();
  const activeDeliveriesQuery = useRiderDeliveriesActive();
  const historyQuery = useRiderDeliveriesHistory();
  const earningsQuery = useRiderEarnings();
  const payoutsQuery = useRiderPayouts();

  const [activeTab, setActiveTab] = useState<'hub' | 'history' | 'earnings'>('hub');

  // Toggle online / offline
  const toggleOnlineMutation = useMutation({
    mutationFn: async (isOnline: boolean) => {
      let lat: number | undefined;
      let lng: number | undefined;

      if (isOnline) {
        // Need current location to go online
        await new Promise<void>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(
            (p) => {
              lat = p.coords.latitude;
              lng = p.coords.longitude;
              resolve();
            },
            () => reject(new Error('Location access required to go online')),
            { timeout: 8000 },
          );
        });
      }

      return api.put('/rider/status', { isOnline, lat, lng });
    },
    onSuccess: (data: any) => {
      toast.success(data.isOnline ? 'You are now online and eligible for offers!' : 'You went offline');
      void qc.invalidateQueries({ queryKey: ['rider-me'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not change online status'),
  });

  const acceptOfferMutation = useMutation({
    mutationFn: (offerId: string) => api.post(`/rider/offers/${offerId}/accept`),
    onSuccess: () => {
      toast.success('Offer accepted! Head to the restaurant.');
      void qc.invalidateQueries({ queryKey: ['rider-offers'] });
      void qc.invalidateQueries({ queryKey: ['rider-deliveries-active'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not accept offer'),
  });

  const rejectOfferMutation = useMutation({
    mutationFn: (offerId: string) => api.post(`/rider/offers/${offerId}/reject`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rider-offers'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not reject offer'),
  });

  // Idle presence heartbeat (every 30s while online and idle)
  useEffect(() => {
    const rider = riderQuery.data;
    if (!rider?.isOnline || (activeDeliveriesQuery.data && activeDeliveriesQuery.data.length > 0)) {
      return;
    }

    const interval = setInterval(() => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          api.post('/rider/presence', {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
          }).catch(() => undefined);
        },
        () => undefined,
        { timeout: 5000 },
      );
    }, 30_000);

    return () => clearInterval(interval);
  }, [riderQuery.data?.isOnline, activeDeliveriesQuery.data]);

  const rider = riderQuery.data;
  const isApproved = rider?.approvalStatus === 'APPROVED';
  const offers = offersQuery.data ?? [];
  const activeDeliveries = activeDeliveriesQuery.data ?? [];

  return (
    <RoleShell role="RIDER" title="Rider Hub">
      <div className="space-y-6 max-w-4xl mx-auto">
        {/* Top Status & Online/Offline Bar */}
        <div className="flex flex-wrap items-center justify-between gap-4 bg-background p-4 rounded-card border border-border">
          <div className="flex items-center gap-3">
            <div className={`p-2.5 rounded-full ${rider?.isOnline ? 'bg-success text-white' : 'bg-muted text-muted-foreground'}`}>
              <Bike className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-display text-xl font-bold">Rider App</h1>
                <Badge tone={isApproved ? 'success' : rider?.approvalStatus === 'REJECTED' ? 'danger' : 'accent'}>
                  {rider?.approvalStatus ?? 'LOADING'}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                Vehicle: {rider?.vehicleType ?? 'BICYCLE'} {rider?.vehiclePlate ? `(${rider.vehiclePlate})` : ''}
              </p>
            </div>
          </div>

          {isApproved && (
            <Button
              variant={rider?.isOnline ? 'destructive' : 'default'}
              size="lg"
              loading={toggleOnlineMutation.isPending}
              onClick={() => toggleOnlineMutation.mutate(!rider?.isOnline)}
              className="px-6 font-bold flex items-center gap-2"
            >
              <Power className="h-5 w-5" />
              {rider?.isOnline ? 'Go Offline' : 'Go Online'}
            </Button>
          )}
        </div>

        {/* Verification View for Non-approved riders */}
        {!isApproved && rider && (
          <RiderVerificationView rider={rider} />
        )}

        {/* Operational Hub for Approved Riders */}
        {isApproved && (
          <div className="space-y-6">
            {/* Tabs */}
            <div className="flex overflow-x-auto border-b border-border gap-2 pb-1" role="tablist">
              {[
                { id: 'hub', label: 'Active Delivery & Offers', icon: Navigation },
                { id: 'earnings', label: 'Earnings & Payouts', icon: DollarSign },
                { id: 'history', label: 'Delivery History', icon: History },
              ].map((tab) => {
                const Icon = tab.icon;
                const active = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setActiveTab(tab.id as any)}
                    className={`flex items-center gap-2 whitespace-nowrap rounded-t-lg px-4 py-2.5 text-sm font-bold border-b-2 transition-all ${
                      active
                        ? 'border-ink bg-panel text-ink'
                        : 'border-transparent text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Hub Tab: Active Delivery & Incoming Offers */}
            {activeTab === 'hub' && (
              <div className="space-y-6">
                {/* Active Deliveries */}
                {activeDeliveries.length > 0 ? (
                  activeDeliveries.map((delivery) => (
                    <ActiveDeliveryWorkflow key={delivery.orderId} delivery={delivery} />
                  ))
                ) : (
                  rider?.isOnline ? (
                    offers.length > 0 ? (
                      <div className="space-y-3">
                        <h2 className="font-display font-bold text-lg">Incoming Offers</h2>
                        <div className="grid gap-4 md:grid-cols-2">
                          {offers.map((offer) => (
                            <OfferCard
                              key={offer.id}
                              offer={offer}
                              onAccept={(id) => acceptOfferMutation.mutate(id)}
                              onReject={(id) => rejectOfferMutation.mutate(id)}
                            />
                          ))}
                        </div>
                      </div>
                    ) : (
                      <Card className="p-8 text-center space-y-3">
                        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success/15 text-success">
                          <CheckCircle2 className="h-6 w-6" />
                        </div>
                        <h2 className="font-display font-bold text-xl">You are online and ready</h2>
                        <p className="text-sm text-muted-foreground max-w-md mx-auto">
                          Waiting for nearby restaurant deliveries. Offers will appear here with an audible chime and a 45-second acceptance window.
                        </p>
                      </Card>
                    )
                  ) : (
                    <Card className="p-8 text-center space-y-3 bg-panel/50">
                      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <Power className="h-6 w-6" />
                      </div>
                      <h2 className="font-display font-bold text-xl">You are currently offline</h2>
                      <p className="text-sm text-muted-foreground max-w-md mx-auto">
                        Press "Go Online" when you're on shift and ready to receive delivery requests in your zone.
                      </p>
                    </Card>
                  )
                )}
              </div>
            )}

            {/* Earnings Tab */}
            {activeTab === 'earnings' && (
              <div className="space-y-6">
                <h2 className="font-display text-xl font-bold">Earnings & Cash Reconciliation</h2>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Card className="p-5 space-y-1">
                    <p className="text-xs font-bold text-muted-foreground uppercase">Unpaid Earnings (80% fee)</p>
                    <p className="font-display text-2xl font-extrabold text-foreground">
                      {earningsQuery.data ? formatMoney(earningsQuery.data.unpaidEarningsMinor) : '৳0'}
                    </p>
                  </Card>
                  <Card className="p-5 space-y-1">
                    <p className="text-xs font-bold text-muted-foreground uppercase">Cash Collected to Remit</p>
                    <p className="font-display text-2xl font-extrabold text-destructive">
                      {earningsQuery.data ? formatMoney(earningsQuery.data.cashToRemitMinor) : '৳0'}
                    </p>
                  </Card>
                  <Card className="p-5 space-y-1">
                    <p className="text-xs font-bold text-muted-foreground uppercase">Net Platform Balance</p>
                    <p className="font-display text-2xl font-extrabold text-success">
                      {earningsQuery.data ? formatMoney(earningsQuery.data.netUnpaidMinor) : '৳0'}
                    </p>
                    <p className="text-[11px] text-muted-foreground">Negative means you owe cash to the platform</p>
                  </Card>
                </div>

                <Card className="p-6 space-y-4">
                  <h3 className="font-bold text-base">Past Payouts</h3>
                  {payoutsQuery.data && payoutsQuery.data.length > 0 ? (
                    <div className="divide-y divide-border">
                      {payoutsQuery.data.map((p) => (
                        <div key={p.id} className="py-2.5 flex items-center justify-between text-sm">
                          <div>
                            <span className="font-bold">{formatMoney(p.amountMinor)}</span>
                            <span className="ml-2 text-xs text-muted-foreground">{formatDateTime(p.periodStart)} – {formatDateTime(p.periodEnd)}</span>
                          </div>
                          <Badge tone={p.status === 'PAID' ? 'success' : 'neutral'}>{p.status}</Badge>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">No past payouts found.</p>
                  )}
                </Card>
              </div>
            )}

            {/* History Tab */}
            {activeTab === 'history' && (
              <Card className="p-6 space-y-4">
                <h2 className="font-display text-xl font-bold">Past Deliveries</h2>
                {historyQuery.data && historyQuery.data.length > 0 ? (
                  <div className="divide-y divide-border">
                    {historyQuery.data.map((h: any) => (
                      <div key={h.id ?? h.orderId} className="py-3 flex items-center justify-between text-sm">
                        <div>
                          <p className="font-bold">Order #{h.orderNumber}</p>
                          <p className="text-xs text-muted-foreground">{formatDateTime(h.placedAt ?? h.createdAt)}</p>
                        </div>
                        <Badge tone={h.status === 'DELIVERED' ? 'success' : 'danger'}>{h.status}</Badge>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No completed deliveries yet.</p>
                )}
              </Card>
            )}
          </div>
        )}
      </div>
    </RoleShell>
  );
}
