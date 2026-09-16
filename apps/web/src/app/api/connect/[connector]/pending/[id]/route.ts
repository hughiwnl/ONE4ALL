import { json, route } from '@/server/api';
import { getContainer } from '@/server/container';
import { requireUser } from '@/server/session';

type Params = { connector: string; id: string };

/** Accounts discovered by a callback that still await the user's selection. */
export const GET = route<Params>(async (request, { params }) => {
  const user = await requireUser(request);
  const pending = await getContainer().oauth.getPending(user.id, params.id);
  return json(pending);
});
