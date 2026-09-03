/**
 * The sidebar's own controls, with a real pointer.
 *
 * The unit tests own the state machine; what only a browser can show is that
 * the peek is driven by an actual cursor resting on the rail — that it does NOT
 * open under a pointer merely passing through, that it opens once the delay is
 * up, and that it shuts again the moment the pointer goes elsewhere. Focus is
 * checked as the keyboard's way in — past the brand mark, which is deliberately
 * the one thing that does not peek — and the pin as the escape from all of it,
 * across a reload too.
 *
 * Requires the live stack (see playwright.config.ts).
 */
import { expect, test } from '@playwright/test';

/** Comfortably inside the page, far from the sidebar. */
const AWAY = { x: 900, y: 400 };
/**
 * A stay too short to count as resting — long enough to be a real pause, short
 * enough that the rail must still be shut when it ends.
 *
 * It has to stay well under `PEEK_DELAY_MS` (500ms, `Layout.tsx`), and the two
 * are not linked in code: importing the constant here would drag the browser
 * bundle into a Node-side spec, so this is kept a fraction of it by hand.
 * **Shorten the peek delay again and this has to come down with it** — it was
 * 700ms against a 1500ms delay, which would have silently started asserting the
 * opposite of what it means.
 */
const PASSING_THROUGH_MS = 200;

test('sidebar: collapses from inside itself, peeks on a resting pointer, and pins open', async ({ page }) => {
  const email = `e2e-sidebar-${Date.now()}@prisms.test`;
  await page.goto('/');
  await page.getByRole('link', { name: 'Register' }).click();
  await page.locator('input[autocomplete="name"]').fill('Sidebar User');
  await page.getByTestId('email').fill(email);
  await page.getByTestId('password').fill('e2e-password-123');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('sync-state')).toBeVisible();

  const sidebar = page.locator('.px-sidebar');
  const toggle = page.getByTestId('sidebar-toggle');
  const pin = page.getByTestId('sidebar-pin');

  // --- the control lives in the sidebar, not the topbar ------------------
  await expect(sidebar.getByTestId('sidebar-toggle')).toBeVisible();
  await expect(page.locator('.px-topbar').getByTestId('sidebar-toggle')).toHaveCount(0);
  await expect(sidebar).toHaveAttribute('data-state', 'open');

  // --- collapse: the rail keeps only the brand mark ----------------------
  await toggle.click();
  await expect(sidebar).toHaveAttribute('data-state', 'rail');
  await expect(toggle).toHaveCount(0); // the chevron goes; the mark takes over
  await expect(pin).toHaveCount(0);
  await expect(page.getByTestId('brand-expand')).toBeVisible();

  // --- a pointer passing through must not open it ------------------------
  await sidebar.hover();
  await page.waitForTimeout(PASSING_THROUGH_MS);
  await expect(sidebar).toHaveAttribute('data-state', 'rail');

  // --- …but resting there does, once the delay is up ---------------------
  await expect(sidebar).toHaveAttribute('data-state', 'peek', { timeout: 5000 });
  await expect(pin).toBeVisible();

  // --- and it takes itself back when the pointer leaves ------------------
  await page.mouse.move(AWAY.x, AWAY.y);
  await expect(sidebar).toHaveAttribute('data-state', 'rail');

  // --- the keyboard's way in ---------------------------------------------
  // A real Tab first: a focus only counts as a keyboard arrival while the
  // keyboard is actually driving, so the press is what arms it. Which element
  // that press lands on is not this test's business — it is tab order, and
  // asserting it made this spec fail the moment the shell grew a control — so
  // focus is then put where the assertion means it.
  await page.keyboard.press('Tab');
  await page.getByTestId('nav-agenda').focus();
  await expect(sidebar).toHaveAttribute('data-state', 'peek'); // at once, no pointer wait
  expect(await sidebar.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(sidebar).toHaveAttribute('data-state', 'rail');

  // --- the brand mark is the exception: focus must NOT open it -----------
  // It is the rail's explicit way open, so it does not also peek. If it did,
  // landing on it would open the sidebar, which swaps the button for a link —
  // unmounting the element holding focus and shutting the rail again under a
  // keyboard that had just arrived.
  await page.getByTestId('brand-expand').focus();
  await expect(sidebar).toHaveAttribute('data-state', 'rail');
  await expect(page.getByTestId('brand-expand')).toBeFocused(); // …still there to press

  // --- …and pressing it opens it, for a pointer or a keyboard ------------
  await page.getByTestId('brand-expand').click();
  await expect(sidebar).toHaveAttribute('data-state', 'open');
  await expect(page.getByTestId('brand-home')).toBeVisible(); // now it means home
  await toggle.click(); // back to the rail for the pin checks below
  await expect(sidebar).toHaveAttribute('data-state', 'rail');

  // --- pin the next peek open -------------------------------------------
  await sidebar.hover();
  await expect(sidebar).toHaveAttribute('data-state', 'peek', { timeout: 5000 });
  await pin.click();
  await page.mouse.move(AWAY.x, AWAY.y);
  await expect(sidebar).toHaveAttribute('data-state', 'open'); // walking away no longer shuts it
  await expect(sidebar).toHaveAttribute('data-pinned', 'true');
  await expect(toggle).toBeDisabled(); // the pin outranks the button

  // --- the pin survives a reload, and releases the old preference --------
  await page.reload();
  await expect(sidebar).toHaveAttribute('data-state', 'open');
  await page.getByTestId('sidebar-pin').click();
  await expect(sidebar).toHaveAttribute('data-state', 'rail'); // back to the collapse it was hiding
});
