import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { loadEnv, type Env } from '@repeat/config';
import { createTestPrismaClient, truncateAll, TEST_DATABASE_URL } from '@repeat/database/testing';
import type { Db } from '@repeat/database';
import { MockPublisher, type MockSettings } from '@repeat/provider-mock';
import {
  ConnectorRegistry,
  ProviderRegistry,
  type ConnectableAccount,
  type PublisherProvider,
} from '@repeat/provider-sdk';
import {
  createCoreServices,
  createLogger,
  InMemoryDispatcher,
  LocalStorageProvider,
  type CoreServices,
} from '../../src/index.js';

export interface Harness {
  env: Env;
  db: Db;
  services: CoreServices;
  dispatcher: InMemoryDispatcher;
  storage: LocalStorageProvider;
  mock: MockPublisher;
  createUser(email?: string): Promise<{ id: string; email: string }>;
  connectMock(userId: string, displayName: string, behavior?: string): Promise<string>;
  uploadVideo(userId: string, filename?: string): Promise<string>;
  uploadImage(
    userId: string,
    filename?: string,
    mimeType?: 'image/jpeg' | 'image/png',
  ): Promise<string>;
  /** Connect an account on the video-only test platform (single video per post, like YouTube). */
  connectVideoOnly(userId: string, displayName: string): Promise<string>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** A valid-looking MP4 header (ftyp box) followed by filler. */
/** Minimal files whose headers pass the upload sniffing. */
export function fakeJpeg(size = 2048): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 4, 1)]);
}
export function fakePng(size = 2048): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(size - 8, 1),
  ]);
}

export function fakeMp4(size = 4096): Buffer {
  const header = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftypisom'),
    Buffer.alloc(8),
  ]);
  return Buffer.concat([header, Buffer.alloc(Math.max(0, size - header.length), 7)]);
}

export async function createHarness(): Promise<Harness> {
  const mediaDir = await mkdtemp(path.join(os.tmpdir(), 'repeat-test-media-'));
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: 'redis://localhost:6379',
    APP_URL: 'http://localhost:3000',
    SESSION_SECRET: 'test-session-secret-test-session-secret',
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    MEDIA_STORAGE_PATH: mediaDir,
    MAX_UPLOAD_SIZE_MB: '1',
    MOCK_PROVIDER_ENABLED: 'true',
  });
  const db = createTestPrismaClient();
  const storage = new LocalStorageProvider(mediaDir);
  const mock = new MockPublisher({ defaultUploadMs: 0, sleep: async () => {} });
  // A second platform that, like YouTube or TikTok, only takes one video per post.
  const videoOnlyBase = new MockPublisher({ defaultUploadMs: 0, sleep: async () => {} });
  const videoOnly: PublisherProvider<MockSettings> = {
    platform: 'videoonly',
    displayName: 'VideoOnly',
    capabilities: { media: { video: true, image: false }, requiresPublicMediaUrl: false },
    settingsFields: [],
    settingsSchema: videoOnlyBase.settingsSchema,
    notes: [],
    validateAccount: (account) => videoOnlyBase.validateAccount(account),
    refreshCredentialsIfNeeded: (account) => videoOnlyBase.refreshCredentialsIfNeeded(account),
    validateMedia: (media) => videoOnlyBase.validateMedia(media),
    publish: (input, ctx) => videoOnlyBase.publish(input, ctx),
    getStatus: (input, ctx) => videoOnlyBase.getStatus(input, ctx),
    normalizeError: (error) => videoOnlyBase.normalizeError(error),
  };
  const providers = new ProviderRegistry().register(mock).register(videoOnly);
  const connectors = new ConnectorRegistry();
  const dispatcher = new InMemoryDispatcher();
  const logger = createLogger({ level: 'silent' });
  const services = createCoreServices({
    env,
    db,
    logger,
    storage,
    providers,
    connectors,
    dispatcher,
  });

  const harness: Harness = {
    env,
    db,
    services,
    dispatcher,
    storage,
    mock,
    async createUser(email) {
      return db.user.create({
        data: { email: email ?? `user-${randomUUID()}@test.local`, passwordHash: 'x' },
        select: { id: true, email: true },
      });
    },
    async connectMock(userId, displayName, behavior = 'succeed') {
      const account: ConnectableAccount = {
        platform: 'mock',
        platformAccountId: `mock-${displayName.toLowerCase().replace(/\s+/g, '-')}`,
        displayName,
        username: null,
        avatarUrl: null,
        credentials: {
          accessToken: `token-${displayName}`,
          refreshToken: null,
          expiresAt: null,
          scopes: [],
        },
        metadata: { behavior },
      };
      const result = await services.accounts.connect(userId, [account]);
      return (result.created[0] ?? result.updated[0])!.id;
    },
    async uploadImage(userId, filename = 'photo.jpg', mimeType = 'image/jpeg') {
      const media = await services.media.createFromStream({
        userId,
        filename,
        mimeType,
        stream: Readable.from([mimeType === 'image/png' ? fakePng() : fakeJpeg()]),
      });
      return media.id;
    },
    async connectVideoOnly(userId, displayName) {
      const result = await services.accounts.connect(userId, [
        {
          platform: 'videoonly',
          platformAccountId: `vo-${displayName.toLowerCase().replace(/\s+/g, '-')}`,
          displayName,
          username: null,
          avatarUrl: null,
          credentials: { accessToken: 'vo-token', refreshToken: null, expiresAt: null, scopes: [] },
          metadata: { behavior: 'succeed' },
        },
      ]);
      return (result.created[0] ?? result.updated[0])!.id;
    },
    async uploadVideo(userId, filename = 'video.mp4') {
      const media = await services.media.createFromStream({
        userId,
        filename,
        mimeType: 'video/mp4',
        stream: Readable.from([fakeMp4()]),
      });
      return media.id;
    },
    async reset() {
      await truncateAll(db);
      dispatcher.reset();
    },
    async close() {
      await db.$disconnect();
      await rm(mediaDir, { recursive: true, force: true });
    },
  };
  return harness;
}
