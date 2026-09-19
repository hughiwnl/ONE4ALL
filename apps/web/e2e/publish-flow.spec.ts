import { expect, test, type Page } from '@playwright/test';

/**
 * The critical path, end to end through the real UI:
 * register → connect mock accounts → toggle one off → upload → select → publish
 * → watch statuses settle → retry the failed destination → see it in history.
 */

const password = 'e2e-password-123';

async function registerFreshUser(page: Page): Promise<string> {
  const email = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  await page.goto('/register');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  return email;
}

/** A minimal file that passes the server's MP4 header sniff. */
const fakeMp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypisom'),
  Buffer.alloc(8),
  Buffer.alloc(64 * 1024, 7),
]);

async function addMockAccount(page: Page, name: string, behavior: string) {
  await page.getByRole('button', { name: 'Add mock account' }).click();
  await page.getByLabel('Account name').fill(name);
  await page.getByLabel('Simulated outcome').selectOption(behavior);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText(`Connected ${name}.`)).toBeVisible();
}

test('publishes one video to several accounts with independent outcomes', async ({ page }) => {
  await registerFreshUser(page);

  // Connect three mock accounts on the same platform
  await page.goto('/accounts');
  await addMockAccount(page, 'Main Channel', 'succeed');
  await addMockAccount(page, 'Clips Channel', 'succeed_after_processing');
  await addMockAccount(page, 'Broken Page', 'fail_permanent');
  await addMockAccount(page, 'Hidden Account', 'succeed');
  await expect(page.getByText('4 accounts')).toBeVisible();

  // Disable one account: it must disappear from the publish page
  await page.getByLabel('Disable Hidden Account').click();
  await expect(page.getByLabel('Enable Hidden Account')).toBeVisible();

  // Publish page: upload, details, select
  await page.goto('/publish');
  await expect(page.getByText('Hidden Account')).toHaveCount(0);
  await page
    .getByLabel('Choose media files')
    .setInputFiles({ name: 'e2e clip.mp4', mimeType: 'video/mp4', buffer: fakeMp4 });
  await expect(page.getByText('e2e clip.mp4')).toBeVisible();
  await page.getByLabel('Title').fill('E2E launch');
  await page.getByLabel('Caption').fill('hello from playwright');

  const publishButton = page.getByRole('button', { name: /Publish to \d+ accounts?/ });
  await expect(publishButton).toBeDisabled();
  await page.getByLabel('Select all Mock accounts').click();
  await expect(publishButton).toHaveText('Publish to 3 accounts');
  await publishButton.click();

  // Status page: every destination reaches its own terminal state
  await expect(page).toHaveURL(/\/posts\//);
  await expect(page.getByText('Publishing e2e clip.mp4 to 3 destinations')).toBeVisible();
  const rows = page.locator('li', {
    has: page.getByText(/Main Channel|Clips Channel|Broken Page/),
  });
  await expect(rows).toHaveCount(3);
  await expect(
    page.locator('li', { hasText: 'Main Channel' }).getByText('Published', { exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    page.locator('li', { hasText: 'Clips Channel' }).getByText('Published', { exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    page.locator('li', { hasText: 'Broken Page' }).getByText('Failed', { exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Simulated permanent failure: token expired')).toBeVisible();
  await expect(page.getByRole('link', { name: /View post/ })).toHaveCount(2);

  // Retry only the failed destination; the published ones keep their state
  await page
    .locator('li', { hasText: 'Broken Page' })
    .getByRole('button', { name: 'Retry' })
    .click();
  await expect(page.locator('li', { hasText: 'Broken Page' }).getByText('2 attempts')).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.locator('li', { hasText: 'Main Channel' }).getByText(/^1 attempt ·/),
  ).toBeVisible();

  // History shows the summary
  await page.goto('/history');
  const entry = page.getByRole('link', { name: /E2E launch/ });
  await expect(entry).toBeVisible();
  await expect(entry.getByText('2 published')).toBeVisible();
  await expect(entry.getByText('1 failed')).toBeVisible();
});

test('rejects invalid uploads and unauthenticated access', async ({ page, request }) => {
  const anonymous = await request.get('/api/accounts');
  expect(anonymous.status()).toBe(401);

  const email = await registerFreshUser(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto('/publish');
  await page.getByLabel('Choose media files').setInputFiles({
    name: 'not-a-video.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from('MZ' + 'x'.repeat(5000)),
  });
  await expect(page.getByText(/does not look like video\/mp4/)).toBeVisible();
});

test('publishes an image carousel', async ({ page }) => {
  await registerFreshUser(page);
  await page.goto('/accounts');
  await addMockAccount(page, 'Brand Account', 'succeed_after_processing');

  const jpeg = (fill: number) =>
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4096, fill)]);
  await page.goto('/publish');
  await page.getByLabel('Choose media files').setInputFiles([
    { name: 'first.jpg', mimeType: 'image/jpeg', buffer: jpeg(1) },
    { name: 'second.jpg', mimeType: 'image/jpeg', buffer: jpeg(2) },
  ]);
  await expect(page.getByText('Posting a carousel of 2')).toBeVisible();

  // Reorder: second becomes first
  await page.getByRole('button', { name: 'Move second.jpg earlier' }).click();
  const order = page.getByRole('list', { name: 'Media in publishing order' }).getByRole('listitem');
  await expect(order.first()).toContainText('second.jpg');

  await page.getByLabel('Caption', { exact: true }).first().fill('carousel from playwright');
  await page.getByLabel('Select all Mock accounts').click();
  await page.getByRole('button', { name: 'Publish to 1 account' }).click();

  await expect(page).toHaveURL(/\/posts\//);
  await expect(page.getByText('Publishing a carousel of 2 items to 1 destination')).toBeVisible();
  await expect(page.getByText('Carousel · 2 items')).toBeVisible();
  await expect(
    page.locator('li', { hasText: 'Brand Account' }).getByText('Published', { exact: true }),
  ).toBeVisible({ timeout: 60_000 });
});
