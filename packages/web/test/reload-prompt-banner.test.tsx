// The reload-prompt banner surfaces when the connected server moves to a newer
// version than the one this tab loaded (`useServerVersionChanged`), so a stale
// bundle self-heals with one click instead of silently mis-rendering new data.
// The server version is driven by mocking `useUpdateStatus`.

import { render } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

// Hoisted so the mock factory (evaluated before imports) can read it; tests mutate it.
const state = vi.hoisted(() => ({ current: '0.31.0' as string | undefined }));

vi.mock('../src/hooks/use-update-check', () => ({
	useUpdateStatus: () => ({ data: state.current ? { current: state.current } : undefined }),
}));

import { ReloadPromptBanner } from '../src/components/reload-prompt-banner';

beforeEach(() => {
	state.current = '0.31.0';
});

test('stays hidden while the server version is unchanged', () => {
	const { queryByTestId, rerender } = render(<ReloadPromptBanner />);
	expect(queryByTestId('reload-prompt-banner')).toBeNull();
	// A refetch returning the SAME version is not a change.
	rerender(<ReloadPromptBanner />);
	expect(queryByTestId('reload-prompt-banner')).toBeNull();
});

test('prompts a refresh once the server reports a newer version', async () => {
	const { queryByTestId, findByTestId, rerender } = render(<ReloadPromptBanner />);
	expect(queryByTestId('reload-prompt-banner')).toBeNull();

	// The server restarts onto a new version; the status query refetches.
	state.current = '0.32.0';
	rerender(<ReloadPromptBanner />);
	const banner = await findByTestId('reload-prompt-banner');
	expect(banner.textContent).toMatch(/refresh/i);

	// Latches: even if a later poll returns to the original value, it stays.
	state.current = '0.31.0';
	rerender(<ReloadPromptBanner />);
	expect(queryByTestId('reload-prompt-banner')).not.toBeNull();
});

test('a first observation with no prior version does not falsely trigger', () => {
	state.current = undefined; // status not loaded yet on first render
	const { queryByTestId, rerender } = render(<ReloadPromptBanner />);
	expect(queryByTestId('reload-prompt-banner')).toBeNull();
	// First real version observed — this is the baseline, not a change.
	state.current = '0.31.0';
	rerender(<ReloadPromptBanner />);
	expect(queryByTestId('reload-prompt-banner')).toBeNull();
});
