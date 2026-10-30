'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { usePageTitle } from '@/hooks/use-page-title';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { ApiError } from '@/lib/api';
import { homeFor, useAuth } from '@/lib/auth';

const schema = z.object({ email: z.string().trim().email('Enter a valid email address'), password: z.string().min(1, 'Enter your password') });
type Values = z.infer<typeof schema>;

/** Only same-site paths are honoured, so a crafted ?next= link cannot send people elsewhere after sign-in. */
const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') ? n : null);

function LoginForm() {
  const { login } = useAuth();
  usePageTitle('Sign in');
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Values>({ resolver: zodResolver(schema) });

  const submit = handleSubmit(async (v) => {
    setError(null);
    try {
      const user = await login(v.email, v.password);
      router.replace(next ?? homeFor(user.role));
    } catch (e) {
      setError(e instanceof ApiError ? (e.code === 'UNAUTHORIZED' ? 'Email or password is incorrect.' : e.message) : 'Something went wrong. Please try again.');
    }
  });

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <div><h1 className="text-3xl font-extrabold">Welcome back</h1><p className="mt-1 text-muted-foreground">Sign in to order, track and manage your account.</p></div>
      {error && <p role="alert" className="rounded-control bg-destructive-soft px-4 py-3 text-sm font-semibold text-destructive">{error}</p>}
      <Field id="email" label="Email" error={errors.email?.message}><Input id="email" type="email" autoComplete="email" aria-invalid={!!errors.email} {...register('email')} /></Field>
      <div>
        <div className="flex items-center justify-between">
          <label htmlFor="password" className="text-sm font-bold">Password</label>
          <Link href="/forgot-password" className="text-xs font-semibold text-muted-foreground hover:text-foreground underline underline-offset-2">Forgot password?</Link>
        </div>
        <Input id="password" type="password" autoComplete="current-password" aria-invalid={!!errors.password} {...register('password')} className="mt-1.5" />
        {errors.password?.message && <p role="alert" className="mt-1 text-sm font-semibold text-destructive">{errors.password.message}</p>}
      </div>
      <Button type="submit" size="lg" className="w-full" loading={isSubmitting}>Sign in</Button>
      <p className="text-center text-sm text-muted-foreground">New to FoodFlow? <Link href={next ? `/register?next=${encodeURIComponent(next)}` : '/register'} className="font-semibold text-foreground underline underline-offset-4">Create an account</Link></p>
    </form>
  );
}
export default function LoginPage() { return <Suspense><LoginForm /></Suspense>; }
