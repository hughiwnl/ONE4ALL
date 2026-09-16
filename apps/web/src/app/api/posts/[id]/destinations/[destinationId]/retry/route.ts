import { json, route } from '@/server/api';
import { getContainer } from '@/server/container';
import { requireUser } from '@/server/session';

type Params = { id: string; destinationId: string };

/** Re-queue one failed/canceled destination. Sibling destinations are untouched. */
export const POST = route<Params>(async (request, { params }) => {
  const user = await requireUser(request);
  const destination = await getContainer().services.posts.retryDestination(
    user.id,
    params.id,
    params.destinationId,
  );
  return json({ destination });
});
