import { NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '@repeat/auth';
import { route } from '@/server/api';
import { getContainer } from '@/server/container';

export const POST = route(async (request) => {
  const { env, sessions } = getContainer();
  await sessions.destroy(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  const response = NextResponse.json({ ok: true });
  const { name, maxAge: _maxAge, ...options } = sessionCookieOptions(env.APP_URL);
  response.cookies.set(name, '', { ...options, maxAge: 0 });
  return response;
});
