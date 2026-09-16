import { updateAccountRequestSchema } from '@repeat/types';
import { json, parseBody, route } from '@/server/api';
import { getContainer } from '@/server/container';
import { requireUser } from '@/server/session';

type Params = { id: string };

export const GET = route<Params>(async (request, { params }) => {
  const user = await requireUser(request);
  const account = await getContainer().services.accounts.get(user.id, params.id);
  return json({ account });
});

export const PATCH = route<Params>(async (request, { params }) => {
  const user = await requireUser(request);
  const input = await parseBody(request, updateAccountRequestSchema);
  const account = await getContainer().services.accounts.setEnabled(
    user.id,
    params.id,
    input.enabled,
  );
  return json({ account });
});

export const DELETE = route<Params>(async (request, { params }) => {
  const user = await requireUser(request);
  await getContainer().services.accounts.disconnect(user.id, params.id);
  return json({ ok: true });
});
