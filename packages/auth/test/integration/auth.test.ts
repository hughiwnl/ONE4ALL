import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AppError,
  AccountService,
  ConflictError,
  createLogger,
  TokenCipher,
  UnauthorizedError,
  ValidationError,
} from '@repeat/core';
import { createTestPrismaClient, truncateAll } from '@repeat/database/testing';
import { MockPublisher } from '@repeat/provider-mock';
import {
  ConnectorRegistry,
  ProviderRegistry,
  type OAuthConnector,
  type OAuthTokens,
} from '@repeat/provider-sdk';
import { OAuthFlowService } from '../../src/oauth/oauth-flow-service.js';
import { SessionService } from '../../src/session-service.js';
import { UserService } from '../../src/user-service.js';

const db = createTestPrismaClient();
const logger = createLogger({ level: 'silent' });

beforeAll(async () => {
  await db.$connect();
});
afterAll(async () => db.$disconnect());
beforeEach(async () => truncateAll(db));

describe('UserService', () => {
  it('registers, authenticates and rejects duplicates', async () => {
    const users = new UserService({ db, allowRegistration: true });
    const user = await users.register({ email: 'a@example.com', password: 'a-long-password' });
    expect(user.passwordHash).not.toContain('a-long-password');
    expect(
      (await users.authenticate({ email: 'a@example.com', password: 'a-long-password' })).id,
    ).toBe(user.id);
    await expect(
      users.authenticate({ email: 'a@example.com', password: 'wrong' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(
      users.authenticate({ email: 'nobody@example.com', password: 'wrong' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(
      users.register({ email: 'a@example.com', password: 'another-password' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('always allows the first user, then honours ALLOW_REGISTRATION', async () => {
    const closed = new UserService({ db, allowRegistration: false });
    await closed.register({ email: 'first@example.com', password: 'first-password-1' });
    await expect(
      closed.register({ email: 'second@example.com', password: 'second-password' }),
    ).rejects.toMatchObject({ code: 'registration_disabled' });
  });
});

describe('SessionService', () => {
  it('creates, validates, and destroys sessions; stores only a hash', async () => {
    const users = new UserService({ db, allowRegistration: true });
    const sessions = new SessionService(db);
    const user = await users.register({ email: 's@example.com', password: 'session-password' });
    const { token } = await sessions.create(user.id);
    expect((await sessions.validate(token))?.id).toBe(user.id);
    expect(await sessions.validate('bogus')).toBeNull();
    expect(await sessions.validate(undefined)).toBeNull();
    const rows = await db.session.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(token);
    await sessions.destroy(token);
    expect(await sessions.validate(token)).toBeNull();
  });

  it('rejects expired sessions', async () => {
    const users = new UserService({ db, allowRegistration: true });
    const sessions = new SessionService(db);
    const user = await users.register({ email: 'e@example.com', password: 'session-password' });
    const { token } = await sessions.create(user.id);
    await db.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await sessions.validate(token)).toBeNull();
    expect(await db.session.count()).toBe(0);
  });
});

describe('OAuthFlowService', () => {
  const cipher = new TokenCipher(Buffer.alloc(32, 5));
  const providers = new ProviderRegistry().register(new MockPublisher({ defaultUploadMs: 0 }));
  const accounts = new AccountService({ db, cipher, logger, providers });

  let exchangeCalls: { code: string; codeVerifier?: string }[] = [];
  const connector: OAuthConnector = {
    id: 'fake',
    label: 'Fake',
    platforms: ['mock'],
    usesPkce: true,
    getAuthorizationUrl: ({ state, redirectUri, codeChallenge }) =>
      `https://provider.example/auth?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}&cc=${codeChallenge ?? ''}`,
    async exchangeCode(params): Promise<OAuthTokens> {
      exchangeCalls.push({ code: params.code, codeVerifier: params.codeVerifier });
      if (params.code === 'bad') throw new Error('invalid code');
      return {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: new Date(Date.now() + 3600_000),
        scopes: ['s'],
      };
    },
    async discoverAccounts() {
      return [
        {
          platform: 'mock',
          platformAccountId: 'one',
          displayName: 'One',
          username: null,
          avatarUrl: null,
          credentials: {
            accessToken: 'plaintext-token-one',
            refreshToken: null,
            expiresAt: null,
            scopes: [],
          },
          metadata: {},
        },
        {
          platform: 'mock',
          platformAccountId: 'two',
          displayName: 'Two',
          username: null,
          avatarUrl: null,
          credentials: {
            accessToken: 'plaintext-token-two',
            refreshToken: null,
            expiresAt: null,
            scopes: [],
          },
          metadata: {},
        },
      ];
    },
  };
  const flow = new OAuthFlowService({
    db,
    connectors: new ConnectorRegistry().register(connector),
    accounts,
    cipher,
    logger,
    appUrl: 'https://repeat.example.com',
  });

  beforeEach(() => {
    exchangeCalls = [];
  });

  async function user(email = 'o@example.com') {
    return db.user.create({ data: { email, passwordHash: 'x' } });
  }

  it('runs begin → callback → selection and stores only the chosen accounts', async () => {
    const me = await user();
    const { url } = await flow.begin(me.id, 'fake');
    const state = new URL(url).searchParams.get('state')!;
    expect(new URL(url).searchParams.get('redirect_uri')).toBe(
      'https://repeat.example.com/api/connect/fake/callback',
    );
    expect(new URL(url).searchParams.get('cc')).not.toBe('');

    const result = await flow.complete(me.id, 'fake', { state, code: 'good', error: null });
    expect(exchangeCalls[0]?.codeVerifier).toBeTruthy();
    expect(result.accounts.map((a) => a.displayName)).toEqual(['One', 'Two']);
    expect(result.accounts.every((a) => !a.alreadyConnected)).toBe(true);
    // pending payload is encrypted at rest
    const pending = await db.pendingConnection.findFirstOrThrow();
    expect(pending.payloadEncrypted).not.toContain('plaintext-token');

    const connected = await flow.finalize(me.id, result.pendingConnectionId, [
      { platform: 'mock', platformAccountId: 'two' },
    ]);
    expect(connected.created.map((a) => a.displayName)).toEqual(['Two']);
    expect(await accounts.list(me.id)).toHaveLength(1);
    expect(await db.pendingConnection.count()).toBe(0);
  });

  it('rejects unknown, reused, foreign and expired states', async () => {
    const me = await user();
    const other = await user('other@example.com');
    await expect(
      flow.complete(me.id, 'fake', { state: 'nope', code: 'good', error: null }),
    ).rejects.toBeInstanceOf(ValidationError);

    const { url } = await flow.begin(me.id, 'fake');
    const state = new URL(url).searchParams.get('state')!;
    await expect(
      flow.complete(other.id, 'fake', { state, code: 'good', error: null }),
    ).rejects.toBeInstanceOf(ValidationError);
    // consumed by the failed attempt: a replay must fail too
    await expect(
      flow.complete(me.id, 'fake', { state, code: 'good', error: null }),
    ).rejects.toBeInstanceOf(ValidationError);

    const { url: url2 } = await flow.begin(me.id, 'fake');
    const state2 = new URL(url2).searchParams.get('state')!;
    await db.oAuthState.updateMany({ data: { expiresAt: new Date(Date.now() - 1) } });
    await expect(
      flow.complete(me.id, 'fake', { state: state2, code: 'good', error: null }),
    ).rejects.toThrow(/expired/);
    expect(exchangeCalls).toHaveLength(0);
  });

  it('surfaces provider denials and code exchange failures', async () => {
    const me = await user();
    const state1 = new URL((await flow.begin(me.id, 'fake')).url).searchParams.get('state')!;
    await expect(
      flow.complete(me.id, 'fake', {
        state: state1,
        code: null,
        error: 'access_denied',
        errorDescription: 'user said no',
      }),
    ).rejects.toMatchObject({
      code: 'oauth_denied',
    });
    const state2 = new URL((await flow.begin(me.id, 'fake')).url).searchParams.get('state')!;
    await expect(
      flow.complete(me.id, 'fake', { state: state2, code: 'bad', error: null }),
    ).rejects.toThrow('invalid code');
  });

  it("does not let a user finalize another user's pending connection", async () => {
    const me = await user();
    const other = await user('other@example.com');
    const state = new URL((await flow.begin(me.id, 'fake')).url).searchParams.get('state')!;
    const result = await flow.complete(me.id, 'fake', { state, code: 'good', error: null });
    await expect(
      flow.finalize(other.id, result.pendingConnectionId, [
        { platform: 'mock', platformAccountId: 'one' },
      ]),
    ).rejects.toMatchObject({ status: 404 });
    await expect(flow.getPending(other.id, result.pendingConnectionId)).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it('marks accounts that are already connected when reconnecting', async () => {
    const me = await user();
    const state = new URL((await flow.begin(me.id, 'fake')).url).searchParams.get('state')!;
    const first = await flow.complete(me.id, 'fake', { state, code: 'good', error: null });
    await flow.finalize(me.id, first.pendingConnectionId, [
      { platform: 'mock', platformAccountId: 'one' },
    ]);

    const state2 = new URL((await flow.begin(me.id, 'fake')).url).searchParams.get('state')!;
    const second = await flow.complete(me.id, 'fake', { state: state2, code: 'good', error: null });
    expect(second.accounts.map((a) => [a.displayName, a.alreadyConnected])).toEqual([
      ['One', true],
      ['Two', false],
    ]);
    const result = await flow.finalize(me.id, second.pendingConnectionId, [
      { platform: 'mock', platformAccountId: 'one' },
      { platform: 'mock', platformAccountId: 'two' },
    ]);
    expect(result.updated).toHaveLength(1);
    expect(result.created).toHaveLength(1);
    expect(await accounts.list(me.id)).toHaveLength(2);
  });
});
