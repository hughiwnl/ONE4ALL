import { NotFoundError } from '@repeat/core';
import { MOCK_PLATFORM } from '@repeat/provider-mock';
import { connectMockAccountRequestSchema } from '@repeat/types';
import { json, parseBody, route } from '@/server/api';
import { getContainer } from '@/server/container';
import { requireUser } from '@/server/session';

/**
 * Development only: create a fake account for the mock provider.
 * Available solely when MOCK_PROVIDER_ENABLED=true (never in production).
 */
export const POST = route(async (request) => {
  const user = await requireUser(request);
  const { services } = getContainer();
  if (!services.providers.has(MOCK_PLATFORM)) throw new NotFoundError('Mock provider');
  const input = await parseBody(request, connectMockAccountRequestSchema);
  const result = await services.accounts.connect(user.id, [
    {
      platform: MOCK_PLATFORM,
      platformAccountId: `mock-${input.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      displayName: input.displayName,
      username: `@${input.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '')}`,
      avatarUrl: null,
      credentials: {
        accessToken: `mock-token-${Date.now()}`,
        refreshToken: null,
        expiresAt: null,
        scopes: ['mock'],
      },
      metadata: { behavior: input.behavior },
    },
  ]);
  return json(
    { account: result.created[0] ?? result.updated[0] },
    { status: result.created.length ? 201 : 200 },
  );
});
