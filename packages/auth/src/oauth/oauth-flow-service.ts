import type { Db } from '@repeat/database';
import {
  AppError,
  NotFoundError,
  ValidationError,
  type AccountService,
  type ConnectResult,
  type Logger,
  type TokenCipher,
} from '@repeat/core';
import type { ConnectableAccount, ConnectorRegistry } from '@repeat/provider-sdk';
import type { ConnectableAccountDto } from '@repeat/types';
import { generatePkcePair, generateState } from './pkce.js';

const STATE_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 15 * 60 * 1000;

export interface OAuthFlowServiceOptions {
  db: Db;
  connectors: ConnectorRegistry;
  accounts: AccountService;
  cipher: TokenCipher;
  logger: Logger;
  appUrl: string;
}

export interface OAuthCallbackParams {
  state: string | null;
  code: string | null;
  error: string | null;
  errorDescription?: string | null;
}

export interface OAuthCallbackResult {
  pendingConnectionId: string;
  connectorId: string;
  accounts: ConnectableAccountDto[];
}

/**
 * Generic OAuth "connect account" orchestration, independent of any provider:
 *
 *   begin()     → store a single-use state (+ PKCE verifier) and build the provider URL
 *   complete()  → validate state, exchange the code, discover accounts, park them (encrypted)
 *   finalize()  → store the accounts the user selected as SocialAccounts
 *
 * Connectors (Google, Meta, ...) only implement the provider-specific bits.
 */
export class OAuthFlowService {
  constructor(private readonly options: OAuthFlowServiceOptions) {}

  redirectUri(connectorId: string): string {
    return new URL(
      `/api/connect/${encodeURIComponent(connectorId)}/callback`,
      this.options.appUrl,
    ).toString();
  }

  async begin(userId: string, connectorId: string): Promise<{ url: string }> {
    const connector = this.getConnector(connectorId);
    const state = generateState();
    const pkce = connector.usesPkce ? generatePkcePair() : null;
    await this.options.db.oAuthState.create({
      data: {
        userId,
        connectorId,
        state,
        codeVerifier: pkce?.verifier ?? null,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    });
    const url = connector.getAuthorizationUrl({
      state,
      redirectUri: this.redirectUri(connectorId),
      codeChallenge: pkce?.challenge,
    });
    this.options.logger.info({ user_id: userId, connector: connectorId }, 'oauth flow started');
    return { url };
  }

  async complete(
    userId: string,
    connectorId: string,
    params: OAuthCallbackParams,
  ): Promise<OAuthCallbackResult> {
    const { db, cipher, accounts, logger } = this.options;
    const connector = this.getConnector(connectorId);

    if (!params.state) throw new ValidationError('Missing OAuth state parameter');
    // Single use: consume the state before doing anything else.
    const stored = await db.oAuthState.findUnique({ where: { state: params.state } });
    if (stored) await db.oAuthState.delete({ where: { id: stored.id } });
    if (!stored || stored.userId !== userId || stored.connectorId !== connectorId) {
      throw new ValidationError('Invalid OAuth state. Please start the connection again.');
    }
    if (stored.expiresAt.getTime() < Date.now()) {
      throw new ValidationError('The OAuth request expired. Please start the connection again.');
    }

    if (params.error) {
      const description = params.errorDescription ? `: ${params.errorDescription}` : '';
      throw new AppError(
        'oauth_denied',
        `${connector.label} authorization was not granted (${params.error})${description}`,
        400,
      );
    }
    if (!params.code) throw new ValidationError('Missing OAuth authorization code');

    const ctx = { logger: logger.child({ connector: connectorId }) };
    const tokens = await connector.exchangeCode(
      {
        code: params.code,
        redirectUri: this.redirectUri(connectorId),
        codeVerifier: stored.codeVerifier ?? undefined,
      },
      ctx,
    );
    const discovered = await connector.discoverAccounts(tokens, ctx);
    if (discovered.length === 0) {
      throw new AppError(
        'no_connectable_accounts',
        `No publishable accounts were found for this ${connector.label} login. Check the provider requirements in the documentation.`,
        400,
      );
    }

    const pending = await db.pendingConnection.create({
      data: {
        userId,
        connectorId,
        payloadEncrypted: cipher.encryptJson(discovered),
        expiresAt: new Date(Date.now() + PENDING_TTL_MS),
      },
    });
    const existing = await accounts.findExisting(userId, discovered);
    logger.info(
      { user_id: userId, connector: connectorId, discovered: discovered.length },
      'oauth callback completed',
    );
    return {
      pendingConnectionId: pending.id,
      connectorId,
      accounts: discovered.map((account) => toConnectableDto(account, existing)),
    };
  }

  async getPending(userId: string, pendingConnectionId: string): Promise<OAuthCallbackResult> {
    const { accounts } = this.options;
    const { pending, discovered } = await this.loadPending(userId, pendingConnectionId);
    const existing = await accounts.findExisting(userId, discovered);
    return {
      pendingConnectionId: pending.id,
      connectorId: pending.connectorId,
      accounts: discovered.map((account) => toConnectableDto(account, existing)),
    };
  }

  async finalize(
    userId: string,
    pendingConnectionId: string,
    selected: { platform: string; platformAccountId: string }[],
  ): Promise<ConnectResult> {
    const { db, accounts } = this.options;
    const { pending, discovered } = await this.loadPending(userId, pendingConnectionId);
    const wanted = new Set(selected.map((item) => `${item.platform}:${item.platformAccountId}`));
    const chosen = discovered.filter((account) =>
      wanted.has(`${account.platform}:${account.platformAccountId}`),
    );
    if (chosen.length === 0)
      throw new ValidationError('None of the selected accounts belong to this connection');
    const result = await accounts.connect(userId, chosen);
    await db.pendingConnection.delete({ where: { id: pending.id } }).catch(() => undefined);
    return result;
  }

  async purgeExpired(): Promise<void> {
    const now = new Date();
    await this.options.db.oAuthState.deleteMany({ where: { expiresAt: { lt: now } } });
    await this.options.db.pendingConnection.deleteMany({ where: { expiresAt: { lt: now } } });
  }

  private async loadPending(userId: string, pendingConnectionId: string) {
    const pending = await this.options.db.pendingConnection.findFirst({
      where: { id: pendingConnectionId, userId },
    });
    if (!pending) throw new NotFoundError('Pending connection');
    if (pending.expiresAt.getTime() < Date.now()) {
      await this.options.db.pendingConnection
        .delete({ where: { id: pending.id } })
        .catch(() => undefined);
      throw new ValidationError('This connection request expired. Please start again.');
    }
    const discovered = this.options.cipher.decryptJson<ConnectableAccount[]>(
      pending.payloadEncrypted,
    );
    // Dates do not survive JSON; restore them.
    for (const account of discovered) {
      const expiresAt = account.credentials.expiresAt as unknown;
      account.credentials.expiresAt = typeof expiresAt === 'string' ? new Date(expiresAt) : null;
    }
    return { pending, discovered };
  }

  private getConnector(connectorId: string) {
    const connector = this.options.connectors.get(connectorId);
    if (!connector) throw new NotFoundError(`Connector "${connectorId}"`);
    return connector;
  }
}

function toConnectableDto(
  account: ConnectableAccount,
  existing: Set<string>,
): ConnectableAccountDto {
  return {
    platform: account.platform,
    platformAccountId: account.platformAccountId,
    displayName: account.displayName,
    username: account.username,
    avatarUrl: account.avatarUrl,
    alreadyConnected: existing.has(`${account.platform}:${account.platformAccountId}`),
    metadata: account.metadata,
  };
}
