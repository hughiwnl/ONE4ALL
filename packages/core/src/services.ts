import type { Env } from '@repeat/config';
import type { Db } from '@repeat/database';
import type { ConnectorRegistry, ProviderRegistry } from '@repeat/provider-sdk';
import { AccountService } from './accounts/account-service.js';
import { TokenCipher } from './crypto/token-cipher.js';
import type { Logger } from './logger.js';
import { MediaService } from './media/media-service.js';
import { MediaUrlSigner } from './media/signed-url.js';
import { PostService } from './posts/post-service.js';
import type { PublishDispatcher } from './publishing/dispatcher.js';
import { PublishingEngine } from './publishing/publishing-engine.js';
import type { StorageProvider } from './storage/storage-provider.js';

export interface CoreDependencies {
  env: Env;
  db: Db;
  logger: Logger;
  storage: StorageProvider;
  providers: ProviderRegistry;
  connectors: ConnectorRegistry;
  dispatcher: PublishDispatcher;
}

export interface CoreServices {
  cipher: TokenCipher;
  storage: StorageProvider;
  urlSigner: MediaUrlSigner;
  accounts: AccountService;
  media: MediaService;
  posts: PostService;
  engine: PublishingEngine;
  providers: ProviderRegistry;
  connectors: ConnectorRegistry;
}

/**
 * Wire the core services together. Both the web app and the worker call this
 * with their own infrastructure (database client, queue, storage).
 */
export function createCoreServices(deps: CoreDependencies): CoreServices {
  const cipher = new TokenCipher(deps.env.TOKEN_ENCRYPTION_KEY);
  const urlSigner = new MediaUrlSigner(deps.env.SESSION_SECRET, deps.env.APP_URL);
  const accounts = new AccountService({
    db: deps.db,
    cipher,
    logger: deps.logger,
    providers: deps.providers,
  });
  const media = new MediaService({
    db: deps.db,
    storage: deps.storage,
    logger: deps.logger,
    maxUploadSizeBytes: deps.env.MAX_UPLOAD_SIZE_MB * 1024 * 1024,
    ffprobePath: deps.env.FFPROBE_PATH,
  });
  const posts = new PostService({
    db: deps.db,
    media,
    providers: deps.providers,
    dispatcher: deps.dispatcher,
    logger: deps.logger,
  });
  const engine = new PublishingEngine({
    db: deps.db,
    providers: deps.providers,
    accounts,
    storage: deps.storage,
    dispatcher: deps.dispatcher,
    logger: deps.logger,
    urlSigner,
  });
  return {
    cipher,
    storage: deps.storage,
    urlSigner,
    accounts,
    media,
    posts,
    engine,
    providers: deps.providers,
    connectors: deps.connectors,
  };
}
