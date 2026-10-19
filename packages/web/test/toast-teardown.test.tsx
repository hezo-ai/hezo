import { ERROR_DURATION_MS } from '@hezo/web/components/ui/toast';
import { toast, useToasts } from '@hezo/web/hooks/use-toast';
import { renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { renderApp } from './helpers/render';

/**
 * A toast across the shared teardown. Radix starts a close timer for every open
 * toast and never clears it on unmount, so a toast a test leaves open can fire
 * after the environment is gone and fail the whole run with "document is not
 * defined". The two tests run in order: the first leaves a toast open, the
 * second checks what the teardown between them did.
 */

const timers = {
	set: vi.spyOn(window, 'setTimeout'),
	clear: vi.spyOn(window, 'clearTimeout'),
};
let closeTimer: unknown;

test('a test can end with a toast still open', async () => {
	const { findByText } = await renderApp({ initialPath: '/home' });
	toast.error('Left open by the first test');
	await findByText('Left open by the first test');

	const index = timers.set.mock.calls.findLastIndex(([, delay]) => delay === ERROR_DURATION_MS);
	closeTimer = timers.set.mock.results[index]?.value;
	expect(closeTimer).toBeDefined();
	expect(timers.clear.mock.calls.some(([handle]) => handle === closeTimer)).toBe(false);
});

test('the teardown stopped its close timer and dropped it from the list', () => {
	expect(timers.clear.mock.calls.some(([handle]) => handle === closeTimer)).toBe(true);
	expect(renderHook(() => useToasts()).result.current).toEqual([]);
	timers.set.mockRestore();
	timers.clear.mockRestore();
});
