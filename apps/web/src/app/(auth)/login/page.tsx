import { safeRedirectPath } from '@repeat/auth';
import { AuthForm } from '../auth-form';

export const metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return <AuthForm mode="login" next={safeRedirectPath(next)} registrationOpen />;
}
