import { json, route } from '@/server/api';
import { getContainer } from '@/server/container';
import { requireUser } from '@/server/session';

type Params = { id: string };

/** Post with the live status of every destination (polled by the status page). */
export const GET = route<Params>(async (request, { params }) => {
  const user = await requireUser(request);
  const post = await getContainer().services.posts.get(user.id, params.id);
  return json({ post });
});
