import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError, ValidationError } from '../../src/index.js';
import { createHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());
beforeEach(async () => h.reset());

describe('image uploads', () => {
  it('stores JPEG and PNG images as image media without a duration', async () => {
    const user = await h.createUser();
    const jpegId = await h.uploadImage(user.id, 'shoe.jpg');
    const pngId = await h.uploadImage(user.id, 'logo.png', 'image/png');
    expect(await h.services.media.get(user.id, jpegId)).toMatchObject({
      kind: 'image',
      mimeType: 'image/jpeg',
      durationSeconds: null,
    });
    expect(await h.services.media.get(user.id, pngId)).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
    });
  });
});

describe('posts with several media items', () => {
  it('stores a carousel in order and publishes every item through the provider', async () => {
    const user = await h.createUser();
    const account = await h.connectMock(user.id, 'Brand');
    const first = await h.uploadImage(user.id, 'one.jpg');
    const second = await h.uploadVideo(user.id, 'two.mp4');
    const third = await h.uploadImage(user.id, 'three.jpg');

    const post = await h.services.posts.create(user.id, {
      mediaIds: [third, first, second],
      caption: 'drop',
      destinations: [{ socialAccountId: account, settings: {} }],
    });
    expect(post.mediaItems.map((m) => m.filename)).toEqual(['three.jpg', 'one.jpg', 'two.mp4']);
    expect(post.media.filename).toBe('three.jpg');

    const spy = vi.spyOn(h.mock, 'publish');
    const outcome = await h.services.engine.publishDestination(post.destinations[0]!.id, {
      jobId: 'j',
      attempt: 1,
    });
    expect(outcome.outcome).toBe('published');
    const input = spy.mock.calls[0]![0];
    expect(input.mediaItems.map((m) => m.filename)).toEqual(['three.jpg', 'one.jpg', 'two.mp4']);
    expect(input.media.filename).toBe('three.jpg');
    spy.mockRestore();

    const { items } = await h.services.posts.list(user.id, { limit: 10 });
    expect(items[0]).toMatchObject({ mediaCount: 3, media: { filename: 'three.jpg' } });
  });

  it('rejects destinations whose platform cannot take the media, per account', async () => {
    const user = await h.createUser();
    const carouselAccount = await h.connectMock(user.id, 'Brand');
    const videoOnly = await h.connectVideoOnly(user.id, 'Main Channel');
    const image = await h.uploadImage(user.id);

    await expect(
      h.services.posts.create(user.id, {
        mediaIds: [image],
        destinations: [
          { socialAccountId: carouselAccount, settings: {} },
          { socialAccountId: videoOnly, settings: {} },
        ],
      }),
    ).rejects.toMatchObject({
      name: 'ValidationError',
      details: {
        destinations: [
          {
            socialAccountId: videoOnly,
            message: 'Main Channel: VideoOnly does not support image posts in Repeat',
          },
        ],
      },
    });

    const v1 = await h.uploadVideo(user.id, 'a.mp4');
    const v2 = await h.uploadVideo(user.id, 'b.mp4');
    await expect(
      h.services.posts.create(user.id, {
        mediaIds: [v1, v2],
        destinations: [{ socialAccountId: videoOnly, settings: {} }],
      }),
    ).rejects.toMatchObject({
      details: { destinations: [{ message: expect.stringContaining('single video per post') }] },
    });
    expect(await h.db.post.count()).toBe(0);
  });

  it('still accepts single-video posts on video-only platforms', async () => {
    const user = await h.createUser();
    const videoOnly = await h.connectVideoOnly(user.id, 'Main Channel');
    const video = await h.uploadVideo(user.id);
    const post = await h.services.posts.create(user.id, {
      mediaIds: [video],
      destinations: [{ socialAccountId: videoOnly, settings: {} }],
    });
    expect(post.destinations).toHaveLength(1);
  });

  it("refuses duplicate items and other users' media", async () => {
    const user = await h.createUser();
    const other = await h.createUser();
    const account = await h.connectMock(user.id, 'Brand');
    const image = await h.uploadImage(user.id);
    const foreign = await h.uploadImage(other.id);
    await expect(
      h.services.posts.create(user.id, {
        mediaIds: [image, image],
        destinations: [{ socialAccountId: account, settings: {} }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      h.services.posts.create(user.id, {
        mediaIds: [image, foreign],
        destinations: [{ socialAccountId: account, settings: {} }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('does not let media used by a post be deleted', async () => {
    const user = await h.createUser();
    const account = await h.connectMock(user.id, 'Brand');
    const a = await h.uploadImage(user.id, 'a.jpg');
    const b = await h.uploadImage(user.id, 'b.jpg');
    await h.services.posts.create(user.id, {
      mediaIds: [a, b],
      destinations: [{ socialAccountId: account, settings: {} }],
    });
    await expect(h.services.media.delete(user.id, b)).rejects.toBeInstanceOf(ValidationError);
  });
});
