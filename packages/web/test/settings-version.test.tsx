import { expect, test } from 'vitest';
import { queryClient } from '../src/lib/query-client';
import { queryKeys } from '../src/lib/query-keys';
import { renderApp } from './helpers/render';

// The settings page reads the running version via useUpdateCheck(); the app tree
// pulls from the singleton query client (__root re-wraps with it), so seed that
// cache to render the footer deterministically without an upstream GitHub call.
function seedVersion(current: string) {
	queryClient.setQueryData(queryKeys.updateCheck(), {
		current,
		latest: null,
		updateAvailable: false,
		url: null,
	});
}

test('settings footer shows the version and links to its GitHub release tag', async () => {
	seedVersion('0.2.0');
	const { findByTestId } = await renderApp({ initialPath: '/settings' });

	const footer = await findByTestId('settings-version');
	expect(footer.textContent).toContain('version: 0.2.0');

	const releaseLink = footer.querySelector(
		'a[href="https://github.com/hezo-ai/hezo/releases/tag/0.2.0"]',
	) as HTMLAnchorElement | null;
	expect(releaseLink).toBeTruthy();
	expect(releaseLink?.textContent).toContain('0.2.0');
});

test('settings footer shows a non-release version as plain text (no broken tag link)', async () => {
	seedVersion('0.0.0-dev');
	const { findByTestId } = await renderApp({ initialPath: '/settings' });

	const footer = await findByTestId('settings-version');
	expect(footer.textContent).toContain('version: 0.0.0-dev');
	// No release-tag link for a non-release version (the feedback link still renders).
	expect(footer.querySelector('a[href*="/releases/tag/"]')).toBeNull();
});

test('settings footer links the feedback handle to the taoofdev X account', async () => {
	seedVersion('0.2.0');
	const { findByTestId } = await renderApp({ initialPath: '/settings' });

	const footer = await findByTestId('settings-version');
	expect(footer.textContent).toContain('Got feedback? @taoofdev');

	const feedbackLink = footer.querySelector(
		'a[href="https://x.com/taoofdev"]',
	) as HTMLAnchorElement | null;
	expect(feedbackLink).toBeTruthy();
	expect(feedbackLink?.textContent).toContain('@taoofdev');
});
