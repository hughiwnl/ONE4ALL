import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '../../src/index.js';
import { createHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());
beforeEach(async () => h.reset());

describe('AccountService', () => {
  it('lets one user connect many accounts on the same platform', async () => {
    const user = await h.createUser();
    await h.connectMock(user.id, 'Main Channel');
    await h.connectMock(user.id, 'Clips Channel');
    await h.connectMock(user.id, 'Gaming Channel');
    const accounts = await h.services.accounts.list(user.id);
    expect(accounts.map((a) => a.displayName)).toEqual([
      'Main Channel',
      'Clips Channel',
      'Gaming Channel',
    ]);
    expect(accounts.every((a) => a.platform === 'mock')).toBe(true);
  });

  it('reconnecting the same platform identity updates the row instead of duplicating it', async () => {
    const user = await h.createUser();
    const first = await h.connectMock(user.id, 'Main Channel');
    const second = await h.connectMock(user.id, 'Main Channel');
    expect(second).toBe(first);
    expect(await h.services.accounts.list(user.id)).toHaveLength(1);
  });

  it('the same platform identity can be connected by two different users', async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    await h.connectMock(a.id, 'Shared');
    await h.connectMock(b.id, 'Shared');
    expect(await h.services.accounts.list(a.id)).toHaveLength(1);
    expect(await h.services.accounts.list(b.id)).toHaveLength(1);
  });

  it('never exposes tokens through the DTO and stores them encrypted', async () => {
    const user = await h.createUser();
    const id = await h.connectMock(user.id, 'Main');
    const dto = await h.services.accounts.get(user.id, id);
    expect(JSON.stringify(dto)).not.toContain('token-Main');
    const row = await h.db.socialAccount.findUniqueOrThrow({ where: { id } });
    expect(row.accessTokenEncrypted).not.toContain('token-Main');
    expect(row.accessTokenEncrypted.startsWith('v1.')).toBe(true);
    const provider = await h.services.accounts.getProviderAccount(id);
    expect(provider?.credentials.accessToken).toBe('token-Main');
  });

  it('enables and disables accounts without deleting them', async () => {
    const user = await h.createUser();
    const id = await h.connectMock(user.id, 'Main');
    expect((await h.services.accounts.setEnabled(user.id, id, false)).enabled).toBe(false);
    expect(await h.services.accounts.list(user.id, { enabledOnly: true })).toHaveLength(0);
    expect(await h.services.accounts.list(user.id)).toHaveLength(1);
    expect((await h.services.accounts.setEnabled(user.id, id, true)).enabled).toBe(true);
  });

  it("refuses to read, toggle or disconnect another user's account", async () => {
    const owner = await h.createUser();
    const intruder = await h.createUser();
    const id = await h.connectMock(owner.id, 'Main');
    await expect(h.services.accounts.get(intruder.id, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(h.services.accounts.setEnabled(intruder.id, id, false)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(h.services.accounts.disconnect(intruder.id, id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await h.services.accounts.list(intruder.id)).toHaveLength(0);
    expect((await h.services.accounts.get(owner.id, id)).enabled).toBe(true);
  });

  it('disconnecting keeps publishing history with a snapshot of the account name', async () => {
    const user = await h.createUser();
    const id = await h.connectMock(user.id, 'Main');
    const mediaId = await h.uploadVideo(user.id);
    const post = await h.services.posts.create(user.id, {
      mediaIds: [mediaId],
      destinations: [{ socialAccountId: id, settings: {} }],
    });
    await h.services.accounts.disconnect(user.id, id);
    const after = await h.services.posts.get(user.id, post.id);
    expect(after.destinations[0]).toMatchObject({
      socialAccountId: null,
      accountDisplayName: 'Main',
      platform: 'mock',
    });
  });
});
