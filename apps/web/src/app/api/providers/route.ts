import { describeProviders } from '@repeat/core';
import type { ProviderInfoDto } from '@repeat/types';
import { json, route } from '@/server/api';
import { getContainer } from '@/server/container';
import { requireUser } from '@/server/session';

export interface ProvidersResponse {
  providers: ProviderInfoDto[];
  unconfigured: { platform: string; displayName: string; reason: string }[];
}

export const GET = route(async (request) => {
  await requireUser(request);
  const { providerSetup } = getContainer();
  const body: ProvidersResponse = {
    providers: describeProviders(providerSetup.providers, providerSetup.connectors),
    unconfigured: providerSetup.unconfigured,
  };
  return json(body);
});
