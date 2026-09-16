import { safeRedirectPath } from '@repeat/auth';
import { getContainer } from '@/server/container';
import { AuthForm } from '../auth-form';

export const metadata = { title: 'Create account' };
export const dynamic = 'force-dynamic';

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const { env, users } = getContainer();
  const registrationOpen = env.ALLOW_REGISTRATION || (await users.count()) === 0;
  return (
    <AuthForm mode="register" next={safeRedirectPath(next)} registrationOpen={registrationOpen} />
  );
}
