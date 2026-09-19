import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());
beforeEach(async () => h.reset());

async function setupPost(behaviors: string[]) {
  const user = await h.createUser();
  const accountIds: string[] = [];
  for (const [index, behavior] of behaviors.entries()) {
    accountIds.push(await h.connectMock(user.id, `Account ${index}`, behavior));
  }
  const mediaId = await h.uploadVideo(user.id);
  const post = await h.services.posts.create(user.id, {
    mediaIds: [mediaId],
    title: 'T',
    destinations: accountIds.map((socialAccountId) => ({ socialAccountId, settings: {} })),
  });
  return { user, post, accountIds };
}

describe('PublishingEngine', () => {
  it('publishes a destination and records platform id, url and timestamps', async () => {
    const { user, post } = await setupPost(['succeed']);
    const destination = post.destinations[0]!;
    const outcome = await h.services.engine.publishDestination(destination.id, {
      jobId: 'job-1',
      attempt: 1,
    });
    expect(outcome.outcome).toBe('published');
    const result = (await h.services.posts.get(user.id, post.id)).destinations[0]!;
    expect(result).toMatchObject({
      status: 'published',
      attempts: 1,
      progress: null,
      errorCode: null,
    });
    expect(result.platformPostId).toMatch(/^mock_/);
    expect(result.platformPostUrl).toContain(result.platformPostId);
    expect(result.publishedAt).not.toBeNull();
    expect(result.startedAt).not.toBeNull();
  });

  it('one failing destination does not affect its siblings', async () => {
    const { user, post } = await setupPost(['succeed', 'fail_permanent', 'succeed']);
    const outcomes = await Promise.allSettled(
      post.destinations.map((d) =>
        h.services.engine.publishDestination(d.id, { jobId: `job-${d.id}`, attempt: 1 }),
      ),
    );
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    const result = await h.services.posts.get(user.id, post.id);
    const statusByAccount = new Map(
      result.destinations.map((d) => [d.accountDisplayName, d.status]),
    );
    expect(statusByAccount.get('Account 0')).toBe('published');
    expect(statusByAccount.get('Account 1')).toBe('failed');
    expect(statusByAccount.get('Account 2')).toBe('published');
  });

  it('marks permanent failures as failed with the provider error and no retry', async () => {
    const { user, post } = await setupPost(['fail_permanent']);
    const outcome = await h.services.engine.publishDestination(post.destinations[0]!.id, {
      jobId: 'j',
      attempt: 1,
      maxAttempts: 5,
    });
    expect(outcome.outcome).toBe('failed');
    const result = (await h.services.posts.get(user.id, post.id)).destinations[0]!;
    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'token_expired',
      errorRetryable: false,
      attempts: 1,
    });
    expect(result.errorMessage).toContain('token expired');
  });

  it('asks the queue to retry transient failures, then fails once attempts are exhausted', async () => {
    const { user, post } = await setupPost(['fail_retryable']);
    const id = post.destinations[0]!.id;
    const first = await h.services.engine.publishDestination(id, {
      jobId: 'j',
      attempt: 1,
      maxAttempts: 3,
    });
    expect(first.outcome).toBe('retry');
    let result = (await h.services.posts.get(user.id, post.id)).destinations[0]!;
    expect(result).toMatchObject({
      status: 'queued',
      errorCode: 'provider_unavailable',
      errorRetryable: true,
      attempts: 1,
    });
    expect(result.errorMessage).toContain('retrying');

    await h.services.engine.publishDestination(id, { jobId: 'j', attempt: 2, maxAttempts: 3 });
    const last = await h.services.engine.publishDestination(id, {
      jobId: 'j',
      attempt: 3,
      maxAttempts: 3,
    });
    expect(last.outcome).toBe('failed');
    result = (await h.services.posts.get(user.id, post.id)).destinations[0]!;
    expect(result).toMatchObject({ status: 'failed', attempts: 3, errorRetryable: true });
  });

  it('succeeds on a later attempt for flaky providers', async () => {
    const { user, post } = await setupPost(['flaky']);
    const id = post.destinations[0]!.id;
    expect(
      (await h.services.engine.publishDestination(id, { jobId: 'j', attempt: 1 })).outcome,
    ).toBe('retry');
    expect(
      (await h.services.engine.publishDestination(id, { jobId: 'j', attempt: 2 })).outcome,
    ).toBe('published');
    expect((await h.services.posts.get(user.id, post.id)).destinations[0]!.attempts).toBe(2);
  });

  it('tracks asynchronous processing through status checks until published', async () => {
    const { user, post } = await setupPost(['succeed_after_processing']);
    const id = post.destinations[0]!.id;
    const outcome = await h.services.engine.publishDestination(id, { jobId: 'j', attempt: 1 });
    expect(outcome.outcome).toBe('processing');
    expect((await h.services.posts.get(user.id, post.id)).destinations[0]!.status).toBe(
      'processing',
    );
    expect(h.dispatcher.statusJobs).toHaveLength(1);

    const check1 = await h.services.engine.checkDestinationStatus(id, { jobId: 's1', attempt: 1 });
    expect(check1.outcome).toBe('processing');
    expect(h.dispatcher.statusJobs).toHaveLength(2);

    const check2 = await h.services.engine.checkDestinationStatus(id, { jobId: 's2', attempt: 1 });
    expect(check2.outcome).toBe('published');
    const result = (await h.services.posts.get(user.id, post.id)).destinations[0]!;
    expect(result.status).toBe('published');
    expect(result.publishedAt).not.toBeNull();
  });

  it('persists refreshed credentials returned by the provider', async () => {
    const user = await h.createUser();
    const [created] = (
      await h.services.accounts.connect(user.id, [
        {
          platform: 'mock',
          platformAccountId: 'expiring',
          displayName: 'Expiring',
          username: null,
          avatarUrl: null,
          credentials: {
            accessToken: 'old-token',
            refreshToken: 'refresh',
            expiresAt: new Date(Date.now() - 1000),
            scopes: [],
          },
          metadata: { behavior: 'succeed' },
        },
      ])
    ).created;
    const mediaId = await h.uploadVideo(user.id);
    const post = await h.services.posts.create(user.id, {
      mediaIds: [mediaId],
      destinations: [{ socialAccountId: created!.id, settings: {} }],
    });
    await h.services.engine.publishDestination(post.destinations[0]!.id, {
      jobId: 'j',
      attempt: 1,
    });
    const account = await h.services.accounts.getProviderAccount(created!.id);
    expect(account?.credentials.accessToken).toMatch(/^mock-refreshed-/);
    expect(account?.credentials.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('fails a destination whose account was disconnected before it ran', async () => {
    const { user, post, accountIds } = await setupPost(['succeed']);
    await h.services.accounts.disconnect(user.id, accountIds[0]!);
    const outcome = await h.services.engine.publishDestination(post.destinations[0]!.id, {
      jobId: 'j',
      attempt: 1,
    });
    expect(outcome.outcome).toBe('failed');
    expect((await h.services.posts.get(user.id, post.id)).destinations[0]!).toMatchObject({
      status: 'failed',
      errorCode: 'account_disconnected',
    });
  });

  it('is idempotent: re-running a published destination is a no-op', async () => {
    const { post } = await setupPost(['succeed']);
    const id = post.destinations[0]!.id;
    await h.services.engine.publishDestination(id, { jobId: 'j', attempt: 1 });
    const again = await h.services.engine.publishDestination(id, { jobId: 'j2', attempt: 1 });
    expect(again.outcome).toBe('skipped');
  });
});
