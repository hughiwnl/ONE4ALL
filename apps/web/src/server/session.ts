import 'server-only';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME } from '@repeat/auth';
import { UnauthorizedError } from '@repeat/core';
import type { User } from '@repeat/database';
import { getContainer } from './container.js';

/** Current user for server components (null when anonymous). */
export async function getCurrentUser(): Promise<User | null> {
  const store = await cookies();
  return getContainer().sessions.validate(store.get(SESSION_COOKIE_NAME)?.value);
}

/** Current user for route handlers; throws 401 when anonymous. */
export async function requireUser(request: NextRequest): Promise<User> {
  const user = await getContainer().sessions.validate(
    request.cookies.get(SESSION_COOKIE_NAME)?.value,
  );
  if (!user) throw new UnauthorizedError();
  return user;
}
