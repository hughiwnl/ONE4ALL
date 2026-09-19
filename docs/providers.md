# Providers

A provider is the adapter between Repeat's publishing engine and one social platform. This document lists what the shipped providers can and cannot do, and then walks through adding a new one.

## Shipped providers

### YouTube (`packages/providers/youtube`)

- **Connector**: Google OAuth 2.0 with PKCE, scopes `youtube.upload` + `youtube.readonly`, `access_type=offline` and `prompt=consent select_account` so every connection yields a refresh token and lets the user pick a channel (brand accounts included). One login = one channel; connect again for another.
- **Publish**: resumable upload protocol in 8 MiB chunks read straight from storage, progress reporting, resume from the server-reported offset on transient chunk failures, session-expiry handling. Metadata: title (required, ≤ 100 chars, no `<>`), description (≤ 5000), privacy, category, tags, made-for-kids self-declaration, notify-subscribers.
- **Status**: polls `videos.list(part=status,processingDetails)` until `uploadStatus=processed`; `failed`/`rejected` map to `media_rejected` with the platform reason (duplicate, copyright, length...).
- **Credentials**: access tokens refreshed automatically five minutes before expiry; `invalid_grant` becomes `token_revoked` (reconnect).
- **Restrictions**: unaudited Google Cloud projects upload as private; ~1,600 quota units per upload out of 10,000/day; Testing-mode consent screens expire refresh tokens after 7 days; videos > 15 min need a verified channel.

### Facebook Pages (`packages/providers/meta`, `FacebookPublisher`)

- **Connector**: shared Meta connector (Facebook Login). Discovers Pages via `me/accounts` and stores each Page's long-lived Page access token.
- **Publish**: Graph API resumable video upload (`upload_phase=start/transfer/finish`) against `graph-video.facebook.com`, chunk sizes chosen by the server, progress reporting, then `finish` with title/description and `published=true`. Files up to 10 GB / 4 h.
- **Status**: polls `/{video-id}?fields=status{video_status,...}` until `ready`; `error`/`expired` become `media_rejected` with the platform message; `permalink_url` recorded.
- **Restrictions**: Pages only (no personal profiles); `pages_manage_posts` requires App Review outside app roles; no refresh tokens (reconnect when a token is invalidated). Reels/Stories are not implemented yet.

### Instagram (`packages/providers/meta`, `InstagramPublisher`)

- **Connector**: the same Meta login. Instagram professional accounts linked to a discovered Page appear as separate connectable accounts, using the Page's token.
- **Publish**: Content Publishing API, always from a **public URL** of each file (Repeat's signed media route). Three shapes:
  - one video → a `REELS` container;
  - one JPEG image → an image container (with optional `alt_text`);
  - 2–10 items → one child container per item (`is_carousel_item=true`; `media_type=VIDEO` for videos), in the post's order. `getStatus` waits until every child is `FINISHED`, then creates the `CAROUSEL` container with `children` and the caption.
    In every case `getStatus` polls the final container (`IN_PROGRESS` → `FINISHED`), publishes it with `media_publish`, and reads the permalink. A failed carousel child is reported with its item number.
- **Restrictions**: Business or Creator accounts linked to a Facebook Page only; MP4/MOV (H.264/AAC), 3 s – 15 min, ≤ 1 GB, width ≤ 1920; images JPEG only, ≤ 8 MB, ≥ 320 px wide, aspect ratio 4:5 to 1.91:1; 100 API posts per 24 h (a carousel counts as one); `APP_URL` must be publicly reachable over HTTPS (error `invalid_media` with an explanation otherwise); `instagram_content_publish` requires App Review outside app roles. Stories, per-item alt text in carousels and the Pages-less "Instagram Login" flow are not implemented yet.

### TikTok (`packages/providers/tiktok`)

- **Connector**: TikTok Login Kit for web, scopes `user.info.basic` and `video.publish`. One login authorizes one TikTok account; connect another by running the flow again while signed into that account on tiktok.com (the consent page is always shown). The account identity is the app-scoped `open_id`; the username comes from `creator_info`.
- **Publish**: Content Posting API **Direct Post** with `FILE_UPLOAD`. Every publish first calls `creator_info/query` as TikTok requires, then checks the chosen privacy against the account's `privacy_level_options` and the video against `max_video_post_duration_sec`, then calls `video/init` and PUTs the file in ordered chunks (files up to 32 MB in one chunk; larger ones in 16 MB chunks with the last absorbing the remainder, per TikTok's 5–64 MB rule).
- **Status**: polls `status/fetch` until `PUBLISH_COMPLETE` or `FAILED`. Public posts get their video id after moderation; Repeat waits about a minute for it, then settles on the profile link. `fail_reason` values map to specific errors (format, duration, frame rate, resolution, spam flags, revoked access).
- **Settings**, following TikTok's Content Sharing Guidelines: privacy has **no default** and must be chosen; Comment, Duet and Stitch are **off by default**, and stay off when the creator disabled them in TikTok; "Your brand" and "Branded content" disclosures (branded content cannot be "Only me"); AI-generated label; caption up to 2,200 characters.
- **Credentials**: access tokens last 24 hours and are refreshed automatically; refresh tokens last 365 days and may rotate on refresh (Repeat stores the newest).
- **Restrictions**: TikTok only accepts **HTTPS** redirect URIs, so `APP_URL` must be HTTPS even for local testing (use a tunnel). **Unaudited apps** can only post with "Only me" visibility, to accounts that are themselves set to private, and at most 5 accounts can post per 24 hours; TikTok's app audit lifts this. There is a per-account daily cap on API posts (`spam_risk_too_many_posts`). MP4/MOV/WebM, up to 4 GB and 10 minutes, 23–60 fps, 360–4096 px per side. Photo posts and upload-to-inbox drafts are not implemented.

### Mock (`packages/providers/mock`)

Development only (`MOCK_PROVIDER_ENABLED=true`). Accounts are created from the Accounts page with a chosen behaviour: succeed, succeed after processing, fail (retryable), fail (permanent), flaky (fails once, then succeeds). Per-destination settings can override the behaviour. It really reads the media stream and reports progress, so storage and the engine are exercised end to end.

## Error classification reference

| `code`                            | Retryable | Typical cause                                                                                   |
| --------------------------------- | --------- | ----------------------------------------------------------------------------------------------- |
| `network_error`, `timeout`        | yes       | socket failures, DNS, request timeouts                                                          |
| `rate_limited`                    | yes       | HTTP 429, Meta codes 4/17/32/613, YouTube `rateLimitExceeded` (uses `Retry-After` when present) |
| `provider_unavailable`            | yes       | HTTP 5xx, Meta `is_transient`, YouTube `backendError`                                           |
| `processing_timeout`              | no        | platform never finished processing within the engine's window                                   |
| `token_expired`, `token_revoked`  | no        | reconnect the account                                                                           |
| `insufficient_permissions`        | no        | missing scope, App Review not granted                                                           |
| `unsupported_account`             | no        | no YouTube channel, no Pages, personal Instagram                                                |
| `invalid_media`, `media_rejected` | no        | format/duration/size rules, copyright/duplicate rejections                                      |
| `invalid_settings`                | no        | provider-specific metadata rejected                                                             |
| `quota_exceeded`                  | no        | YouTube daily quota, Instagram 100/24h                                                          |
| `provider_not_configured`         | no        | provider missing on this server, public URL unavailable                                         |
| `account_disconnected`            | no        | account removed before the job ran                                                              |

## Adding a provider

Example: a hypothetical `acme` video platform. For a complete, real provider built exactly this way, read `packages/providers/tiktok` alongside this guide. Only the first two steps are platform-specific; the engine, database, queue and UI stay untouched.

### 1. Create the package

```
packages/providers/acme/
  package.json          name: @repeat/provider-acme, deps: @repeat/provider-sdk, @repeat/types, zod
  src/index.ts
  src/acme-publisher.ts
  src/acme-connector.ts
  src/errors.ts
  src/__tests__/acme.test.ts
```

Copy `package.json`, `tsconfig.json`, `eslint.config.js` and `vitest.config.ts` from `packages/providers/mock`.

### 2. Implement `PublisherProvider`

```ts
import { z } from 'zod';
import { ProviderError, ProviderErrorCode, requestJson, normalizeUnknownError, type PublisherProvider, ... } from '@repeat/provider-sdk';

export const acmeSettingsSchema = z.object({
  title: z.string().max(2200).optional(),
  privacy: z.enum(['public', 'unlisted', 'private']).default('public'),
});
export type AcmeSettings = z.infer<typeof acmeSettingsSchema>;

export class AcmePublisher implements PublisherProvider<AcmeSettings> {
  readonly platform = 'acme';
  readonly displayName = 'Acme';
  readonly settingsSchema = acmeSettingsSchema;
  readonly capabilities = { media: { video: true, image: false }, maxFileSizeBytes: 4 * 1024 ** 3, requiresPublicMediaUrl: false };
  readonly settingsFields = [
    { key: 'title', label: 'Title', type: 'text', maxLength: 2200, inheritsFrom: 'title' },
    { key: 'privacy', label: 'Privacy', type: 'select', default: 'public', options: [...] },
  ];
  readonly notes = ['Apps in sandbox mode can only post privately.'];

  async validateAccount(account) { /* token present? right scopes? */ }
  async refreshCredentialsIfNeeded(account, ctx) { /* refresh when close to expiry; return new credentials or null */ }
  validateMedia(media, settings) { /* size/duration/mime rules → { ok: false, code, message } */ }
  async publish(input, ctx) {
    // init upload → PUT chunks from input.media.openStream({ start, end }) → ctx.onProgress(percent)
    // return { state: 'processing', platformPostId, platformPostUrl, providerState: { publishId }, pollAfterMs: 10_000 }
  }
  async getStatus(input, ctx) { /* poll with input.providerState; return published/processing/failed */ }
  normalizeError(error) { return isProviderError(error) ? error : normalizeUnknownError(error); }
}
```

Contract details that matter:

- **`settingsSchema` is the source of truth** for `post_destinations.settings`; `settingsFields` is only the UI description. Use `.default()` so omitted fields have values.
- **`inheritsFrom`** on a text field tells the UI (and you) that an empty value falls back to the post's `title`/`caption`/`description`. Implement the fallback in `publish()`.
- **`capabilities.requiresPublicMediaUrl = true`** if the platform pulls media from a URL; the engine then fails early with a clear message when no public URL can be produced. Otherwise stream with `media.openStream()`; read in bounded chunks, never the whole file into memory.
- **Media items.** `input.media` is the first item; `input.mediaItems` is every item in order. Declare `capabilities.media` (video/image) and `capabilities.maxMediaItems` (default 1). The core and the Publish page use them to refuse unsupported posts with a clear reason before your `validateMedia` (called once per item) ever runs.
- **`publish()` may return `processing`.** Put whatever `getStatus()` needs into `providerState` (JSON-serializable, never credentials). The engine schedules the poll and times out after two hours by default.
- **Throw `ProviderError`** (`ProviderError.retryable(...)` / `ProviderError.permanent(...)`) with a code from `ProviderErrorCode`, a user-readable message and non-sensitive `details`. Anything else that escapes goes through `normalizeError()`; unknown errors are treated as permanent so a bug never retries forever.
- **Progress**: call `ctx.onProgress(0–100)` as often as you like; persistence is throttled.
- **Logging**: `ctx.logger` already carries the job ids. Do not log tokens or full request bodies.
- **Cancellation**: honour `ctx.signal` in long loops if you can.
- Use `requestJson()` from the SDK for JSON/form calls: it applies timeouts and turns transport errors into retryable `ProviderError`s. Use `fetch` directly (via `ctx.fetch ?? fetch`) for binary chunk uploads.

### 3. Implement `OAuthConnector`

```ts
export class AcmeConnector implements OAuthConnector {
  readonly id = 'acme'; // routes: /api/connect/acme/start|callback
  readonly label = 'Acme';
  readonly platforms = ['acme'];
  readonly usesPkce = true;

  getAuthorizationUrl({ state, redirectUri, codeChallenge }) {
    /* build the provider URL */
  }
  async exchangeCode({ code, redirectUri, codeVerifier }, ctx) {
    /* → OAuthTokens */
  }
  async discoverAccounts(tokens, ctx) {
    // Fetch identity; return one ConnectableAccount per publishable account.
    // platformAccountId must be the platform's stable id (uniqueness = platform + id).
  }
}
```

`OAuthFlowService` (packages/auth) handles state generation/validation, PKCE, the callback, the "choose accounts" step and encrypted storage. The connector is only the provider-specific part.

If a platform does not use OAuth (API keys, app passwords like Bluesky), add a small route similar to `POST /api/connect/mock` that builds `ConnectableAccount`s and calls `AccountService.connect()`.

### 4. Register it

In `packages/providers/all/src/index.ts`:

```ts
if (env.ACME_CLIENT_KEY && env.ACME_CLIENT_SECRET) {
  const connector = new AcmeConnector({ ... });
  connectors.register(connector);
  providers.register(new AcmePublisher(connector));
} else {
  unconfigured.push({ platform: 'acme', displayName: 'Acme', reason: 'Set ACME_CLIENT_KEY and ACME_CLIENT_SECRET' });
}
```

Add the variables to `packages/config/src/env.ts` (optional strings, validated in pairs) and to `.env.example`. Add the platform label/icon in `apps/web/src/lib/format.ts` and `components/platform-badge.tsx` (unknown platforms still render with a generic icon).

### 5. Test it

Write unit tests that drive the publisher against a fake `fetch` (see `packages/providers/youtube/src/__tests__` for a resumable-upload fake and `packages/providers/meta/src/__tests__` for Graph API fakes). Cover: a successful publish, progress, at least one retryable and one permanent error mapping, `getStatus` transitions, connector discovery, and every documented media rule in `validateMedia`. The core integration tests already prove the engine behaves for any provider that respects the contract.

### 6. Document it

Add a section to this file and the README: credentials to create, redirect URI, account types supported, review/verification requirements, differences between sandbox and production, rate limits, media rules. Be honest about what is not supported.
