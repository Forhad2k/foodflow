'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { usePageTitle } from '@/hooks/use-page-title';
import { Plus, Trash2, Edit3, Star, MapPin, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, Badge, Skeleton } from '@/components/ui/misc';
import { Input, Label, Textarea } from '@/components/ui/form';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useAddresses, useProfile, useSupportTickets } from '@/hooks/queries';
import { api, ApiError } from '@/lib/api';
import { useRequireRole } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import type { Address } from '@/lib/types';
import { DHAKA_AREAS } from '@/lib/location';

function AddressDialog({
  open,
  onOpenChange,
  initialData,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialData?: Address | null;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(initialData?.label ?? 'Home');
  const [line1, setLine1] = useState(initialData?.line1 ?? '');
  const [line2, setLine2] = useState(initialData?.line2 ?? '');
  const [area, setArea] = useState(initialData?.area ?? 'Gulshan');
  const [city, setCity] = useState(initialData?.city ?? 'Dhaka');
  const [postalCode, setPostalCode] = useState(initialData?.postalCode ?? '');
  const [instructions, setInstructions] = useState(initialData?.instructions ?? '');
  const [isDefault, setIsDefault] = useState(initialData?.isDefault ?? false);
  const [lat, setLat] = useState(initialData?.lat ?? 23.7925);
  const [lng, setLng] = useState(initialData?.lng ?? 90.4078);

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        label: label.trim(),
        line1: line1.trim(),
        line2: line2.trim() || undefined,
        area: area.trim() || undefined,
        city: city.trim(),
        postalCode: postalCode.trim() || undefined,
        instructions: instructions.trim() || undefined,
        isDefault,
        lat,
        lng,
      };
      if (initialData?.id) {
        return api.patch(`/addresses/${initialData.id}`, payload);
      }
      return api.post('/addresses', payload);
    },
    onSuccess: () => {
      toast.success(initialData?.id ? 'Address updated' : 'Address saved');
      onOpenChange(false);
      onSaved();
    },
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : 'Could not save address');
    },
  });

  const onSelectArea = (areaName: string) => {
    setArea(areaName);
    const found = DHAKA_AREAS.find((a) => a.label === areaName);
    if (found) {
      setLat(found.lat);
      setLng(found.lng);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogTitle>{initialData?.id ? 'Edit address' : 'Add delivery address'}</DialogTitle>
        <DialogDescription>
          Enter the delivery address details below.
        </DialogDescription>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
          className="mt-4 space-y-4"
        >
          <div>
            <Label htmlFor="addr-label">Label (e.g. Home, Office, Apt)</Label>
            <Input id="addr-label" value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={40} className="mt-1" />
          </div>

          <div>
            <Label htmlFor="addr-area">Dhaka Area</Label>
            <select
              id="addr-area"
              value={area}
              onChange={(e) => onSelectArea(e.target.value)}
              className="mt-1 h-10 w-full rounded-control border border-border bg-background px-3 text-sm"
            >
              {DHAKA_AREAS.map((a) => (
                <option key={a.label} value={a.label}>{a.label}</option>
              ))}
            </select>
          </div>

          <div>
            <Label htmlFor="addr-line1">Street Address / House & Road</Label>
            <Input id="addr-line1" value={line1} onChange={(e) => setLine1(e.target.value)} required minLength={3} maxLength={200} placeholder="House 12, Road 4" className="mt-1" />
          </div>

          <div>
            <Label htmlFor="addr-line2">Apartment, suite, unit (optional)</Label>
            <Input id="addr-line2" value={line2} onChange={(e) => setLine2(e.target.value)} maxLength={200} placeholder="Apt 3B, 2nd floor" className="mt-1" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="addr-city">City</Label>
              <Input id="addr-city" value={city} onChange={(e) => setCity(e.target.value)} required className="mt-1" />
            </div>
            <div>
              <Label htmlFor="addr-postal">Postal Code (optional)</Label>
              <Input id="addr-postal" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} className="mt-1" />
            </div>
          </div>

          <div>
            <Label htmlFor="addr-inst">Delivery Instructions (optional)</Label>
            <Textarea id="addr-inst" value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={300} placeholder="Gate code, landmark, or instructions for the rider" className="mt-1" />
          </div>

          <label className="flex items-center gap-2 cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="h-4 w-4 rounded border-border text-primary focus:ring-ring"
            />
            <span className="text-sm font-semibold">Set as default delivery address</span>
          </label>

          <div className="flex justify-end gap-3 pt-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={save.isPending}>Save Address</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function ProfilePage() {
  const { ready } = useRequireRole('CUSTOMER');
  usePageTitle('My Profile & Addresses');
  const qc = useQueryClient();
  const profileQuery = useProfile();
  const addressesQuery = useAddresses();
  const ticketsQuery = useSupportTickets();

  const [fullName, setFullName] = useState('');
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [initialized, setInitialized] = useState(false);

  const [addressModalOpen, setAddressModalOpen] = useState(false);
  const [editingAddress, setEditingAddress] = useState<Address | null>(null);

  if (profileQuery.data && !initialized) {
    setFullName(profileQuery.data.profile.fullName ?? '');
    setMarketingConsent(profileQuery.data.profile.marketingConsent ?? false);
    setInitialized(true);
  }

  const updateProfileMutation = useMutation({
    mutationFn: () => api.patch('/users/me', { fullName: fullName.trim(), marketingConsent }),
    onSuccess: (data: any) => {
      qc.setQueryData(['profile'], data);
      toast.success('Profile updated');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update profile'),
  });

  const deleteAddressMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/addresses/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['addresses'] });
      toast.success('Address removed');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not remove address'),
  });

  const setDefaultMutation = useMutation({
    mutationFn: (id: string) => api.patch(`/addresses/${id}`, { isDefault: true }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['addresses'] });
      toast.success('Default address updated');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update default'),
  });

  if (!ready || profileQuery.isPending) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <Skeleton className="h-40" />
        <Skeleton className="h-60" />
      </div>
    );
  }

  const user = profileQuery.data;

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <h1 className="font-display text-3xl font-extrabold">Account & Addresses</h1>
        <p className="mt-1 text-muted-foreground">Manage your personal information, saved delivery addresses, and support tickets.</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Profile Card */}
        <Card className="p-6 space-y-5">
          <div>
            <h2 className="font-display text-xl font-bold">Profile Details</h2>
            <p className="text-sm text-muted-foreground">Your account credentials and contact details.</p>
          </div>

          <div className="space-y-4">
            <div>
              <Label htmlFor="prof-email">Email</Label>
              <Input id="prof-email" value={user?.email ?? ''} disabled className="mt-1 bg-muted/40 cursor-not-allowed" />
            </div>

            <div>
              <Label htmlFor="prof-phone">Phone number</Label>
              <Input id="prof-phone" value={user?.phone ?? 'Not provided'} disabled className="mt-1 bg-muted/40 cursor-not-allowed" />
              <p className="mt-1 text-xs text-muted-foreground">Used for delivery updates by the restaurant and rider.</p>
            </div>

            <div>
              <Label htmlFor="prof-name">Full name</Label>
              <Input id="prof-name" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={100} className="mt-1" />
            </div>

            <div className="pt-2">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={marketingConsent}
                  onChange={(e) => setMarketingConsent(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-border text-primary focus:ring-ring"
                />
                <span className="text-sm">
                  <span className="font-semibold text-foreground">Marketing & promotions consent</span>
                  <br />
                  <span className="text-muted-foreground">Receive special discount offers and platform promotions.</span>
                </span>
              </label>
            </div>

            <div className="pt-2">
              <Button
                onClick={() => updateProfileMutation.mutate()}
                loading={updateProfileMutation.isPending}
                disabled={!fullName.trim()}
                className="w-full sm:w-auto"
              >
                Save Changes
              </Button>
            </div>
          </div>
        </Card>

        {/* Address Book Card */}
        <Card className="p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-display text-xl font-bold">Saved Addresses</h2>
              <p className="text-sm text-muted-foreground">Up to 10 delivery locations.</p>
            </div>
            <Button
              size="sm"
              onClick={() => {
                setEditingAddress(null);
                setAddressModalOpen(true);
              }}
              disabled={(addressesQuery.data?.length ?? 0) >= 10}
            >
              <Plus className="h-4 w-4 mr-1" /> Add Address
            </Button>
          </div>

          {addressesQuery.isLoading ? (
            <Skeleton className="h-32" />
          ) : addressesQuery.data && addressesQuery.data.length > 0 ? (
            <div className="space-y-3">
              {addressesQuery.data.map((addr) => (
                <div key={addr.id} className="flex flex-col sm:flex-row items-start justify-between gap-3 rounded-tile border border-border p-3.5 hover:bg-panel/40">
                  <div className="flex items-start gap-3">
                    <MapPin className="mt-0.5 h-4 w-4 text-primary shrink-0" />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-foreground">{addr.label}</span>
                        {addr.isDefault && (
                          <Badge tone="success" className="text-xs">
                            <Star className="h-3 w-3 inline mr-1 fill-current" /> Default
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground mt-0.5">{addr.line1}{addr.line2 ? `, ${addr.line2}` : ''}</p>
                      <p className="text-xs text-muted-foreground">{[addr.area, addr.city, addr.postalCode].filter(Boolean).join(', ')}</p>
                      {addr.instructions && (
                        <p className="text-xs italic text-muted-foreground mt-1">“{addr.instructions}”</p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 self-end sm:self-center">
                    {!addr.isDefault && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDefaultMutation.mutate(addr.id)}
                        title="Set as default"
                        className="text-xs"
                      >
                        Set default
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditingAddress(addr);
                        setAddressModalOpen(true);
                      }}
                      aria-label={`Edit ${addr.label}`}
                    >
                      <Edit3 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (confirm(`Remove address "${addr.label}"?`)) {
                          deleteAddressMutation.mutate(addr.id);
                        }
                      }}
                      aria-label={`Delete ${addr.label}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-tile border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No saved addresses yet. Add your home or work address for quick checkout.
            </div>
          )}
        </Card>
      </div>

      {/* Support Tickets Section */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-display text-xl font-bold">Support & Problem Reports</h2>
            <p className="text-sm text-muted-foreground">Past disputes, missing item tickets, and inquiries.</p>
          </div>
        </div>

        {ticketsQuery.isLoading ? (
          <Skeleton className="h-24" />
        ) : ticketsQuery.data && ticketsQuery.data.length > 0 ? (
          <div className="divide-y divide-border">
            {ticketsQuery.data.map((t) => (
              <div key={t.id} className="py-3 flex items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold">{t.subject}</span>
                    <Badge tone={t.status === 'RESOLVED' || t.status === 'CLOSED' ? 'neutral' : 'accent'}>{t.status}</Badge>
                    <span className="text-xs text-muted-foreground font-mono">{t.category}</span>
                  </div>
                  {t.resolution && <p className="text-sm text-success mt-1">Resolution: {t.resolution}</p>}
                  <p className="text-xs text-muted-foreground mt-0.5">Created {formatDateTime(t.createdAt)}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">You have no active support tickets or open disputes.</p>
        )}
      </Card>

      <AddressDialog
        open={addressModalOpen}
        onOpenChange={setAddressModalOpen}
        initialData={editingAddress}
        onSaved={() => void qc.invalidateQueries({ queryKey: ['addresses'] })}
      />
    </div>
  );
}

