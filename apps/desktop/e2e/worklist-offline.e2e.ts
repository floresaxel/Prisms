/* eslint-disable */
/**
 * S22 DoD flow (WebdriverIO + tauri-driver) — the S16 offline worklist loop in
 * the packaged desktop window, plus an OS-notification check.
 *
 * UNRUN in this build environment (no Rust/Tauri toolchain). Run on a machine
 * with the toolchain:
 *   1. pnpm --filter @prisms/desktop build   # produces a debug/release binary
 *   2. tauri-driver &                         # WebDriver bridge for the WebView
 *   3. wdio run apps/desktop/wdio.conf.ts     # capabilities point at the binary
 *
 * tauri-driver exposes the WebView to WebDriver, so the shared web bundle's
 * data-testids drive exactly as in the Playwright web e2e. Assumes a seeded
 * `desktop-e2e@prisms.test` account with a schedulable task (offline loop runs
 * entirely against the local OPFS database).
 */
declare const browser: any;
declare const $: (selector: string) => any;

describe('desktop: offline worklist loop + OS notification', () => {
  it('clocks in/out and reviews offline, fires a notification', async () => {
    // sign in
    await $('[data-testid="email"]').setValue('desktop-e2e@prisms.test');
    await $('[data-testid="password"]').setValue('e2e-password-123');
    await $('[data-testid="submit"]').click();
    await $('[data-testid="sync-state"]').waitForDisplayed();

    // go offline (the WebView keeps serving from the precached shell + OPFS)
    await browser.setNetworkConditions({ offline: true, latency: 0, throughput: 0 });

    // clock in the first available task → the single running timer appears
    await $('[data-testid="worklist"] .px-btn=Clock in').click();
    await $('[data-testid="running-timer"]').waitForDisplayed();

    // clock out → focus review → save
    await $('[data-testid="timer-clock-out"]').click();
    await $('[data-testid="review-save"]').waitForDisplayed();
    await $('[data-testid="review-save"]').click();
    await browser.waitUntil(async () => !(await $('[data-testid="running-timer"]').isDisplayed()));

    // OS notification via the Tauri notification plugin
    await $('[data-testid="desktop-notify"]').click();

    await browser.setNetworkConditions({ offline: false, latency: 0, throughput: 0 });
  });
});
