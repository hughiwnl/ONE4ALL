import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, ValidationError } from '../../src/index.js';
import { createHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());
beforeEach(async () => h.reset());

describe('PostService.create', () => {
  it('creates exactly one queued destination and one job per selected account', async () => {
    const user = await h.createUser();
    const a = await h.connectMock(user.id, 'A');
    const b = await h.connectMock(user.id, 'B');
    const c = await h.connectMock(user.id, 'C');
    const mediaId = await h.uploadVideo(user.id);

    const post = await h.services.posts.create(user.id, {
      mediaIds: [mediaId],
      title: 'Hello',
      caption: 'cap',
      destinations: [
        { socialAccountId: a, settings: {} },
        { socialAccountId: c, settings: { behavior: 'fail_permanent' } },
        { socialAccountId: a, settings: {} }, // duplicate selection is ignored
      ],
    });

    expect(post.destinations).toHaveLength(2);
    expect(post.destinations.map((d) => d.socialAccountId).sort()).toEqual([a, c].sort());
    expect(post.destinations.every((d) => d.status === 'queued')).toBe(true);
    expect(post.destinations.find((d) => d.socialAccountId === c)?.settings).toEqual({
      behavior: 'fail_permanent',
    });
    expect(h.dispatcher.publishJobs.map((j) => j.destinationId).sort()).toEqual(
      post.destinations.map((d) => d.id).sort(),
    );
    // account b was not selected: no destination, no job
    expect(post.destinations.some((d) => d.socialAccountId === b)).toBe(false);
    expect(post.destinations.every((d) => d.platform === 'mock')).toBe(true);
  });

  it('rejects a post with zero destinations', async () => {
    const user = await h.createUser();
    const mediaId = await h.uploadVideo(user.id);
    await expect(
      h.services.posts.create(user.id, { mediaIds: [mediaId], destinations: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects disabled accounts with a per-destination message', async () => {
    const user = await h.createUser();
    const a = await h.connectMock(user.id, 'A');
    await h.services.accounts.setEnabled(user.id, a, false);
    const mediaId = await h.uploadVideo(user.id);
    await expect(
      h.services.posts.create(user.id, {
        mediaIds: [mediaId],
        destinations: [{ socialAccountId: a, settings: {} }],
      }),
    ).rejects.toMatchObject({
      name: 'ValidationError',
      details: {
        destinations: [{ socialAccountId: a, message: expect.stringContaining('disabled') }],
      },
    });
    expect(h.dispatcher.publishJobs).toHaveLength(0);
  });

  it("rejects another user's account or media", async () => {
    const owner = await h.createUser();
    const intruder = await h.createUser();
    const ownerAccount = await h.connectMock(owner.id, 'A');
    const ownerMedia = await h.uploadVideo(owner.id);
    const intruderMedia = await h.uploadVideo(intruder.id);
    await expect(
      h.services.posts.create(intruder.id, {
        mediaIds: [intruderMedia],
        destinations: [{ socialAccountId: ownerAccount, settings: {} }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      h.services.posts.create(intruder.id, {
        mediaIds: [ownerMedia],
        destinations: [{ socialAccountId: ownerAccount, settings: {} }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('validates provider-specific settings before creating anything', async () => {
    const user = await h.createUser();
    const a = await h.connectMock(user.id, 'A');
    const mediaId = await h.uploadVideo(user.id);
    await expect(
      h.services.posts.create(user.id, {
        mediaIds: [mediaId],
        destinations: [{ socialAccountId: a, settings: { behavior: 'explode' } }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await h.db.post.count()).toBe(0);
  });
});

describe('PostService reads and retries', () => {
  it("hides other users' posts", async () => {
    const owner = await h.createUser();
    const intruder = await h.createUser();
    const a = await h.connectMock(owner.id, 'A');
    const mediaId = await h.uploadVideo(owner.id);
    const post = await h.services.posts.create(owner.id, {
      mediaIds: [mediaId],
      destinations: [{ socialAccountId: a, settings: {} }],
    });
    await expect(h.services.posts.get(intruder.id, post.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await h.services.posts.list(intruder.id, { limit: 20 })).items).toHaveLength(0);
    expect((await h.services.posts.list(owner.id, { limit: 20 })).items).toHaveLength(1);
  });

  it('retries only the failed destination and leaves published siblings untouched', async () => {
    const user = await h.createUser();
    const good = await h.connectMock(user.id, 'Good');
    const bad = await h.connectMock(user.id, 'Bad', 'fail_permanent');
    const mediaId = await h.uploadVideo(user.id);
    const post = await h.services.posts.create(user.id, {
      mediaIds: [mediaId],
      destinations: [
        { socialAccountId: good, settings: {} },
        { socialAccountId: bad, settings: {} },
      ],
    });
    for (const destination of post.destinations) {
      await h.services.engine.publishDestination(destination.id, {
        jobId: `j-${destination.id}`,
        attempt: 1,
        maxAttempts: 1,
      });
    }
    const afterRun = await h.services.posts.get(user.id, post.id);
    const goodDest = afterRun.destinations.find((d) => d.socialAccountId === good)!;
    const badDest = afterRun.destinations.find((d) => d.socialAccountId === bad)!;
    expect(goodDest.status).toBe('published');
    expect(badDest.status).toBe('failed');

    await expect(
      h.services.posts.retryDestination(user.id, post.id, goodDest.id),
    ).rejects.toBeInstanceOf(ValidationError);

    h.dispatcher.reset();
    const retried = await h.services.posts.retryDestination(user.id, post.id, badDest.id);
    expect(retried.status).toBe('queued');
    expect(retried.errorMessage).toBeNull();
    expect(h.dispatcher.publishJobs.map((j) => j.destinationId)).toEqual([badDest.id]);

    const afterRetry = await h.services.posts.get(user.id, post.id);
    expect(afterRetry.destinations.find((d) => d.id === goodDest.id)?.status).toBe('published');
    expect(afterRetry.destinations.find((d) => d.id === goodDest.id)?.platformPostId).toBe(
      goodDest.platformPostId,
    );
  });

  it("refuses to retry another user's destination", async () => {
    const owner = await h.createUser();
    const intruder = await h.createUser();
    const bad = await h.connectMock(owner.id, 'Bad', 'fail_permanent');
    const mediaId = await h.uploadVideo(owner.id);
    const post = await h.services.posts.create(owner.id, {
      mediaIds: [mediaId],
      destinations: [{ socialAccountId: bad, settings: {} }],
    });
    await h.services.engine.publishDestination(post.destinations[0]!.id, {
      jobId: 'j',
      attempt: 1,
      maxAttempts: 1,
    });
    await expect(
      h.services.posts.retryDestination(intruder.id, post.id, post.destinations[0]!.id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('cancels queued destinations and removes their job', async () => {
    const user = await h.createUser();
    const a = await h.connectMock(user.id, 'A');
    const mediaId = await h.uploadVideo(user.id);
    const post = await h.services.posts.create(user.id, {
      mediaIds: [mediaId],
      destinations: [{ socialAccountId: a, settings: {} }],
    });
    const canceled = await h.services.posts.cancelDestination(
      user.id,
      post.id,
      post.destinations[0]!.id,
    );
    expect(canceled.status).toBe('canceled');
    expect(h.dispatcher.canceled).toEqual([h.dispatcher.publishJobs[0]!.jobId]);
    // the worker skips canceled destinations even if the job still runs
    const outcome = await h.services.engine.publishDestination(post.destinations[0]!.id, {
      jobId: 'late',
      attempt: 1,
    });
    expect(outcome.outcome).toBe('skipped');
  });

  it('summarizes destination statuses in history', async () => {
    const user = await h.createUser();
    const good = await h.connectMock(user.id, 'Good');
    const bad = await h.connectMock(user.id, 'Bad', 'fail_permanent');
    const mediaId = await h.uploadVideo(user.id);
    const post = await h.services.posts.create(user.id, {
      mediaIds: [mediaId],
      title: 'Summer Launch',
      destinations: [
        { socialAccountId: good, settings: {} },
        { socialAccountId: bad, settings: {} },
      ],
    });
    for (const destination of post.destinations) {
      await h.services.engine.publishDestination(destination.id, {
        jobId: 'j',
        attempt: 1,
        maxAttempts: 1,
      });
    }
    const { items } = await h.services.posts.list(user.id, { limit: 10 });
    expect(items[0]).toMatchObject({
      title: 'Summer Launch',
      summary: { total: 2, published: 1, failed: 1, queued: 0 },
    });
  });
});
