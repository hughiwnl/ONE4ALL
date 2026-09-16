# Architecture

This document explains how Repeat is put together and why, so that the next
features (more providers, S3 storage, scheduling, a hosted version, mobile
clients) can be added without rewriting what exists.

## Overview

```
           ┌──────────────────────────────┐
 browser ──►│ apps/web  (Next.js)          │
           │  pages ── server components  │
           │  /api/*  ── thin handlers ───┼──► @repeat/core services ──► PostgreSQL (Prisma)
           └──────────────────────────────┘             │
                                                        │ PublishDispatcher port
                                                        ▼
                                              @repeat/queue (BullMQ) ──► Redis
                                                        ▲
           ┌──────────────────────────────┐             │ jobs
           │ apps/worker                  │◄────────────┘
           │  PublishingEngine ───────────┼──► ProviderRegistry ──► YouTube / Meta / Mock adapters ──► platform APIs
           └──────────────────────────────┘                  │
                                                             └──► StorageProvider (local disk today)
```

Two processes share one code base:

- **web** renders the UI and exposes the HTTP API. It never talks to a social platform except during OAuth account connection.
- **worker** consumes queue jobs and runs the publishing engine. It can be scaled horizontally; nothing in it is request-scoped.

Both build the same object graph through `createCoreServices()` (packages/core/src/services.ts) with their own infrastructure (database client, queue connection, storage). That function is the only place services are wired together, which is what a future cloud API would call too.

## Packages and dependency direction

```
types ◄── config ◄── database ◄── provider-sdk ◄── core ◄── auth
                                       ▲            ▲        ▲
                       providers/{youtube,meta,mock}│        │
                                       ▲            │        │
                                 providers/all      queue    │
                                       ▲            ▲        │
                                       └── apps/web, apps/worker
```

Rules:

- `core` depends on the provider **SDK** (interfaces), never on a concrete provider.
- `core` defines the `PublishDispatcher` port; `queue` implements it. Core never imports BullMQ.
- Concrete providers only depend on the SDK and `types`. The composition root (`providers/all`) is the single place that knows which providers exist.
- `types` has no runtime dependency except zod, so browser and native clients can consume it.

## Data model

Tables (see `packages/database/prisma/schema.prisma`):

### users, sessions

A user has an email and a scrypt password hash. Sessions are rows keyed by the SHA-256 hash of the cookie token, with sliding expiry. The model is multi-user from day one even though a self-hosted install typically has one user; teams/organizations would be added as a new owner dimension rather than by changing the publishing tables.

### social_accounts

One row per **connected account**, never per platform. Identity is `(user_id, platform, platform_account_id)`, so a user can hold any number of YouTube channels or Facebook Pages; reconnecting an existing identity refreshes credentials in place.

| Column                                                                            | Notes                                                                                                                       |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `platform`                                                                        | string id of the provider (`youtube`, `instagram`, `facebook`, `mock`...). Not an enum, so new providers need no migration. |
| `platform_account_id`                                                             | channel id / page id / IG user id                                                                                           |
| `display_name`, `username`, `avatar_url`                                          | identity shown in the UI                                                                                                    |
| `access_token_encrypted`, `refresh_token_encrypted`, `token_expires_at`, `scopes` | credentials, AES-256-GCM encrypted by `TokenCipher`                                                                         |
| `enabled`                                                                         | persistent on/off switch; disabled accounts are hidden from publishing but kept                                             |
| `metadata`                                                                        | non-sensitive provider details (e.g. the Page backing an Instagram account, mock behaviour)                                 |

### media

An uploaded file: storage key (opaque, chosen by the server), original filename, MIME type, size, and ffprobe results (duration, width, height) when available. Bytes live in the `StorageProvider`, never in the database.

### posts

The user's intent: one media item plus the common fields `title`, `caption`, `description`. Providers fall back to these when their own settings are empty.

### post_destinations

**One row per selected account per post — the unit of work.**

| Column                                             | Notes                                                                                                 |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `status`                                           | `queued` → `uploading` → `processing` → `published`, or `failed` / `canceled`                         |
| `progress`                                         | 0–100 while uploading                                                                                 |
| `settings`                                         | provider-specific options validated by the provider's zod schema                                      |
| `platform_post_id`, `platform_post_url`            | result                                                                                                |
| `provider_state`                                   | opaque JSON carried from `publish()` to `getStatus()` (e.g. an Instagram container id)                |
| `error_code`, `error_message`, `error_retryable`   | normalized failure                                                                                    |
| `attempts`, `job_id`, `started_at`, `published_at` | bookkeeping and log correlation                                                                       |
| `account_display_name`, `account_avatar_url`       | snapshot so history survives disconnecting the account (`social_account_id` is set to null on delete) |

### oauth_states, pending_connections

Server-side OAuth bookkeeping: single-use `state` values (with the PKCE verifier) and the encrypted list of accounts discovered by a callback while the user chooses which to connect.

## Publishing lifecycle

1. **Upload** — `POST /api/media` streams the raw request body into storage through an upload guard that enforces the byte limit and sniffs the container header. ffprobe runs on the stored file. A `media` row is created.
2. **Create post** — `POST /api/posts` validates ownership of the media and every selected account, that each account is enabled and its provider registered, parses per-destination settings with the provider schema, and runs `validateMedia`. If anything is wrong the request fails with a per-destination message and nothing is created. Otherwise the post and its destinations are inserted in one transaction, and afterwards one `publish-destination` job per destination is enqueued.
3. **Worker** — `PublishingEngine.publishDestination()`:
   - loads the destination; skips if it is already terminal (idempotent under redelivery);
   - marks it `uploading`, increments `attempts`;
   - decrypts credentials, `validateAccount`, `refreshCredentialsIfNeeded` (persisting new tokens encrypted), `validateMedia`;
   - calls `provider.publish()` with a `MediaAccess` handle (stream or signed public URL) and a throttled progress callback;
   - records `published`, or `processing` plus a delayed `check-destination-status` job.
4. **Status checks** — `checkDestinationStatus()` calls `provider.getStatus()` until it reports `published` or `failed`, rescheduling itself with the provider's suggested delay, with a global processing timeout.
5. **UI** — the status page polls `GET /api/posts/:id` every 2.5 s while any destination is non-terminal. The payload is designed to be pushed over SSE/WebSockets later without changes to the data model.

### Failure handling

Every destination is independent: the engine handles exactly one destination per job and never touches its siblings, which is `Promise.allSettled` semantics enforced by structure rather than by code.

Errors are normalized into `ProviderError { code, message, retryable, retryAfterMs }`:

- **Retryable** (`network_error`, `timeout`, `rate_limited`, `provider_unavailable`, ...): the destination goes back to `queued` with the error message visible ("retrying, attempt 2 of 5"), the job is rethrown and BullMQ retries it with exponential backoff and full jitter (15 s, 30 s, 60 s... capped at 15 min, or the provider's `Retry-After` when longer). After the last attempt it becomes `failed`.
- **Permanent** (`token_expired`, `token_revoked`, `insufficient_permissions`, `unsupported_account`, `invalid_media`, `media_rejected`, `invalid_settings`, `quota_exceeded`, ...): `failed` immediately, job marked unrecoverable.

Manual **Retry** (`POST /api/posts/:id/destinations/:destinationId/retry`) is only allowed on `failed`/`canceled` destinations, resets their error state and enqueues a fresh job. Published siblings are never republished.

### Observability

Every log line in a job carries `post_id`, `destination_id`, `social_account_id`, `platform`, `job_id` and `attempt`. Credentials are redacted at the logger level. Job ids are human-readable (`publish-<destinationId>-<random>`) so a log line can be matched to a queue entry.

## Provider architecture

See [providers.md](providers.md) for the contract. In short:

- `PublisherProvider` — `validateAccount`, `refreshCredentialsIfNeeded`, `validateMedia`, `publish`, `getStatus`, `normalizeError`, plus declarative `settingsFields`, `settingsSchema`, `capabilities`, `notes`.
- `OAuthConnector` — `getAuthorizationUrl`, `exchangeCode`, `discoverAccounts`. One connector may serve several platforms (Meta → Facebook + Instagram) and discover several accounts per login.
- `ProviderRegistry` / `ConnectorRegistry` — populated by `createProviders(env)` in `packages/providers/all` depending on which credentials are configured.

The engine and the UI only use the interfaces: the Publish page renders `settingsFields` generically, the Accounts page renders one connect button per connector, and the engine drives the lifecycle without knowing what a "resumable upload" or a "media container" is.

## Queue architecture

`@repeat/queue` wraps BullMQ:

- one queue, `repeat-publish`, with two job names: `publish-destination` and `check-destination-status`;
- `BullMqPublishDispatcher` implements the core `PublishDispatcher` port (`enqueuePublish`, `enqueueStatusCheck`, `cancel`);
- `createPublishWorker` maps engine outcomes to BullMQ semantics: `retry` → throw (BullMQ retries with the custom `backoffStrategy`), `failed` → `UnrecoverableError`, otherwise complete;
- long `lockDuration` so a multi-gigabyte upload is not considered stalled.

Because the dispatcher is a port, tests use an in-memory implementation and a future deployment could swap BullMQ for another queue without touching core.

## Storage abstraction

`StorageProvider` (`packages/core/src/storage`) exposes `put(key, stream)`, `get(key, range?)`, `head`, `delete`, `getLocalPath`. `LocalStorageProvider` writes to a temp file and renames atomically, and refuses any key that would escape its root. Providers never see storage keys: they receive a `MediaAccess` with `openStream(range?)` and `getPublicUrl()`. The public URL is an HMAC-signed, time-limited route served by the web app, which is how Instagram (URL-based ingestion) is supported without making uploads public.

Adding S3/R2/B2 means implementing the same interface (multipart upload for `put`, ranged `GetObject` for `get`, `null` from `getLocalPath` or a temp download for ffprobe) and adding a case to `createStorageProvider`. `getPublicUrl` could then return a pre-signed object URL instead of the app route.

## Authentication and security

- Passwords: Node's built-in scrypt.
- Sessions: random 256-bit tokens, SHA-256 hashed in the database, `HttpOnly; SameSite=Lax; Secure` (when HTTPS) cookie, sliding 30-day expiry.
- CSRF: SameSite cookies plus an `Origin`/`Sec-Fetch-Site` check on every non-GET API request (`assertTrustedOrigin`).
- OAuth: single-use, user-bound, expiring `state`; PKCE for Google; callback parameters validated; discovered accounts stored encrypted until selection.
- Authorization: every service method takes the acting `userId` and scopes queries by it; missing and foreign resources both return 404.
- Uploads: allow-listed MIME/extensions that must agree, header sniff, streamed byte cap, server-generated storage keys.

## Future: hosted Repeat, cloud API and mobile clients

Nothing hosted exists yet, and V1 deliberately avoids billing, teams, scheduling and analytics. The intended shape:

```
open-source self-hosted Repeat ──┐
                                 ├── packages/core + providers + types (shared, unchanged)
Repeat Cloud API ────────────────┘
   ├── web client (this Next.js app, talking to the API instead of in-process services)
   ├── iOS client   ─┐ typed clients generated from @repeat/types contracts
   └── Android client┘
```

What makes that possible today:

- Route handlers contain no logic; `createCoreServices()` can be hosted behind any HTTP framework.
- API contracts live in `@repeat/types` (zod schemas + DTOs) and are already used by the browser client.
- The data model is multi-user; adding an `organization_id` owner dimension and a `plan` on users/orgs does not touch posts, destinations or providers.
- Scheduling is a `scheduled_at` on posts plus `delayMs` on `enqueuePublish` (the dispatcher already accepts a delay).
- Analytics would be a new provider capability (`getInsights`) alongside publishing, read by a separate job type.
- Storage and queue are ports; a hosted deployment swaps in S3 and a managed Redis.
