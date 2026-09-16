import { completeConnectionRequestSchema } from '@repeat/types';
import { json, parseBody, route } from '@/server/api';
import { getContainer } from '@/server/container';
import { requireUser } from '@/server/session';

type Params = { connector: string };

/** Store the accounts the user picked from a pending connection. */
export const POST = route<Params>(async (request) => {
  const user = await requireUser(request);
  const input = await parseBody(request, completeConnectionRequestSchema);
  const result = await getContainer().oauth.finalize(
    user.id,
    input.pendingConnectionId,
    input.selected,
  );
  return json(result, { status: 201 });
});
