'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { usePageTitle } from '@/hooks/use-page-title';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { RadioGroup, RadioItem } from '@/components/ui/choice';
import { ApiError } from '@/lib/api';
import { homeFor, useAuth } from '@/lib/auth';
import { normalizePhone } from '@/lib/phone';

const schema = z.object({
  fullName: z.string().trim().min(2, 'Enter your full name'),
  email: z.string().trim().email('Enter a valid email address'),
  phone: z.string().trim().refine((v) => v === '' || normalizePhone(v) !== null, 'Use a Bangladesh mobile number like 01712345678'),
  password: z.string().min(10, 'Use at least 10 characters'),
  role: z.enum(['CUSTOMER', 'RESTAURANT_OWNER', 'RIDER']),
});
type Values = z.infer<typeof schema>;
const ROLES = [
  { value: 'CUSTOMER', title: 'I want to order food', note: 'Order from nearby restaurants and track your delivery.' },
  { value: 'RESTAURANT_OWNER', title: 'I run a restaurant', note: 'List your menu and receive orders. We review new restaurants before they go live.' },
  { value: 'RIDER', title: 'I want to deliver', note: 'Deliver orders with your bike or motorbike. We verify your documents first.' },
] as const;

function RegisterForm() {
  const { register: signUp } = useAuth();
  usePageTitle('Create your account');
  const router = useRouter();
  const next = useSearchParams().get('next');
  const [error, setError] = useState<string | null>(null);
  const { register, control, handleSubmit, formState: { errors, isSubmitting } } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { role: 'CUSTOMER', phone: '' } });

  const submit = handleSubmit(async (v) => {
    setError(null);
    try {
      const user = await signUp({ email: v.email, password: v.password, fullName: v.fullName, role: v.role, ...(v.phone ? { phone: normalizePhone(v.phone)! } : {}) });
      router.replace(user.role === 'CUSTOMER' && next?.startsWith('/') && !next.startsWith('//') ? next : homeFor(user.role));
    } catch (e) {
      setError(e instanceof ApiError ? (e.code === 'CONFLICT' ? 'An account with this email or phone already exists. Try signing in.' : e.message) : 'Something went wrong. Please try again.');
    }
  });

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <div><h1 className="text-3xl font-extrabold">Create your account</h1><p className="mt-1 text-muted-foreground">It takes a minute.</p></div>
      {error && <p role="alert" className="rounded-control bg-destructive-soft px-4 py-3 text-sm font-semibold text-destructive">{error}</p>}
      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-sm font-semibold">I am joining as</legend>
        <Controller control={control} name="role" render={({ field }) => (
          <RadioGroup value={field.value} onValueChange={field.onChange} className="space-y-2">
            {ROLES.map((r) => (
              <label key={r.value} className="flex cursor-pointer items-start gap-3 rounded-tile border border-border p-3.5 has-[[data-state=checked]]:border-ink has-[[data-state=checked]]:bg-panel">
                <RadioItem value={r.value} className="mt-1" aria-label={r.title} />
                <span><span className="block font-semibold">{r.title}</span><span className="text-sm text-muted-foreground">{r.note}</span></span>
              </label>
            ))}
          </RadioGroup>
        )} />
      </fieldset>
      <Field id="fullName" label="Full name" error={errors.fullName?.message}><Input id="fullName" autoComplete="name" aria-invalid={!!errors.fullName} {...register('fullName')} /></Field>
      <Field id="email" label="Email" error={errors.email?.message}><Input id="email" type="email" autoComplete="email" aria-invalid={!!errors.email} {...register('email')} /></Field>
      <Field id="phone" label="Mobile number (optional)" hint="Riders and restaurants use it to reach you about an order." error={errors.phone?.message}><Input id="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="01712345678" aria-invalid={!!errors.phone} {...register('phone')} /></Field>
      <Field id="password" label="Password" hint="At least 10 characters." error={errors.password?.message}><Input id="password" type="password" autoComplete="new-password" aria-invalid={!!errors.password} {...register('password')} /></Field>
      <Button type="submit" size="lg" className="w-full" loading={isSubmitting}>Create account</Button>
      <p className="text-center text-sm text-muted-foreground">Already have an account? <Link href="/login" className="font-semibold text-foreground underline underline-offset-4">Sign in</Link></p>
    </form>
  );
}
export default function RegisterPage() { return <Suspense><RegisterForm /></Suspense>; }
