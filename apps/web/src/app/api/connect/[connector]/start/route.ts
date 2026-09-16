import { NextResponse } from 'next/server';
import { route } from '@/server/api';
import { getContainer } from '@/server/container';
import { requireUser } from '@/server/session';

type Params = { connector: string };

/** Begin an OAuth connection: creates a single-use state and redirects to the provider. */
export const GET = route<Params>(async (request, { params }) => {
  const user = await requireUser(request);
  const { url } = await getContainer().oauth.begin(user.id, params.connector);
  return NextResponse.redirect(url, { status: 302 });
});
