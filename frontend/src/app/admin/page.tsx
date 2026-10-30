'use client';
import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  AlertTriangle,
  BadgePercent,
  Check,
  CheckCircle2,
  Clock,
  DollarSign,
  FileText,
  Filter,
  Flame,
  Globe,
  HelpCircle,
  History,
  Lock,
  MapPin,
  Megaphone,
  MessageSquare,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Shield,
  ShoppingBag,
  Sliders,
  Trash2,
  Truck,
  UserCheck,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { RoleShell } from '@/components/role-shell';
import { Button } from '@/components/ui/button';
import { Card, Badge, Skeleton } from '@/components/ui/misc';
import { Input, Label, Textarea } from '@/components/ui/form';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  useAdminAuditLogs,
  useAdminChatReports,
  useAdminCoupons,
  useAdminPayouts,
  useAdminRefunds,
  useAdminRestaurants,
  useAdminRiders,
  useAdminServiceAreas,
  useAdminSettings,
  useAdminStats,
  useAdminStuckOrders,
  useAdminTickets,
  useAdminUsers,
} from '@/hooks/queries';
import { api, ApiError } from '@/lib/api';
import { formatDateTime, formatMoney } from '@/lib/format';
import type {
  AdminRestaurantItem,
  AdminRiderItem,
  AdminUserItem,
  ChatReportItem,
  CouponItem,
  ServiceArea,
  StuckOrder,
  SupportTicket,
} from '@/lib/types';
import { DHAKA_AREAS } from '@/lib/location';

// ─────────────────────────────────────────────────────────────
// Admin Console Main Component
// ─────────────────────────────────────────────────────────────
export default function AdminPage() {
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<
    'dashboard' | 'restaurants' | 'riders' | 'users' | 'refunds' | 'support' | 'settings' | 'audit'
  >('dashboard');

  // Queries
  const statsQuery = useAdminStats();
  const stuckQuery = useAdminStuckOrders();
  const [restStatus, setRestStatus] = useState<string | undefined>(undefined);
  const [restSearch, setRestSearch] = useState('');
  const restaurantsQuery = useAdminRestaurants(restStatus, restSearch || undefined);
  const restaurants = restaurantsQuery.data?.items ?? [];

  const [riderStatus, setRiderStatus] = useState<string | undefined>(undefined);
  const ridersQuery = useAdminRiders(riderStatus);
  const riders = ridersQuery.data?.items ?? [];

  const [userRole, setUserRole] = useState<string | undefined>(undefined);
  const [userSearch, setUserSearch] = useState('');
  const usersQuery = useAdminUsers(userRole, undefined, userSearch || undefined);
  const users = usersQuery.data?.items ?? [];

  const refundsQuery = useAdminRefunds();
  const payoutsQuery = useAdminPayouts();
  const ticketsQuery = useAdminTickets();
  const chatReportsQuery = useAdminChatReports();
  const settingsQuery = useAdminSettings();
  const serviceAreasQuery = useAdminServiceAreas();
  const couponsQuery = useAdminCoupons();
  const auditLogsQuery = useAdminAuditLogs();

  const openRiderDocument = async (riderId: string, documentId: string) => {
    const previewWindow = window.open('about:blank', '_blank');
    if (!previewWindow) {
      toast.error('Allow pop-ups to preview verification documents.');
      return;
    }
    try {
      const { url } = await api.get<{ url: string }>(`/admin/riders/${riderId}/documents/${documentId}/url`);
      previewWindow.location.href = url;
      previewWindow.opener = null;
    } catch (error) {
      previewWindow.close();
      toast.error(error instanceof ApiError ? error.message : 'Could not open verification document.');
    }
  };

  // Modals & Action States
  const [actionReason, setActionReason] = useState('');
  const [targetId, setTargetId] = useState<string | null>(null);
  const [modalType, setModalType] = useState<string | null>(null);

  // Broadcast modal state
  const [broadcastTitle, setBroadcastTitle] = useState('');
  const [broadcastBody, setBroadcastBody] = useState('');

  // Manual assign rider modal
  const [assignOrderId, setAssignOrderId] = useState<string | null>(null);
  const [assignRiderId, setAssignRiderId] = useState('');

  // Commission modal
  const [commissionBps, setCommissionBps] = useState('1500');

  // Service Area modal
  const [areaName, setAreaName] = useState('');

  // Ticket reply state
  const [replyTicketId, setReplyTicketId] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [isInternalNote, setIsInternalNote] = useState(false);

  // ── Generic Action Mutations ──
  const restaurantActionMutation = useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: string; reason?: string }) =>
      api.post(`/admin/restaurants/${id}/${action}`, reason ? { reason } : {}),
    onSuccess: () => {
      toast.success('Restaurant updated');
      void qc.invalidateQueries({ queryKey: ['admin-restaurants'] });
      setModalType(null);
      setTargetId(null);
      setActionReason('');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Action failed'),
  });

  const setCommissionMutation = useMutation({
    mutationFn: ({ id, bps }: { id: string; bps: number }) =>
      api.patch(`/admin/restaurants/${id}/commission`, { commissionBps: bps }),
    onSuccess: () => {
      toast.success('Commission updated');
      void qc.invalidateQueries({ queryKey: ['admin-restaurants'] });
      setModalType(null);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not set commission'),
  });

  const riderActionMutation = useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: string; reason?: string }) =>
      api.post(`/admin/riders/${id}/${action}`, reason ? { reason } : {}),
    onSuccess: () => {
      toast.success('Rider updated');
      void qc.invalidateQueries({ queryKey: ['admin-riders'] });
      setModalType(null);
      setTargetId(null);
      setActionReason('');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Action failed'),
  });

  const reviewDocMutation = useMutation({
    mutationFn: ({ riderId, docId, approve, reason }: { riderId: string; docId: string; approve: boolean; reason?: string }) =>
      api.post(`/admin/riders/${riderId}/documents/${docId}/review`, { approve, reason }),
    onSuccess: () => {
      toast.success('Document review recorded');
      void qc.invalidateQueries({ queryKey: ['admin-riders'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not review document'),
  });

  const redispatchMutation = useMutation({
    mutationFn: (orderId: string) => api.post(`/admin/dispatch/orders/${orderId}/redispatch`),
    onSuccess: () => {
      toast.success('Order redispatched for rider matching');
      void qc.invalidateQueries({ queryKey: ['admin-stuck-orders'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not redispatch order'),
  });

  const assignRiderMutation = useMutation({
    mutationFn: ({ orderId, riderId }: { orderId: string; riderId: string }) =>
      api.post(`/admin/dispatch/orders/${orderId}/assign`, { riderId, replace: true }),
    onSuccess: () => {
      toast.success('Rider assigned to order');
      setAssignOrderId(null);
      setAssignRiderId('');
      void qc.invalidateQueries({ queryKey: ['admin-stuck-orders'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not assign rider'),
  });

  const setUserStatusMutation = useMutation({
    mutationFn: ({ userId, status, reason }: { userId: string; status: 'ACTIVE' | 'SUSPENDED'; reason?: string }) =>
      api.post(`/admin/users/${userId}/status`, { status, reason }),
    onSuccess: () => {
      toast.success('User status updated');
      void qc.invalidateQueries({ queryKey: ['admin-users'] });
      setModalType(null);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update user status'),
  });

  const reviewRefundMutation = useMutation({
    mutationFn: ({ id, approve, note, amountMinor }: { id: string; approve: boolean; note?: string; amountMinor?: number }) =>
      api.post(`/admin/refunds/${id}/review`, { approve, note, amountMinor }),
    onSuccess: () => {
      toast.success('Refund review recorded');
      void qc.invalidateQueries({ queryKey: ['admin-refunds'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not review refund'),
  });

  const replyTicketMutation = useMutation({
    mutationFn: ({ id, body, isInternal }: { id: string; body: string; isInternal: boolean }) =>
      api.post(`/admin/support/tickets/${id}/messages`, { body, isInternal }),
    onSuccess: () => {
      toast.success('Reply submitted');
      void qc.invalidateQueries({ queryKey: ['admin-tickets'] });
      setReplyTicketId(null);
      setReplyBody('');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not reply to ticket'),
  });

  const resolveTicketMutation = useMutation({
    mutationFn: ({ id, resolution }: { id: string; resolution: string }) =>
      api.post(`/admin/support/tickets/${id}/status`, { status: 'RESOLVED', resolution }),
    onSuccess: () => {
      toast.success('Ticket marked resolved');
      void qc.invalidateQueries({ queryKey: ['admin-tickets'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not resolve ticket'),
  });

  const reviewChatReportMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'REVIEWED' | 'DISMISSED' }) =>
      api.post(`/admin/chat-reports/${id}/review`, { status }),
    onSuccess: () => {
      toast.success('Report updated');
      void qc.invalidateQueries({ queryKey: ['admin-chat-reports'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not review report'),
  });

  const broadcastMutation = useMutation({
    mutationFn: () =>
      api.post('/admin/promotions/broadcast', {
        title: broadcastTitle.trim(),
        body: broadcastBody.trim(),
      }),
    onSuccess: (res: any) => {
      toast.success(`Promotion broadcasted to ${res?.notifiedCount ?? 'opted-in'} customers!`);
      setModalType(null);
      setBroadcastTitle('');
      setBroadcastBody('');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Broadcast failed'),
  });

  const stats = statsQuery.data;

  return (
    <RoleShell role="ADMIN" title="Admin Platform Console">
      <div className="space-y-6">
        {/* Navigation Tabs */}
        <div className="flex overflow-x-auto border-b border-border gap-2 pb-1" role="tablist">
          {[
            { id: 'dashboard', label: 'Overview & Dispatch', icon: Sliders },
            { id: 'restaurants', label: 'Restaurants', icon: ShoppingBag },
            { id: 'riders', label: 'Riders & Verification', icon: Truck },
            { id: 'users', label: 'Users', icon: Users },
            { id: 'refunds', label: 'Refunds & Finance', icon: DollarSign },
            { id: 'support', label: 'Support & Moderation', icon: HelpCircle },
            { id: 'settings', label: 'Settings & Broadcast', icon: Settings },
            { id: 'audit', label: 'Audit Trail', icon: History },
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

        {/* 1. Dashboard & Dispatch Center */}
        {activeTab === 'dashboard' && (
          <div className="space-y-6">
            <h2 className="font-display text-xl font-bold">Platform Operations Snapshot</h2>

            {/* Metric Tiles */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Card className="p-4 space-y-1">
                <p className="text-xs font-bold text-muted-foreground uppercase">Active Orders</p>
                <p className="font-display text-3xl font-extrabold text-foreground">{stats?.activeOrders ?? 0}</p>
              </Card>
              <Card className="p-4 space-y-1">
                <p className="text-xs font-bold text-muted-foreground uppercase">Online Riders</p>
                <p className="font-display text-3xl font-extrabold text-success">{stats?.onlineRiders ?? 0}</p>
              </Card>
              <Card className="p-4 space-y-1">
                <p className="text-xs font-bold text-muted-foreground uppercase">Gross Merchandise Value</p>
                <p className="font-display text-3xl font-extrabold text-primary-deep">{formatMoney(stats?.gmvMinor ?? 0)}</p>
              </Card>
              <Card className="p-4 space-y-1">
                <p className="text-xs font-bold text-muted-foreground uppercase">Pending Approvals</p>
                <p className="font-display text-3xl font-extrabold text-destructive">
                  {(stats?.pendingRestaurants ?? 0) + (stats?.pendingRiders ?? 0)}
                </p>
              </Card>
            </div>

            {/* Stuck Orders Dispatch Center */}
            <Card className="p-6 space-y-4 border-2 border-warning/40">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Flame className="h-5 w-5 text-warning" />
                  <h3 className="font-display text-xl font-bold">Dispatch Center: Stuck Orders</h3>
                </div>
                <Badge tone={stuckQuery.data && stuckQuery.data.length > 0 ? 'danger' : 'success'}>
                  {stuckQuery.data?.length ?? 0} need attention
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                Orders cooking or ready in the kitchen with no rider accepted after 5 minutes.
              </p>

              {stuckQuery.isLoading ? (
                <Skeleton className="h-24" />
              ) : stuckQuery.data && stuckQuery.data.length > 0 ? (
                <div className="divide-y divide-border">
                  {stuckQuery.data.map((order: StuckOrder) => (
                    <div key={order.id} className="py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-base">#{order.orderNumber}</span>
                          <Badge tone="accent">{order.status}</Badge>
                          <span className="text-xs font-bold text-destructive font-mono">
                            Waiting {order.minutesWaiting}m · {order.offersAttempted} offers tried
                          </span>
                        </div>
                        <p className="text-sm text-muted-foreground mt-0.5">
                          {order.restaurantName} ({order.restaurantAddress}) → Dropoff: {order.customerArea}
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => redispatchMutation.mutate(order.id)}
                          loading={redispatchMutation.isPending}
                          className="text-xs"
                        >
                          Fresh Redispatch Round
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => setAssignOrderId(order.id)}
                          className="text-xs"
                        >
                          Manually Assign Rider
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground py-2 text-center bg-panel rounded-tile">
                  All active kitchen orders are matched and moving smoothly. No stuck orders.
                </p>
              )}
            </Card>
          </div>
        )}

        {/* 2. Restaurant Approvals */}
        {activeTab === 'restaurants' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-2 border-b border-border">
              <h2 className="font-display text-xl font-bold">Restaurant Approvals & Management</h2>
              <div className="flex items-center gap-2">
                <select
                  value={restStatus ?? ''}
                  onChange={(e) => setRestStatus(e.target.value || undefined)}
                  className="h-9 rounded-control border border-border bg-background px-3 text-xs"
                >
                  <option value="">All Statuses</option>
                  <option value="PENDING">Pending</option>
                  <option value="APPROVED">Approved</option>
                  <option value="REJECTED">Rejected</option>
                  <option value="SUSPENDED">Suspended</option>
                </select>
                <Input
                  value={restSearch}
                  onChange={(e) => setRestSearch(e.target.value)}
                  placeholder="Search restaurant or city…"
                  className="h-9 w-48 text-xs"
                />
              </div>
            </div>

            {restaurantsQuery.isLoading ? (
              <Skeleton className="h-48" />
            ) : restaurantsQuery.isError ? (
              <p role="alert" className="text-sm text-destructive text-center py-8">
                {restaurantsQuery.error instanceof ApiError ? restaurantsQuery.error.message : 'Could not load restaurants. Please try again.'}
              </p>
            ) : restaurants.length > 0 ? (
              <div className="divide-y divide-border border border-border rounded-card bg-card overflow-hidden">
                {restaurants.map((r: AdminRestaurantItem) => (
                  <div key={r.id} className="p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 hover:bg-panel/40">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-base">{r.name}</span>
                        <Badge tone={r.approvalStatus === 'APPROVED' ? 'success' : r.approvalStatus === 'REJECTED' ? 'danger' : 'accent'}>
                          {r.approvalStatus}
                        </Badge>
                        <span className="text-xs text-muted-foreground">Commission: {r.commissionBps ? `${r.commissionBps / 100}%` : 'Default (15%)'}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">{r.addressLine}, {r.city} · Phone: {r.phone}</p>
                      <p className="text-xs text-muted-foreground">
                        Owner: {r.owner.fullName} ({r.owner.email}) · Readiness: {r.readiness.ready ? <span className="text-success font-semibold">100% Ready</span> : <span className="text-destructive font-semibold">Missing: {r.readiness.missing.join(', ')}</span>}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      {r.approvalStatus === 'PENDING' && (
                        <>
                          <Button
                            size="sm"
                            disabled={!r.readiness.ready}
                            onClick={() => restaurantActionMutation.mutate({ id: r.id, action: 'approve' })}
                            className="text-xs h-8"
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => {
                              setTargetId(r.id);
                              setModalType('reject-rest');
                            }}
                            className="text-xs h-8"
                          >
                            Reject
                          </Button>
                        </>
                      )}

                      {r.approvalStatus === 'APPROVED' && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setTargetId(r.id);
                            setModalType('suspend-rest');
                          }}
                          className="text-xs h-8 text-destructive"
                        >
                          Suspend
                        </Button>
                      )}

                      {r.approvalStatus === 'SUSPENDED' && (
                        <Button
                          size="sm"
                          onClick={() => restaurantActionMutation.mutate({ id: r.id, action: 'reinstate' })}
                          className="text-xs h-8"
                        >
                          Reinstate
                        </Button>
                      )}

                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setTargetId(r.id);
                          setCommissionBps((r.commissionBps ?? 1500).toString());
                          setModalType('commission-rest');
                        }}
                        className="text-xs h-8"
                      >
                        Set Commission
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">No restaurants matching filters.</p>
            )}
          </div>
        )}

        {/* 3. Rider Approvals & Verification */}
        {activeTab === 'riders' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-border">
              <h2 className="font-display text-xl font-bold">Rider Approvals & Document Review</h2>
              <select
                value={riderStatus ?? ''}
                onChange={(e) => setRiderStatus(e.target.value || undefined)}
                className="h-9 rounded-control border border-border bg-background px-3 text-xs"
              >
                <option value="">All Statuses</option>
                <option value="PENDING">Pending</option>
                <option value="APPROVED">Approved</option>
                <option value="SUSPENDED">Suspended</option>
              </select>
            </div>

            {ridersQuery.isLoading ? (
              <Skeleton className="h-48" />
            ) : riders.length > 0 ? (
              <div className="grid gap-4 md:grid-cols-2">
                {riders.map((rd: AdminRiderItem) => (
                  <Card key={rd.id} className="p-5 space-y-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-base">{rd.fullName}</span>
                          <Badge tone={rd.approvalStatus === 'APPROVED' ? 'success' : 'accent'}>
                            {rd.approvalStatus}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">{rd.email} · Phone: {rd.phone ?? 'N/A'}</p>
                        <p className="text-xs text-muted-foreground">Vehicle: <b>{rd.vehicleType ?? 'Not set'}</b> · Online: {rd.isOnline ? 'Yes' : 'No'}</p>
                      </div>
                    </div>

                    {/* Documents List */}
                    <div className="rounded-tile bg-panel p-3 text-xs space-y-2">
                      <p className="font-bold uppercase tracking-wider text-muted-foreground text-[10px]">Verification Documents</p>
                      {rd.documents?.length ? (
                        rd.documents.map((doc) => (
                          <div key={doc.id} className="flex items-center justify-between gap-2">
                            <span>{doc.type} <Badge tone={doc.status === 'APPROVED' ? 'success' : doc.status === 'REJECTED' ? 'danger' : 'accent'}>{doc.status}</Badge></span>
                            <div className="flex gap-1">
                              <Button size="sm" variant="outline" onClick={() => void openRiderDocument(rd.id, doc.id)} className="h-6 text-[10px] px-2">
                                View
                              </Button>
                              {doc.status === 'PENDING' && (
                                <>
                                <Button
                                  size="sm"
                                  onClick={() => reviewDocMutation.mutate({ riderId: rd.id, docId: doc.id, approve: true })}
                                  className="h-6 text-[10px] px-2"
                                >
                                  Approve
                                </Button>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  onClick={() => reviewDocMutation.mutate({ riderId: rd.id, docId: doc.id, approve: false, reason: 'Unclear image' })}
                                  className="h-6 text-[10px] px-2"
                                >
                                  Reject
                                </Button>
                                </>
                              )}
                            </div>
                          </div>
                        ))
                      ) : (
                        <p className="italic text-muted-foreground">No documents uploaded yet.</p>
                      )}
                    </div>

                    <div className="pt-2 border-t border-border flex gap-2">
                      {rd.approvalStatus === 'PENDING' && (
                        <Button
                          size="sm"
                          onClick={() => riderActionMutation.mutate({ id: rd.id, action: 'approve' })}
                          className="text-xs"
                        >
                          Approve Rider
                        </Button>
                      )}
                      {rd.approvalStatus === 'APPROVED' && (
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => riderActionMutation.mutate({ id: rd.id, action: 'suspend', reason: 'Conduct issue' })}
                          className="text-xs"
                        >
                          Suspend
                        </Button>
                      )}
                      {rd.approvalStatus === 'SUSPENDED' && (
                        <Button
                          size="sm"
                          onClick={() => riderActionMutation.mutate({ id: rd.id, action: 'reinstate' })}
                          className="text-xs"
                        >
                          Reinstate
                        </Button>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">No riders found.</p>
            )}
          </div>
        )}

        {/* 4. Users Management */}
        {activeTab === 'users' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-2 border-b border-border">
              <h2 className="font-display text-xl font-bold">Platform User Directory</h2>
              <div className="flex items-center gap-2">
                <select
                  value={userRole ?? ''}
                  onChange={(e) => setUserRole(e.target.value || undefined)}
                  className="h-9 rounded-control border border-border bg-background px-3 text-xs"
                >
                  <option value="">All Roles</option>
                  <option value="CUSTOMER">Customer</option>
                  <option value="RESTAURANT_OWNER">Restaurant Owner</option>
                  <option value="RIDER">Rider</option>
                </select>
                <Input
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  placeholder="Search user email or name…"
                  className="h-9 w-48 text-xs"
                />
              </div>
            </div>

            {usersQuery.isLoading ? (
              <Skeleton className="h-48" />
            ) : usersQuery.isError ? (
              <p role="alert" className="text-sm text-destructive text-center py-8">
                {usersQuery.error instanceof ApiError ? usersQuery.error.message : 'Could not load users. Please try again.'}
              </p>
            ) : users.length > 0 ? (
              <div className="divide-y divide-border border border-border rounded-card bg-card overflow-hidden">
                {users.map((u: AdminUserItem) => (
                  <div key={u.id} className="p-4 flex items-center justify-between gap-3 text-sm">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold">{u.profile?.fullName || 'User'}</span>
                        <Badge tone={u.status === 'ACTIVE' ? 'success' : 'danger'}>{u.status}</Badge>
                        <span className="text-xs text-muted-foreground font-mono">{u.role}</span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{u.email} · Phone: {u.phone ?? 'N/A'}</p>
                    </div>

                    {u.role !== 'ADMIN' && (
                      <Button
                        size="sm"
                        variant={u.status === 'ACTIVE' ? 'destructive' : 'default'}
                        onClick={() =>
                          setUserStatusMutation.mutate({
                            userId: u.id,
                            status: u.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE',
                            reason: u.status === 'ACTIVE' ? 'Admin suspension' : undefined,
                          })
                        }
                        className="text-xs"
                      >
                        {u.status === 'ACTIVE' ? 'Suspend User' : 'Activate User'}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">No users found.</p>
            )}
          </div>
        )}

        {/* 5. Refunds & Finance */}
        {activeTab === 'refunds' && (
          <div className="space-y-6">
            <h2 className="font-display text-xl font-bold">Refund Requests & Payout Reconciliation</h2>

            {/* Refund Requests */}
            <Card className="p-6 space-y-4">
              <h3 className="font-bold text-base">Customer Refund Requests</h3>
              {refundsQuery.data && refundsQuery.data.length > 0 ? (
                <div className="divide-y divide-border">
                  {refundsQuery.data.map((ref: any) => (
                    <div key={ref.id} className="py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold">{formatMoney(ref.amountMinor)}</span>
                          <Badge tone={ref.status === 'APPROVED' ? 'success' : ref.status === 'REJECTED' ? 'danger' : 'accent'}>
                            {ref.status}
                          </Badge>
                          <span className="text-xs text-muted-foreground">Order #{ref.order?.orderNumber ?? ref.orderId}</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">Reason: “{ref.reason}”</p>
                      </div>

                      {ref.status === 'REQUESTED' && (
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            onClick={() => reviewRefundMutation.mutate({ id: ref.id, approve: true })}
                            className="text-xs"
                          >
                            Approve Refund
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => reviewRefundMutation.mutate({ id: ref.id, approve: false, note: 'Denied by admin' })}
                            className="text-xs"
                          >
                            Decline
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground py-2">No pending refund requests.</p>
              )}
            </Card>

            {/* Payouts */}
            <Card className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-base">Payout Runs</h3>
                <Button
                  size="sm"
                  onClick={async () => {
                    const start = prompt('Period Start (YYYY-MM-DD):', '2026-10-01');
                    const end = prompt('Period End (YYYY-MM-DD):', '2026-10-28');
                    if (start && end) {
                      await api.post('/admin/payouts/generate', {
                        periodStart: new Date(start).toISOString(),
                        periodEnd: new Date(end).toISOString(),
                      });
                      toast.success('Payout batch generated!');
                      void qc.invalidateQueries({ queryKey: ['admin-payouts'] });
                    }
                  }}
                  className="text-xs"
                >
                  <Plus className="h-3.5 w-3.5 mr-1" /> Generate Payout Batch
                </Button>
              </div>

              {payoutsQuery.data && payoutsQuery.data.length > 0 ? (
                <div className="divide-y divide-border">
                  {payoutsQuery.data.map((po: any) => (
                    <div key={po.id} className="py-2.5 flex items-center justify-between text-sm">
                      <div>
                        <span className="font-bold">{formatMoney(po.amountMinor)}</span>
                        <span className="ml-2 text-xs text-muted-foreground">Payee: {po.payeeRole} ({po.payeeId})</span>
                      </div>
                      <Badge tone={po.status === 'PAID' ? 'success' : 'accent'}>{po.status}</Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No payout batches generated yet.</p>
              )}
            </Card>
          </div>
        )}

        {/* 6. Support & Moderation */}
        {activeTab === 'support' && (
          <div className="space-y-6">
            <h2 className="font-display text-xl font-bold">Customer Support & Chat Abuse Reports</h2>

            {/* Support Tickets */}
            <Card className="p-6 space-y-4">
              <h3 className="font-bold text-base">Support Tickets Inbox</h3>
              {ticketsQuery.data && ticketsQuery.data.length > 0 ? (
                <div className="divide-y divide-border">
                  {ticketsQuery.data.map((t: SupportTicket) => (
                    <div key={t.id} className="py-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-bold">{t.subject}</span>
                          <Badge tone={t.status === 'RESOLVED' ? 'success' : 'accent'}>{t.status}</Badge>
                          <span className="text-xs font-mono text-muted-foreground">{t.category}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {t.status !== 'RESOLVED' && (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setReplyTicketId(t.id)}
                                className="text-xs h-7"
                              >
                                Reply
                              </Button>
                              <Button
                                size="sm"
                                onClick={() => resolveTicketMutation.mutate({ id: t.id, resolution: 'Issue investigated and resolved.' })}
                                className="text-xs h-7"
                              >
                                Resolve
                              </Button>
                            </>
                          )}
                        </div>
                      </div>

                      {t.messages && t.messages.length > 0 && (
                        <div className="rounded bg-panel p-2 text-xs space-y-1">
                          {t.messages.map((m, idx) => (
                            <p key={idx}>
                              <b className="capitalize">{m.senderRole}:</b> {m.body}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No support tickets currently open.</p>
              )}
            </Card>

            {/* Chat Reports Moderation */}
            <Card className="p-6 space-y-4">
              <h3 className="font-bold text-base">Order Chat Reports (Moderation)</h3>
              <p className="text-xs text-muted-foreground">
                Admins see only specifically reported messages from order chats to preserve privacy.
              </p>

              {chatReportsQuery.data && chatReportsQuery.data.length > 0 ? (
                <div className="divide-y divide-border">
                  {chatReportsQuery.data.map((rep: ChatReportItem) => (
                    <div key={rep.id} className="py-3 flex items-center justify-between gap-3 text-sm">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-destructive">Report: {rep.reason}</span>
                          <Badge tone={rep.status === 'OPEN' ? 'danger' : 'neutral'}>{rep.status}</Badge>
                          <span className="text-xs text-muted-foreground">Order #{rep.orderNumber}</span>
                        </div>
                        <p className="text-xs font-mono bg-panel p-1.5 rounded mt-1 border border-border">
                          “{rep.reportedMessageBody}”
                        </p>
                      </div>

                      {rep.status === 'OPEN' && (
                        <div className="flex items-center gap-1.5">
                          <Button
                            size="sm"
                            onClick={() => reviewChatReportMutation.mutate({ id: rep.id, status: 'REVIEWED' })}
                            className="text-xs"
                          >
                            Mark Reviewed
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => reviewChatReportMutation.mutate({ id: rep.id, status: 'DISMISSED' })}
                            className="text-xs"
                          >
                            Dismiss
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No abusive chat reports pending.</p>
              )}
            </Card>
          </div>
        )}

        {/* 7. Settings, Service Areas & Promotions */}
        {activeTab === 'settings' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between pb-2 border-b border-border">
              <h2 className="font-display text-xl font-bold">Platform Configuration & Marketing</h2>
              <Button size="sm" onClick={() => setModalType('broadcast')}>
                <Megaphone className="h-4 w-4 mr-1" /> Broadcast Promotion Push
              </Button>
            </div>

            {/* Service Areas */}
            <Card className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-bold text-base">Active Service Areas in Dhaka</h3>
                  <p className="text-xs text-muted-foreground">Addresses outside every active area see no restaurants.</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    const name = prompt('Service area name (e.g. Greater Dhaka Central):', 'Gulshan-Banani Metro');
                    if (name) {
                      // Standard polygon for Gulshan-Banani
                      const polygon: [number, number][] = [
                        [90.39, 23.77],
                        [90.43, 23.77],
                        [90.43, 23.82],
                        [90.39, 23.82],
                        [90.39, 23.77],
                      ];
                      await api.post('/admin/service-areas', { name, polygon });
                      toast.success('Service area added');
                      void qc.invalidateQueries({ queryKey: ['admin-service-areas'] });
                    }
                  }}
                  className="text-xs"
                >
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add Service Area
                </Button>
              </div>

              {serviceAreasQuery.data && serviceAreasQuery.data.length > 0 ? (
                <div className="divide-y divide-border">
                  {serviceAreasQuery.data.map((area: ServiceArea) => (
                    <div key={area.id} className="py-2.5 flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <MapPin className="h-4 w-4 text-primary" />
                        <span className="font-bold">{area.name}</span>
                        <Badge tone={area.isActive ? 'success' : 'neutral'}>
                          {area.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            await api.post(`/admin/service-areas/${area.id}/active`, { isActive: !area.isActive });
                            toast.success('Area status updated');
                            void qc.invalidateQueries({ queryKey: ['admin-service-areas'] });
                          }}
                          className="text-xs"
                        >
                          {area.isActive ? 'Deactivate' : 'Activate'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            if (confirm(`Delete area "${area.name}"?`)) {
                              await api.delete(`/admin/service-areas/${area.id}`);
                              toast.success('Area deleted');
                              void qc.invalidateQueries({ queryKey: ['admin-service-areas'] });
                            }
                          }}
                          className="text-xs text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No custom service areas configured (open platform).</p>
              )}
            </Card>

            {/* Platform Settings */}
            <Card className="p-6 space-y-4">
              <h3 className="font-bold text-base">System Settings</h3>
              {settingsQuery.data ? (
                <div className="divide-y divide-border text-sm">
                  {settingsQuery.data.map((s) => (
                    <div key={s.key} className="py-2.5 flex items-center justify-between gap-3">
                      <div>
                        <span className="font-mono font-semibold">{s.key}</span>
                        {s.isCustom && <Badge tone="accent" className="ml-2 text-[10px]">Custom</Badge>}
                      </div>
                      <span className="font-mono bg-panel px-2 py-0.5 rounded text-xs">
                        {JSON.stringify(s.value)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <Skeleton className="h-24" />
              )}
            </Card>
          </div>
        )}

        {/* 8. Audit Trail */}
        {activeTab === 'audit' && (
          <Card className="p-6 space-y-4">
            <h2 className="font-display text-xl font-bold">System Administrative Audit Trail</h2>
            <p className="text-sm text-muted-foreground">Immutable record of admin actions with IP, actor, and payload diffs.</p>

            {auditLogsQuery.data && auditLogsQuery.data.length > 0 ? (
              <div className="divide-y divide-border text-xs">
                {auditLogsQuery.data.map((log) => (
                  <div key={log.id} className="py-2.5 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-bold text-foreground">{log.action}</span>
                      <span className="text-muted-foreground">{formatDateTime(log.createdAt)}</span>
                    </div>
                    <p className="text-muted-foreground">
                      Actor: {log.actorEmail ?? log.actorId} · Entity: {log.entityType} ({log.entityId}) · IP: {log.ipAddress ?? '127.0.0.1'}
                    </p>
                    {log.details && (
                      <p className="font-mono text-[11px] bg-panel p-1 rounded overflow-x-auto text-foreground/85">
                        {JSON.stringify(log.details)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No audit logs recorded yet.</p>
            )}
          </Card>
        )}

        {/* Assign Rider Dialog */}
        <Dialog open={!!assignOrderId} onOpenChange={(o) => !o && setAssignOrderId(null)}>
          <DialogContent>
            <DialogTitle>Assign rider to stuck order</DialogTitle>
            <div className="mt-4 space-y-4">
              <div>
                <Label htmlFor="asg-r">Rider ID or select online rider</Label>
                <select
                  id="asg-r"
                  value={assignRiderId}
                  onChange={(e) => setAssignRiderId(e.target.value)}
                  className="mt-1 h-10 w-full rounded-control border border-border bg-background px-3 text-sm"
                >
                  <option value="">Select an approved online rider…</option>
                  {riders.filter((r) => r.isOnline).map((r) => (
                    <option key={r.id} value={r.id}>{r.fullName} ({r.vehicleType})</option>
                  ))}
                </select>
                <Input
                  placeholder="Or enter custom Rider UUID"
                  value={assignRiderId}
                  onChange={(e) => setAssignRiderId(e.target.value)}
                  className="mt-2 text-xs"
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" onClick={() => setAssignOrderId(null)}>Cancel</Button>
                <Button
                  disabled={!assignRiderId.trim()}
                  onClick={() => assignOrderId && assignRiderMutation.mutate({ orderId: assignOrderId, riderId: assignRiderId.trim() })}
                  loading={assignRiderMutation.isPending}
                >
                  Assign Rider
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Rejection / Suspension Dialog */}
        <Dialog open={!!modalType && modalType.startsWith('reject')} onOpenChange={(o) => !o && setModalType(null)}>
          <DialogContent>
            <DialogTitle>State reason for rejection</DialogTitle>
            <div className="mt-4 space-y-4">
              <div>
                <Label htmlFor="act-rsn">Reason</Label>
                <Input
                  id="act-rsn"
                  value={actionReason}
                  onChange={(e) => setActionReason(e.target.value)}
                  placeholder="e.g. Incomplete restaurant paperwork / failed health check"
                  required
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" onClick={() => setModalType(null)}>Cancel</Button>
                <Button
                  variant="destructive"
                  disabled={!actionReason.trim()}
                  onClick={() => targetId && restaurantActionMutation.mutate({ id: targetId, action: 'reject', reason: actionReason.trim() })}
                  loading={restaurantActionMutation.isPending}
                >
                  Confirm Rejection
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Commission Dialog */}
        <Dialog open={modalType === 'commission-rest'} onOpenChange={(o) => !o && setModalType(null)}>
          <DialogContent>
            <DialogTitle>Set restaurant commission</DialogTitle>
            <div className="mt-4 space-y-4">
              <div>
                <Label htmlFor="comm-bps">Commission in Basis Points (1500 = 15%, max 5000 = 50%)</Label>
                <Input
                  id="comm-bps"
                  type="number"
                  min="0"
                  max="5000"
                  value={commissionBps}
                  onChange={(e) => setCommissionBps(e.target.value)}
                  className="mt-1"
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" onClick={() => setModalType(null)}>Cancel</Button>
                <Button
                  onClick={() => targetId && setCommissionMutation.mutate({ id: targetId, bps: parseInt(commissionBps, 10) })}
                  loading={setCommissionMutation.isPending}
                >
                  Save Commission
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Promotional Broadcast Dialog */}
        <Dialog open={modalType === 'broadcast'} onOpenChange={(o) => !o && setModalType(null)}>
          <DialogContent>
            <DialogTitle>Broadcast marketing promotion</DialogTitle>
            <DialogDescription>
              Pushes a live notification to all customers who opted in to marketing messages.
            </DialogDescription>
            <div className="mt-4 space-y-4">
              <div>
                <Label htmlFor="bc-title">Notification Title</Label>
                <Input
                  id="bc-title"
                  value={broadcastTitle}
                  onChange={(e) => setBroadcastTitle(e.target.value)}
                  placeholder="e.g. Weekend Biryani Festival! 20% Off"
                  required
                />
              </div>
              <div>
                <Label htmlFor="bc-body">Message Body</Label>
                <Textarea
                  id="bc-body"
                  value={broadcastBody}
                  onChange={(e) => setBroadcastBody(e.target.value)}
                  placeholder="e.g. Use code WEEKEND20 at checkout for 20% off all orders above ৳500 today."
                  required
                  rows={3}
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" onClick={() => setModalType(null)}>Cancel</Button>
                <Button
                  disabled={!broadcastTitle.trim() || !broadcastBody.trim()}
                  onClick={() => broadcastMutation.mutate()}
                  loading={broadcastMutation.isPending}
                >
                  Send Push Broadcast
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Ticket Reply Dialog */}
        <Dialog open={!!replyTicketId} onOpenChange={(o) => !o && setReplyTicketId(null)}>
          <DialogContent>
            <DialogTitle>Reply to customer ticket</DialogTitle>
            <div className="mt-4 space-y-4">
              <div>
                <Label htmlFor="rep-txt">Reply message</Label>
                <Textarea
                  id="rep-txt"
                  value={replyBody}
                  onChange={(e) => setReplyBody(e.target.value)}
                  placeholder="Enter response to customer or internal admin note..."
                  rows={4}
                  required
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer text-xs">
                <input
                  type="checkbox"
                  checked={isInternalNote}
                  onChange={(e) => setIsInternalNote(e.target.checked)}
                  className="rounded border-border text-primary"
                />
                <span className="font-semibold">Mark as internal note (hidden from customer)</span>
              </label>
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" onClick={() => setReplyTicketId(null)}>Cancel</Button>
                <Button
                  disabled={!replyBody.trim()}
                  onClick={() => replyTicketId && replyTicketMutation.mutate({ id: replyTicketId, body: replyBody.trim(), isInternal: isInternalNote })}
                  loading={replyTicketMutation.isPending}
                >
                  Send Reply
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </RoleShell>
  );
}
