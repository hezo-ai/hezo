import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import { UpdateBanner } from '../src/components/update-banner';
import type { UpdateInfo } from '../src/hooks/use-update-check';

function renderBanner(data: UpdateInfo) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	// Seed the cache so the component renders without hitting the network.
	qc.setQueryData(['update-check'], data);
	return render(
		<QueryClientProvider client={qc}>
			<UpdateBanner />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	localStorage.clear();
});

test('shows when an update is available and links to the release', () => {
	const { getByTestId, getByText } = renderBanner({
		current: '0.1.0',
		latest: '0.2.0',
		updateAvailable: true,
		url: 'https://github.com/hezo-ai/hezo/releases/0.2.0',
	});
	expect(getByTestId('update-banner')).toBeTruthy();
	const link = getByText('Download') as HTMLAnchorElement;
	expect(link.getAttribute('href')).toBe('https://github.com/hezo-ai/hezo/releases/0.2.0');
});

test('hidden when no update is available', () => {
	const { queryByTestId } = renderBanner({
		current: '0.1.0',
		latest: '0.1.0',
		updateAvailable: false,
		url: null,
	});
	expect(queryByTestId('update-banner')).toBeNull();
});

test('dismiss hides the banner and remembers the version', async () => {
	const user = userEvent.setup();
	const { getByTestId, queryByTestId, getByLabelText } = renderBanner({
		current: '0.1.0',
		latest: '0.2.0',
		updateAvailable: true,
		url: 'https://github.com/hezo-ai/hezo/releases/0.2.0',
	});
	expect(getByTestId('update-banner')).toBeTruthy();
	await user.click(getByLabelText('Dismiss update notification'));
	expect(queryByTestId('update-banner')).toBeNull();
	expect(localStorage.getItem('hezo:update-dismissed')).toBe('0.2.0');
});
