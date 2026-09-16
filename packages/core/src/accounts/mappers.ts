import type { SocialAccount } from '@repeat/database';
import type { ProviderAccount } from '@repeat/provider-sdk';
import type { SocialAccountDto } from '@repeat/types';
import type { TokenCipher } from '../crypto/token-cipher.js';

/** Client-facing view: never includes tokens, encrypted or otherwise. */
export function toSocialAccountDto(account: SocialAccount): SocialAccountDto {
  return {
    id: account.id,
    platform: account.platform,
    platformAccountId: account.platformAccountId,
    displayName: account.displayName,
    username: account.username,
    avatarUrl: account.avatarUrl,
    enabled: account.enabled,
    metadata: asRecord(account.metadata),
    tokenExpiresAt: account.tokenExpiresAt?.toISOString() ?? null,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

/** Server-only view with decrypted credentials, handed to providers. */
export function toProviderAccount(account: SocialAccount, cipher: TokenCipher): ProviderAccount {
  return {
    id: account.id,
    platform: account.platform,
    platformAccountId: account.platformAccountId,
    displayName: account.displayName,
    username: account.username,
    metadata: asRecord(account.metadata),
    credentials: {
      accessToken: cipher.decrypt(account.accessTokenEncrypted),
      refreshToken: account.refreshTokenEncrypted
        ? cipher.decrypt(account.refreshTokenEncrypted)
        : null,
      expiresAt: account.tokenExpiresAt,
      scopes: account.scopes,
    },
  };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
