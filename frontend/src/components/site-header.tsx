'use client';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Bell, CheckCheck, ChevronDown, MapPin, ShoppingBag, User } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useCart, useNotifications, useUnreadNotificationCount } from '@/hooks/queries';
import { useAuth } from '@/lib/auth';
import { useDeliveryLocation } from '@/lib/location';
import { useI18n } from '@/lib/i18n';
import { realtime } from '@/lib/socket';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { LocationPicker } from './location-picker';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';

export function Logo({ className }: { className?: string }) {
  return (
    <Link href="/" className={`font-display text-2xl font-extrabold tracking-tight ${className ?? ''}`}>
      Food<span className="rounded-ticket bg-primary px-1.5 text-primary-foreground">Flow</span>
    </Link>
  );
}

function NotificationsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const list = useNotifications(1);
  const router = useRouter();

  const markAllRead = async () => {
    try {
      await api.post('/notifications/read-all');
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      void qc.invalidateQueries({ queryKey: ['notifications-unread-count'] });
      toast.success('All marked as read');
    } catch {
      toast.error('Could not mark notifications as read');
    }
  };

  const markOneRead = async (id: string, data?: Record<string, unknown>) => {
    try {
      await api.post(`/notifications/${id}/read`);
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      void qc.invalidateQueries({ queryKey: ['notifications-unread-count'] });
      if (data?.orderId) {
        onOpenChange(false);
        router.push(`/orders/${data.orderId}`);
      }
    } catch {
      // ignore
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-2 border-b border-border">
          <DialogTitle>Notifications</DialogTitle>
          <Button variant="ghost" size="sm" onClick={markAllRead} className="text-xs">
            <CheckCheck className="h-3.5 w-3.5 mr-1" /> Mark all read
          </Button>
        </div>
        <DialogDescription className="sr-only">Your activity and order status notifications</DialogDescription>

        <div className="mt-3 divide-y divide-border">
          {list.isLoading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading notifications…</p>
          ) : list.data && list.data.items.length > 0 ? (
            list.data.items.map((n) => {
              const unread = !n.readAt;
              return (
                <div
                  key={n.id}
                  onClick={() => markOneRead(n.id, n.data)}
                  className={`p-3 rounded-tile transition-colors cursor-pointer hover:bg-panel/60 ${unread ? 'bg-primary/5 font-medium' : ''}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className={`text-sm ${unread ? 'font-bold text-foreground' : 'text-foreground/90'}`}>{n.title}</p>
                    {unread && <span className="h-2 w-2 rounded-full bg-primary shrink-0 mt-1" />}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{n.body}</p>
                  <p className="text-[11px] text-muted-foreground mt-1.5">{formatDateTime(n.createdAt)}</p>
                </div>
              );
            })
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">No notifications yet.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function SiteHeader() {
  const { user, status, logout } = useAuth();
  const { location } = useDeliveryLocation();
  const { lang, setLang } = useI18n();
  const cart = useCart();
  const unreadCountQuery = useUnreadNotificationCount();
  const qc = useQueryClient();
  const router = useRouter();
  const [openLoc, setOpenLoc] = useState(false);
  const [openNotifs, setOpenNotifs] = useState(false);

  const cartCount = cart.data?.items.reduce((n, i) => n + i.quantity, 0) ?? 0;
  const unreadCount = unreadCountQuery.data?.unreadCount ?? 0;

  // Realtime notification push listener
  useEffect(() => {
    if (status !== 'authenticated') return;
    const cleanup = realtime.onNotification((n) => {
      toast.info(n.title, { description: n.body });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      void qc.invalidateQueries({ queryKey: ['notifications-unread-count'] });
      void qc.invalidateQueries({ queryKey: ['order'] });
      void qc.invalidateQueries({ queryKey: ['orders'] });
    });
    return cleanup;
  }, [status, qc]);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
      <div className="container flex h-16 items-center gap-3">
        <Logo />
        <button
          type="button"
          onClick={() => setOpenLoc(true)}
          className="ml-1 flex min-w-0 items-center gap-1.5 rounded-full border border-border px-3.5 py-1.5 text-sm font-semibold hover:bg-panel"
          aria-label="Change delivery location"
        >
          <MapPin className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span className="truncate max-w-[8rem] sm:max-w-[15rem]">{location?.label ?? 'Set delivery location'}</span>
          <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
        </button>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setLang(lang === 'en' ? 'bn' : 'en')}
            className="rounded-full border border-border px-2.5 py-1 text-xs font-bold hover:bg-panel transition-colors"
            title="Switch Language"
          >
            {lang === 'en' ? 'বাংলা' : 'EN'}
          </button>

          {user?.role === 'CUSTOMER' && (
            <Button asChild variant="outline" size="sm" className="relative">
              <Link href="/cart" aria-label={`Cart, ${cartCount} items`}>
                <ShoppingBag className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">Cart</span>
                {cartCount > 0 && (
                  <span className="ml-0.5 rounded-full bg-primary px-1.5 text-xs font-bold text-primary-foreground">
                    {cartCount}
                  </span>
                )}
              </Link>
            </Button>
          )}

          {status === 'authenticated' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOpenNotifs(true)}
              className="relative p-2"
              aria-label={`Notifications, ${unreadCount} unread`}
            >
              <Bell className="h-4 w-4" aria-hidden />
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-extrabold text-primary-foreground">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </Button>
          )}

          {status === 'authenticated' && user ? (
            <Menu.Root>
              <Menu.Trigger asChild>
                <Button variant="ghost" size="sm" aria-label="Account menu">
                  <User className="h-4 w-4" aria-hidden />
                  <span className="hidden max-w-[8rem] truncate sm:inline">{user.fullName.split(' ')[0]}</span>
                </Button>
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content align="end" sideOffset={6} className="z-50 min-w-[12rem] rounded-tile border border-border bg-background p-1.5 shadow-lg">
                  {user.role === 'CUSTOMER' && (
                    <>
                      <Menu.Item asChild>
                        <Link href="/orders" className="block rounded-lg px-3 py-2 text-sm font-semibold outline-none hover:bg-panel data-[highlighted]:bg-panel">
                          My orders
                        </Link>
                      </Menu.Item>
                      <Menu.Item asChild>
                        <Link href="/profile" className="block rounded-lg px-3 py-2 text-sm font-semibold outline-none hover:bg-panel data-[highlighted]:bg-panel">
                          Profile & Addresses
                        </Link>
                      </Menu.Item>
                    </>
                  )}
                  {user.role === 'RESTAURANT_OWNER' && (
                    <Menu.Item asChild>
                      <Link href="/owner" className="block rounded-lg px-3 py-2 text-sm font-semibold outline-none hover:bg-panel data-[highlighted]:bg-panel">
                        Restaurant Console
                      </Link>
                    </Menu.Item>
                  )}
                  {user.role === 'RIDER' && (
                    <Menu.Item asChild>
                      <Link href="/rider" className="block rounded-lg px-3 py-2 text-sm font-semibold outline-none hover:bg-panel data-[highlighted]:bg-panel">
                        Rider App
                      </Link>
                    </Menu.Item>
                  )}
                  {user.role === 'ADMIN' && (
                    <Menu.Item asChild>
                      <Link href="/admin" className="block rounded-lg px-3 py-2 text-sm font-semibold outline-none hover:bg-panel data-[highlighted]:bg-panel">
                        Admin Console
                      </Link>
                    </Menu.Item>
                  )}
                  <Menu.Separator className="my-1 h-px bg-border" />
                  <Menu.Item
                    onSelect={async () => {
                      realtime.disconnect();
                      await logout();
                      router.push('/');
                    }}
                    className="cursor-pointer rounded-lg px-3 py-2 text-sm font-semibold text-destructive outline-none hover:bg-panel data-[highlighted]:bg-panel"
                  >
                    Sign out
                  </Menu.Item>
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>
          ) : status === 'anonymous' ? (
            <>
              <Button asChild variant="ghost" size="sm">
                <Link href="/login">Sign in</Link>
              </Button>
              <Button asChild size="sm">
                <Link href="/register">Join</Link>
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <Dialog open={openLoc} onOpenChange={setOpenLoc}>
        <DialogContent className="max-w-lg">
          <DialogTitle>Where should we deliver?</DialogTitle>
          <DialogDescription className="sr-only">Choose where your food is delivered.</DialogDescription>
          <div className="mt-4">
            <LocationPicker onDone={() => setOpenLoc(false)} />
          </div>
        </DialogContent>
      </Dialog>

      <NotificationsDialog open={openNotifs} onOpenChange={setOpenNotifs} />
    </header>
  );
}
