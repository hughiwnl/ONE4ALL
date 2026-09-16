import { z } from 'zod';
import { json, parseQuery, route } from '@/server/api';
import { getContainer } from '@/server/container';
import { requireUser } from '@/server/session';

const querySchema = z.object({ enabled: z.enum(['true', 'false']).optional() });

export const GET = route(async (request) => {
  const user = await requireUser(request);
  const query = parseQuery(request, querySchema);
  const accounts = await getContainer().services.accounts.list(user.id, {
    enabledOnly: query.enabled === 'true',
  });
  return json({ accounts });
});
