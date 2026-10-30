import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/cn';

const badge = cva('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold', {
  variants: { tone: { neutral: 'bg-panel text-foreground', accent: 'bg-primary-soft text-primary-deep', success: 'bg-success-soft text-success', danger: 'bg-destructive-soft text-destructive', ink: 'bg-ink text-ink-foreground' } },
  defaultVariants: { tone: 'neutral' },
});
export const Badge = ({ className, tone, ...p }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) => <span className={cn(badge({ tone }), className)} {...p} />;

export const Skeleton = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => <div aria-hidden className={cn('animate-pulse rounded-tile bg-panel', className)} {...p} />;

export const Card = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn('rounded-card border border-border bg-card', className)} {...p} />;
