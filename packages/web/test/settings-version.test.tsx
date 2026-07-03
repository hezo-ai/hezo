import { expect, test } from 'vitest';
import { queryClient } from '../src/lib/query-client';
import { queryKeys } from '../src/lib/query-keys';
import { renderApp } from './helpers/render';

// The General settings page reads the running version via useUpdateCheck(); the app
// tree pulls from the singleton query client (__root re-wraps with it), so seed that
// cache to render the version display deterministically without an upstream GitHub call.
function seedVersion(update: {
	current: string;
	latest?: string | null;
	updateAvailable?: boolean;
	url?: string | null;
}) {
	queryClient.setQueryData(queryKeys.updateCheck(), {
		current: update.current,
		latest: update.latest ?? null,
		updateAvailable: update.updateAvailable ?? false,
		url: update.url ?? null,
	});
}

test('general settings page shows the version and links to its GitHub release tag', async () => {
	seedVersion({ current: '0.2.0' });
	const { findByTestId } = await renderApp({ initialPath: '/settings' });

	const section = await findByTestId('settings-version');
	expect(section.textContent).toContain('Current version:');
	expect(section.textContent).toContain('0.2.0');

	const releaseLink = section.querySelector(
		'a[href="https://github.com/hezo-ai/hezo/releases/tag/0.2.0"]',
	) as HTMLAnchorElement | null;
	expect(releaseLink).toBeTruthy();
	expect(releaseLink?.textContent).toContain('0.2.0');
});

test('general settings page links a non-release version to the releases index (no broken tag link)', async () => {
	seedVersion({ current: '0.0.0-dev' });
	const { findByTestId } = await renderApp({ initialPath: '/settings' });

	const section = await findByTestId('settings-version');
	expect(section.textContent).toContain('0.0.0-dev');
	// No release-tag link for a non-release version; it points at the releases index instead.
	expect(section.querySelector('a[href*="/releases/tag/"]')).toBeNull();
	expect(section.querySelector('a[href="https://github.com/hezo-ai/hezo/releases"]')).toBeTruthy();
});

test('check-for-new-version button posts a fresh check and reports the result', async () => {
	seedVersion({ current: '0.2.0' });
	const { findByTestId, user } = await renderApp({ initialPath: '/settings' });

	// The server's /api/updates/check returns the same release the test backend has;
	// clicking the button seeds the cache with that response and renders the result.
	const button = await findByTestId('settings-version-check');
	await user.click(button);

	const result = await findByTestId('settings-version-result');
	expect(result.textContent).toMatch(/latest version|is available/);
});

test('feedback handle links to the hezo_ai X account', async () => {
	seedVersion({ current: '0.2.0' });
	const { findByTestId } = await renderApp({ initialPath: '/settings' });

	const section = await findByTestId('settings-version');
	expect(section.textContent).toContain('Got feedback? @hezo_ai');

	const feedbackLink = section.querySelector(
		'a[href="https://x.com/hezo_ai"]',
	) as HTMLAnchorElement | null;
	expect(feedbackLink).toBeTruthy();
	expect(feedbackLink?.textContent).toContain('@hezo_ai');
});
