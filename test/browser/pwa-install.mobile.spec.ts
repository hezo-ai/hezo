// Decision-tree item 2: the install prompt is gated `lg:hidden`, so whether it
// shows is viewport-conditional on real CSS — happy-dom can't run the media
// query, so this needs real Chromium + setViewportSize.
import { expect, test } from './fixtures';

// Fire a synthetic `beforeinstallprompt` (the Android/Chromium installability
// signal Playwright's Chromium won't emit on its own) so the prompt's capture
// path runs. The fake carries the `prompt()` + `userChoice` members the hook
// uses, and records the call on `window` so the test can assert the replay.
const FIRE_BEFORE_INSTALL_PROMPT = `
	const e = new Event('beforeinstallprompt');
	e.platforms = ['web'];
	e.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
	e.prompt = () => { window.__installPromptCalled = true; return Promise.resolve(); };
	window.dispatchEvent(e);
`;

test.describe('PWA install prompt (mobile)', () => {
	test('mobile (<1024): shows the install card and replays the prompt on Install', async ({
		authedPage: page,
	}) => {
		await page.setViewportSize({ width: 375, height: 800 });
		await page.goto('/home');
		await expect(page.getByTestId('app-header')).toBeVisible({ timeout: 15000 });

		// Not installable yet — the prompt stays absent until the browser signals it.
		await expect(page.getByTestId('pwa-install-prompt')).toBeHidden();

		await page.evaluate(FIRE_BEFORE_INSTALL_PROMPT);
		await expect(page.getByTestId('pwa-install-prompt')).toBeVisible();

		await page.getByTestId('pwa-install-button').click();
		await expect
			.poll(() =>
				page.evaluate(() => (window as { __installPromptCalled?: boolean }).__installPromptCalled),
			)
			.toBe(true);
		// The card hides itself once the captured prompt has been consumed.
		await expect(page.getByTestId('pwa-install-prompt')).toBeHidden();
	});

	test('desktop (1024+): the prompt stays hidden even when installable', async ({
		authedPage: page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto('/home');
		await expect(page.getByTestId('app-header')).toBeVisible({ timeout: 15000 });

		await page.evaluate(FIRE_BEFORE_INSTALL_PROMPT);
		// `lg:hidden` keeps the bottom card off desktop viewports.
		await expect(page.getByTestId('pwa-install-prompt')).toBeHidden();
	});
});
