/**
 * The sidebar nav in a window too short for it: it still scrolls, but never
 * draws a scroll bar — it fades the edge that has more behind it instead.
 *
 * Its own file because Playwright's headless Chromium launches with
 * --hide-scrollbars, which would make a "no scroll bar" check pass whether or not
 * anything hides one; turning the flag off has to happen at the top level of a
 * spec (it forces a new browser), so real, classic scroll bars are drawn here.
 * The test also proves, in the same run, that its detector can see one.
 *
 * Requires the live stack (see playwright.config.ts).
 */
import { expect, test } from '@playwright/test';

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

test('the nav scrolls without drawing a scroll bar, and fades the edge that has more', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('Sidebar Scroll User');
  await page.getByTestId('email').fill(`e2e-sidebar-scroll-${Date.now()}@prisms.test`);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible({ timeout: 30_000 });

  await page.setViewportSize({ width: 1280, height: 300 }); // far too short for the whole nav
  const nav = page.locator('.px-nav');
  await expect(nav).toBeVisible();
  const barWidth = () => nav.evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth);
  const fade = () =>
    nav.evaluate((el) => ({
      top: (el as HTMLElement).style.getPropertyValue('--px-fade-top'),
      bot: (el as HTMLElement).style.getPropertyValue('--px-fade-bot'),
    }));

  // it genuinely overflows — this is the case that used to draw a bar…
  expect(await nav.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(20);
  // …and now draws none
  expect(await barWidth()).toBe(0);

  // CONTROL: the same nav with the rule overridden away DOES show a bar here, so
  // the zero above is a real measurement and not a headless artefact.
  const control = await page.addStyleTag({
    content: '.px-nav{scrollbar-width:auto!important}.px-nav::-webkit-scrollbar{display:block!important}',
  });
  expect(await barWidth()).toBeGreaterThan(5);
  await control.evaluate((el) => el.remove());
  expect(await barWidth()).toBe(0);

  // still scrollable, by wheel, and the fade says which way there is more
  await expect.poll(fade).toEqual({ top: '0px', bot: '44px' }); // at the top: more below
  await nav.hover();
  await page.mouse.wheel(0, 2000);
  await expect.poll(() => nav.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect.poll(fade).toEqual({ top: '44px', bot: '0px' }); // at the bottom: more above
  // the foot (the user, sign out) stays on screen the whole time
  await expect(page.getByTestId('sign-out')).toBeInViewport();
});