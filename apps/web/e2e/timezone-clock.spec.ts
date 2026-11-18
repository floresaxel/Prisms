/**
 * The topbar clock: no icon, hover names the zone, click changes it, and the
 * change is the same value Settings shows. Requires the live stack.
 */
import { expect, test } from '@playwright/test';

test('timezone clock: hover names the zone, click changes it, Settings agrees', async ({ page }) => {
  const email = `e2e-tzclock-${Date.now()}@prisms.test`;
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('Clock User');
  await page.getByTestId('email').fill(email);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();

  const clock = page.getByTestId('now-clock');
  await expect(clock).toBeVisible();
  // no clock glyph next to the time
  await expect(clock.locator('svg')).toHaveCount(0);
  await expect(clock).toHaveText(/^\d{2}:\d{2}$/);

  // hover text says where the clock is set to (a fresh account defaults to New York)
  await expect(clock).toHaveAttribute('title', /New York, America.*\(America\/New_York\)/);

  // click → pick another zone
  await clock.click();
  await page.getByTestId('tz-search').fill('tokyo');
  await page.getByTestId('tz-opt-Asia/Tokyo').click();
  await expect(page.getByTestId('tz-popover')).toHaveCount(0);
  await expect(clock).toHaveAttribute('title', /Tokyo, Asia.*\(Asia\/Tokyo\)/);

  // the same value is in Settings
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-tz')).toHaveValue('Asia/Tokyo');

  // and Settings can change it back; junk is refused
  await page.getByTestId('settings-tz').fill('Mars/Olympus');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-tz-error')).toBeVisible();
  await page.getByTestId('settings-tz').fill('Europe/Paris');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-saved')).toBeVisible();
  await expect(clock).toHaveAttribute('title', /Paris, Europe.*\(Europe\/Paris\)/);
});
