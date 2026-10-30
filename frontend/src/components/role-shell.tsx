'use client';
import { useRouter } from 'next/navigation';
import { usePageTitle } from '@/hooks/use-page-title';
import type { ReactNode } from 'react';
import type { SessionUser } from '@/lib/api';
import { useRequireRole } from '@/lib/auth';
import { useAuth } from '@/lib/auth';
import { Logo } from './site-header';
import { Button } from './ui/button';
import { Skeleton } from './ui/misc';

/** Separate chrome for each non-customer workspace (restaurant, rider, admin). */
export function RoleShell({ role, title, children }: { role: SessionUser['role']; title: string; children: ReactNode }) {
  const { ready, user } = useRequireRole(role);
  const { logout } = useAuth();
  usePageTitle(title);
  const router = useRouter();
  return (
    <div className="min-h-screen bg-panel">
      <header className="border-b border-ink/20 bg-ink text-ink-foreground">
        <div className="container flex h-14 items-center gap-4">
          <Logo className="text-ink-foreground" />
          <span className="rounded-full bg-primary px-3 py-0.5 text-sm font-semibold text-primary-foreground">{title}</span>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden sm:inline">{user?.fullName}</span>
            <Button size="sm" variant="outline" className="border-white/40 bg-transparent text-white hover:bg-white/10" onClick={async () => { await logout(); router.push('/login'); }}>Sign out</Button>
          </div>
        </div>
      </header>
      <main className="container py-8">{ready ? children : <Skeleton className="h-40" />}</main>
    </div>
  );
}
