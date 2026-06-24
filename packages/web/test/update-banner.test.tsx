import { UpdateState } from '@hezo/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { UpdateBanner } from '../src/components/update-banner';
import type { UpdateStatusInfo } from '../src/hooks/use-update-check';
import { api } from '../src/lib/api';

const BASE: UpdateStatusInfo = {
	current: '0.1.0',
	latest: '0.2.0',
	updateAvailable: true,
	url: 'https://github.com/hezo-ai/hezo/releases/0.2.0',
	state: UpdateState.Staged,
	targetVersion: '0.2.0',
	error: null,
	autoUnlock: false,
	canApply: true,
};

function renderBanner(status: Partial<UpdateStatusInfo> = {}, isSuperuser = true) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	// Seed both caches so the component renders without hitting the network.
	qc.setQueryData(['update-status'], { ...BASE, ...status });
	qc.setQueryData(['me'], { type: 'admin', is_superuser: isSuperuser });
	return render(
		<QueryClientProvider client={qc}>
			<UpdateBanner />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	localStorage.clear();
	vi.restoreAllMocks();
});

test('hidden when no update is available', () => {
	const { queryByTestId } = renderBanner({ updateAvailable: false, latest: '0.1.0' });
	expect(queryByTestId('update-banner')).toBeNull();
});

test('non-superuser / non-supervised falls back to a release download link', () => {
	const { getByTestId, getByText, queryByTestId } = renderBanner({ canApply: false }, false);
	expect(getByTestId('update-banner')).toBeTruthy();
	expect(queryByTestId('update-restart-button')).toBeNull();
	const link = getByText('Download') as HTMLAnchorElement;
	expect(link.getAttribute('href')).toBe('https://github.com/hezo-ai/hezo/releases/0.2.0');
});

test('Update & restart asks for confirmation (with master-key warning) before applying', async () => {
	const user = userEvent.setup();
	const postSpy = vi
		.spyOn(api, 'post')
		.mockResolvedValue({ state: UpdateState.Applying, targetVersion: '0.2.0' });

	const { getByTestId, findByTestId, queryByTestId } = renderBanner();

	// Clicking the action opens the dialog — it does NOT apply yet.
	await user.click(getByTestId('update-restart-button'));
	const dialog = await findByTestId('confirm-dialog');
	expect(dialog.textContent).toContain('master key');
	expect(postSpy).not.toHaveBeenCalled();
	expect(queryByTestId('update-restart-overlay')).toBeNull();

	// Confirming applies and mounts the restart overlay.
	await user.click(getByTestId('confirm-dialog-confirm'));
	await waitFor(() => expect(postSpy).toHaveBeenCalledWith('/api/updates/apply'));
	expect(await findByTestId('update-restart-overlay')).toBeTruthy();
});

test('confirmation omits the master-key warning when the instance auto-unlocks', async () => {
	const user = userEvent.setup();
	vi.spyOn(api, 'post').mockResolvedValue({ state: UpdateState.Applying, targetVersion: '0.2.0' });
	const { getByTestId, findByTestId } = renderBanner({ autoUnlock: true });
	await user.click(getByTestId('update-restart-button'));
	const dialog = await findByTestId('confirm-dialog');
	expect(dialog.textContent).not.toContain('master key');
});

test('dismiss hides the banner and remembers the version', async () => {
	const user = userEvent.setup();
	const { getByTestId, queryByTestId, getByLabelText } = renderBanner();
	expect(getByTestId('update-banner')).toBeTruthy();
	await user.click(getByLabelText('Dismiss update notification'));
	expect(queryByTestId('update-banner')).toBeNull();
	expect(localStorage.getItem('hezo:update-dismissed')).toBe('0.2.0');
});
