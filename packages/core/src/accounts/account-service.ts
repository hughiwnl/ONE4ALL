import type { Db, Prisma, SocialAccount } from '@repeat/database';
import type {
  ConnectableAccount,
  ProviderAccount,
  ProviderCredentials,
  ProviderRegistry,
} from '@repeat/provider-sdk';
import type { SocialAccountDto } from '@repeat/types';
import type { TokenCipher } from '../crypto/token-cipher.js';
import { NotFoundError, ValidationError } from '../errors.js';
import type { Logger } from '../logger.js';
import { toProviderAccount, toSocialAccountDto } from './mappers.js';

export interface AccountServiceOptions {
  db: Db;
  cipher: TokenCipher;
  logger: Logger;
  providers: ProviderRegistry;
}

export interface ConnectResult {
  created: SocialAccountDto[];
  updated: SocialAccountDto[];
}

/**
 * Connected social accounts.
 *
 * A user can hold any number of accounts per platform; identity is
 * (userId, platform, platformAccountId). Reconnecting an existing identity
 * refreshes its credentials instead of creating a duplicate.
 */
export class AccountService {
  constructor(private readonly options: AccountServiceOptions) {}

  async list(userId: string, filter: { enabledOnly?: boolean } = {}): Promise<SocialAccountDto[]> {
    const accounts = await this.options.db.socialAccount.findMany({
      where: { userId, ...(filter.enabledOnly ? { enabled: true } : {}) },
      orderBy: [{ platform: 'asc' }, { createdAt: 'asc' }],
    });
    return accounts.map(toSocialAccountDto);
  }

  async get(userId: string, accountId: string): Promise<SocialAccountDto> {
    return toSocialAccountDto(await this.getOwned(userId, accountId));
  }

  /** Store accounts discovered by an OAuth connector (or the mock connector). */
  async connect(userId: string, accounts: ConnectableAccount[]): Promise<ConnectResult> {
    const { db, cipher, logger, providers } = this.options;
    const result: ConnectResult = { created: [], updated: [] };

    for (const account of accounts) {
      if (!providers.has(account.platform)) {
        throw new ValidationError(`Platform "${account.platform}" is not available on this server`);
      }
      const data = {
        displayName: account.displayName,
        username: account.username,
        avatarUrl: account.avatarUrl,
        accessTokenEncrypted: cipher.encrypt(account.credentials.accessToken),
        refreshTokenEncrypted: account.credentials.refreshToken
          ? cipher.encrypt(account.credentials.refreshToken)
          : null,
        tokenExpiresAt: account.credentials.expiresAt,
        scopes: account.credentials.scopes,
        metadata: account.metadata as Prisma.InputJsonValue,
      };
      const where = {
        userId_platform_platformAccountId: {
          userId,
          platform: account.platform,
          platformAccountId: account.platformAccountId,
        },
      };
      const existing = await db.socialAccount.findUnique({ where });
      const saved = existing
        ? await db.socialAccount.update({ where, data })
        : await db.socialAccount.create({
            data: {
              ...data,
              userId,
              platform: account.platform,
              platformAccountId: account.platformAccountId,
            },
          });
      (existing ? result.updated : result.created).push(toSocialAccountDto(saved));
      logger.info(
        {
          user_id: userId,
          social_account_id: saved.id,
          platform: saved.platform,
          reconnected: Boolean(existing),
        },
        'social account connected',
      );
    }
    return result;
  }

  async setEnabled(userId: string, accountId: string, enabled: boolean): Promise<SocialAccountDto> {
    const account = await this.getOwned(userId, accountId);
    const updated = await this.options.db.socialAccount.update({
      where: { id: account.id },
      data: { enabled },
    });
    this.options.logger.info(
      { user_id: userId, social_account_id: accountId, enabled },
      'social account toggled',
    );
    return toSocialAccountDto(updated);
  }

  /**
   * Remove the account and its credentials. Publishing history is preserved:
   * destinations keep their snapshot and their FK is set to null.
   */
  async disconnect(userId: string, accountId: string): Promise<void> {
    const account = await this.getOwned(userId, accountId);
    await this.options.db.socialAccount.delete({ where: { id: account.id } });
    this.options.logger.info(
      { user_id: userId, social_account_id: accountId, platform: account.platform },
      'social account disconnected',
    );
  }

  /** Server-side only: decrypted credentials for the publishing engine. */
  async getProviderAccount(accountId: string): Promise<ProviderAccount | null> {
    const account = await this.options.db.socialAccount.findUnique({ where: { id: accountId } });
    return account ? toProviderAccount(account, this.options.cipher) : null;
  }

  /** Persist refreshed credentials, encrypted. */
  async updateCredentials(accountId: string, credentials: ProviderCredentials): Promise<void> {
    const { db, cipher } = this.options;
    await db.socialAccount.update({
      where: { id: accountId },
      data: {
        accessTokenEncrypted: cipher.encrypt(credentials.accessToken),
        refreshTokenEncrypted: credentials.refreshToken
          ? cipher.encrypt(credentials.refreshToken)
          : undefined,
        tokenExpiresAt: credentials.expiresAt,
        scopes: credentials.scopes,
      },
    });
  }

  /** Which of the given platform identities does this user already have? */
  async findExisting(
    userId: string,
    identities: { platform: string; platformAccountId: string }[],
  ): Promise<Set<string>> {
    if (identities.length === 0) return new Set();
    const rows = await this.options.db.socialAccount.findMany({
      where: {
        userId,
        OR: identities.map((identity) => ({
          platform: identity.platform,
          platformAccountId: identity.platformAccountId,
        })),
      },
      select: { platform: true, platformAccountId: true },
    });
    return new Set(rows.map((row) => `${row.platform}:${row.platformAccountId}`));
  }

  async getOwned(userId: string, accountId: string): Promise<SocialAccount> {
    const account = await this.options.db.socialAccount.findFirst({
      where: { id: accountId, userId },
    });
    if (!account) throw new NotFoundError('Account');
    return account;
  }
}
