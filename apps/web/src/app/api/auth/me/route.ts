import type { UserDto } from '@repeat/types';
import { json, route } from '@/server/api';
import { requireUser } from '@/server/session';

export const GET = route(async (request) => {
  const user = await requireUser(request);
  const body: { user: UserDto } = {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt.toISOString(),
    },
  };
  return json(body);
});
