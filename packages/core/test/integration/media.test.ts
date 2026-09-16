import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, PayloadTooLargeError, ValidationError } from '../../src/index.js';
import { createHarness, fakeMp4, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());
beforeEach(async () => h.reset());

describe('MediaService', () => {
  it('stores a valid upload and records its metadata', async () => {
    const user = await h.createUser();
    const media = await h.services.media.createFromStream({
      userId: user.id,
      filename: '../../My Clip.MP4',
      mimeType: 'video/mp4',
      stream: Readable.from([fakeMp4(10_000)]),
    });
    expect(media).toMatchObject({
      filename: 'My Clip.MP4',
      mimeType: 'video/mp4',
      sizeBytes: 10_000,
    });
    const row = await h.db.media.findUniqueOrThrow({ where: { id: media.id } });
    expect(row.storageKey).toBe(`${user.id}/${row.storageKey.split('/')[1]}`);
    expect(row.storageKey.endsWith('.mp4')).toBe(true);
    expect(await h.storage.head(row.storageKey)).toMatchObject({ sizeBytes: 10_000 });
  });

  it('rejects unsupported types and mismatched extensions without storing anything', async () => {
    const user = await h.createUser();
    await expect(
      h.services.media.createFromStream({
        userId: user.id,
        filename: 'x.mp4',
        mimeType: 'application/pdf',
        stream: Readable.from([fakeMp4()]),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      h.services.media.createFromStream({
        userId: user.id,
        filename: 'x.exe',
        mimeType: 'video/mp4',
        stream: Readable.from([fakeMp4()]),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await h.db.media.count()).toBe(0);
  });

  it('rejects files whose bytes do not match the declared type', async () => {
    const user = await h.createUser();
    const fakeExe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4000, 1)]);
    await expect(
      h.services.media.createFromStream({
        userId: user.id,
        filename: 'x.mp4',
        mimeType: 'video/mp4',
        stream: Readable.from([fakeExe]),
      }),
    ).rejects.toMatchObject({
      name: 'ValidationError',
      message: expect.stringContaining('does not look like'),
    });
    expect(await h.db.media.count()).toBe(0);
  });

  it('rejects uploads over the configured limit even without Content-Length', async () => {
    const user = await h.createUser();
    const tooBig = fakeMp4(1.5 * 1024 * 1024); // MAX_UPLOAD_SIZE_MB=1 in the harness
    await expect(
      h.services.media.createFromStream({
        userId: user.id,
        filename: 'big.mp4',
        mimeType: 'video/mp4',
        stream: Readable.from([tooBig]),
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    await expect(
      h.services.media.createFromStream({
        userId: user.id,
        filename: 'big.mp4',
        mimeType: 'video/mp4',
        declaredSizeBytes: 5 * 1024 * 1024,
        stream: Readable.from([fakeMp4()]),
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(await h.db.media.count()).toBe(0);
  });

  it("does not expose another user's media", async () => {
    const owner = await h.createUser();
    const intruder = await h.createUser();
    const id = await h.uploadVideo(owner.id);
    await expect(h.services.media.get(intruder.id, id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await h.services.media.get(owner.id, id)).id).toBe(id);
  });
});
