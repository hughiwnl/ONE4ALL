import { createPostRequestSchema, listPostsQuerySchema } from '@repeat/types';
import { json, parseBody, parseQuery, route } from '@/server/api';
import { getContainer } from '@/server/container';
import { requireUser } from '@/server/session';

export const GET = route(async (request) => {
  const user = await requireUser(request);
  const query = parseQuery(request, listPostsQuerySchema);
  const result = await getContainer().services.posts.list(user.id, query);
  return json(result);
});

/** Create a post and one publish job per selected destination. */
export const POST = route(async (request) => {
  const user = await requireUser(request);
  const input = await parseBody(request, createPostRequestSchema);
  const post = await getContainer().services.posts.create(user.id, input);
  return json({ post }, { status: 201 });
});
