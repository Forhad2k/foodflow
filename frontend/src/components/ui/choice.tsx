'use client';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as RadioPrimitive from '@radix-ui/react-radio-group';
import { Check } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/cn';

export const Checkbox = React.forwardRef<React.ElementRef<typeof CheckboxPrimitive.Root>, React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>>(({ className, ...p }, ref) => (
  <CheckboxPrimitive.Root ref={ref} className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border border-foreground/60 data-[state=checked]:bg-ink data-[state=checked]:text-ink-foreground disabled:opacity-40', className)} {...p}>
    <CheckboxPrimitive.Indicator><Check className="h-3.5 w-3.5" strokeWidth={3} /></CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = 'Checkbox';

export const RadioGroup = RadioPrimitive.Root;
export const RadioItem = React.forwardRef<React.ElementRef<typeof RadioPrimitive.Item>, React.ComponentPropsWithoutRef<typeof RadioPrimitive.Item>>(({ className, ...p }, ref) => (
  <RadioPrimitive.Item ref={ref} className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-foreground/60 data-[state=checked]:border-ink disabled:opacity-40', className)} {...p}>
    <RadioPrimitive.Indicator className="h-2.5 w-2.5 rounded-full bg-ink" />
  </RadioPrimitive.Item>
));
RadioItem.displayName = 'RadioItem';
