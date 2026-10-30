import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { Button } from './ui/button';

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-auto max-w-md rounded-card border border-dashed border-border bg-panel/60 px-6 py-12 text-center">
      <h2 className="text-xl font-bold">{title}</h2>
      {children && <p className="mt-2 text-muted-foreground">{children}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
  return (
    <div role="alert" className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-card border border-destructive/30 bg-destructive-soft px-6 py-10 text-center">
      <AlertTriangle className="h-7 w-7 text-destructive" aria-hidden />
      <p className="font-semibold">{msg}</p>
      {onRetry && <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>}
    </div>
  );
}
