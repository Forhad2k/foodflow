'use client';
import Link from 'next/link';
import { usePageTitle } from '@/hooks/use-page-title';
import { useState } from 'react';
import { EmptyState, ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Badge, Card, Skeleton } from '@/components/ui/misc';
import { useOrders } from '@/hooks/queries';
import { useRequireRole } from '@/lib/auth';
import { formatDateTime, formatMoney, isActiveStatus, STATUS_LABEL, statusTone } from '@/lib/format';

export default function OrdersPage() {
  const { ready } = useRequireRole('CUSTOMER');
  const [page, setPage] = useState(1);
  usePageTitle('My orders');
  const q = useOrders(page);
  if (!ready || q.isPending) return <div className="mx-auto max-w-3xl space-y-3"><Skeleton className="h-10 w-1/3" />{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div>;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const { items, total, limit } = q.data;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-3xl font-extrabold">My orders</h1>
      {items.length === 0 ? <EmptyState title="No orders yet" action={<Button asChild><Link href="/">Find something to eat</Link></Button>}>When you order, you can follow it here from the kitchen to your door.</EmptyState> : (
        <ul className="space-y-3">
          {items.map((o) => (
            <li key={o.id}>
              <Link href={`/orders/${o.id}`} className="block"><Card className="flex flex-wrap items-center justify-between gap-3 p-4 hover:bg-panel/60">
                <div>
                  <p className="font-display text-lg font-bold">{o.restaurantName}</p>
                  <p className="text-sm text-muted-foreground">#{o.orderNumber} · {o.itemCount} {o.itemCount === 1 ? 'item' : 'items'} · {formatDateTime(o.placedAt)}</p>
                </div>
                <div className="text-right"><Badge tone={statusTone(o.status)}>{STATUS_LABEL[o.status] ?? o.status}</Badge><p className="mt-1 font-bold">{formatMoney(o.totalMinor)}</p></div>
              </Card></Link>
              {isActiveStatus(o.status) && <p className="sr-only">This order is in progress.</p>}
            </li>
          ))}
        </ul>
      )}
      {total > limit && <div className="flex items-center justify-between"><Button variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Newer</Button><span className="text-sm text-muted-foreground">Page {page} of {Math.ceil(total / limit)}</span><Button variant="outline" disabled={page * limit >= total} onClick={() => setPage((p) => p + 1)}>Older</Button></div>}
    </div>
  );
}
