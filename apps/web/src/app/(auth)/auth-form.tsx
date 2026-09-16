'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '@/lib/api-client';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { formString } from '@/lib/utils';

export function AuthForm({
  mode,
  next,
  registrationOpen,
}: {
  mode: 'login' | 'register';
  next: string;
  registrationOpen: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const form = new FormData(event.currentTarget);
    const email = formString(form, 'email');
    const password = formString(form, 'password');
    const name = formString(form, 'name').trim();
    try {
      if (mode === 'login') {
        await api.auth.login({ email, password });
      } else {
        await api.auth.register({ email, password, ...(name ? { name } : {}) });
      }
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <h1 className="text-lg font-semibold">
        {mode === 'login' ? 'Sign in' : 'Create your account'}
      </h1>
      {mode === 'register' && !registrationOpen ? (
        <Alert tone="warning">
          Registration is disabled on this server (ALLOW_REGISTRATION=false).
        </Alert>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {mode === 'register' ? (
        <div>
          <Label htmlFor="name">Name (optional)</Label>
          <Input id="name" name="name" autoComplete="name" maxLength={100} />
        </div>
      ) : null}
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div>
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          required
          minLength={mode === 'register' ? 10 : 1}
        />
        {mode === 'register' ? (
          <p className="mt-1 text-xs text-neutral-500">At least 10 characters.</p>
        ) : null}
      </div>
      <Button
        type="submit"
        className="w-full"
        loading={submitting}
        disabled={mode === 'register' && !registrationOpen}
      >
        {mode === 'login' ? 'Sign in' : 'Create account'}
      </Button>
      <p className="text-center text-sm text-neutral-500">
        {mode === 'login' ? (
          <>
            No account yet?{' '}
            <Link href="/register" className="text-brand-600 hover:underline">
              Create one
            </Link>
          </>
        ) : (
          <>
            Already have an account?{' '}
            <Link href="/login" className="text-brand-600 hover:underline">
              Sign in
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
