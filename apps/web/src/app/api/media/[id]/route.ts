import { json, route } from '@/server/api';
import { getContainer } from '@/server/container';
import { requireUser } from '@/server/session';

type Params = { id: string };

export const GET = route<Params>(async (request, { params }) => {
  const user = await requireUser(request);
  const media = await getContainer().services.media.get(user.id, params.id);
  return json({ media });
});
