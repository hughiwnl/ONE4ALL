import { NextResponse } from 'next/server';
import { sessionCookieOptions } from '@repeat/auth';
import { loginRequestSchema, type UserDto } from '@repeat/types';
import { parseBody, route } from '@/server/api';
import { getContainer } from '@/server/container';

export const POST = route(async (request) => {
  const { env, users, sessions } = getContainer();
  const input = await parseBody(request, loginRequestSchema);
  const user = await users.authenticate(input);
  const session = await sessions.create(user.id);
  const body: { user: UserDto } = {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt.toISOString(),
    },
  };
  const response = NextResponse.json(body);
  const { name, ...options } = sessionCookieOptions(env.APP_URL);
  response.cookies.set(name, session.token, options);
  return response;
});
