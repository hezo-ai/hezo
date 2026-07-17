// Unit tests for useSignedUrlText: the hook that loads a text asset's body from
// its signed URL. The behaviour under test is the identity-keyed fetch — a
// rotated `exp`/`sig` for the SAME asset must not re-fetch or blank the loaded
// text (blanking unmounts the asset viewer's prose and scrolls the reader back
// to the top mid-review), while an overwrite that swaps the asset id (its URL
// path) must. Rendered with renderHook + a mocked fetch (no app shell).
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useSignedUrlText } from '../src/hooks/use-signed-url-text';

function mockResponse(body: string, init?: { ok?: boolean; status?: number }): Response {
	const ok = init?.ok ?? true;
	const status = init?.status ?? (ok ? 200 : 404);
	return { ok, status, text: async () => body } as unknown as Response;
}

afterEach(() => {
	vi.restoreAllMocks();
});

test('loads the asset body from its signed URL', async () => {
	const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse('hello world'));
	const { result } = renderHook(() => useSignedUrlText('/api/assets/abc?exp=1&sig=aaa'));

	await waitFor(() => expect(result.current.text).toBe('hello world'));
	expect(result.current.error).toBeNull();
	expect(spy).toHaveBeenCalledTimes(1);
	expect(spy).toHaveBeenCalledWith('/api/assets/abc?exp=1&sig=aaa');
});

test('a rotated signature for the same asset does not refetch or blank the text', async () => {
	const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse('body v1'));
	const { result, rerender } = renderHook(({ url }) => useSignedUrlText(url), {
		initialProps: { url: '/api/assets/abc?exp=1&sig=aaa' },
	});
	await waitFor(() => expect(result.current.text).toBe('body v1'));
	expect(spy).toHaveBeenCalledTimes(1);

	// An assets-list refetch mints a fresh signature for the SAME asset path —
	// this is exactly what a review-comment WebSocket broadcast triggers.
	rerender({ url: '/api/assets/abc?exp=2&sig=bbb' });

	// The effect (the only thing that calls fetch / blanks text) does not re-run:
	// no second request, and the loaded text is preserved. That is what keeps the
	// viewer's prose mounted so the reader isn't yanked to the top.
	await act(async () => {
		await Promise.resolve();
	});
	expect(spy).toHaveBeenCalledTimes(1);
	expect(result.current.text).toBe('body v1');
});

test('an overwrite that swaps the asset id (path) refetches the new content', async () => {
	const spy = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (input) =>
			mockResponse(String(input).startsWith('/api/assets/v2') ? 'body v2' : 'body v1'),
		);
	const { result, rerender } = renderHook(({ url }) => useSignedUrlText(url), {
		initialProps: { url: '/api/assets/v1?exp=1&sig=aaa' },
	});
	await waitFor(() => expect(result.current.text).toBe('body v1'));

	rerender({ url: '/api/assets/v2?exp=1&sig=aaa' });
	await waitFor(() => expect(result.current.text).toBe('body v2'));
	expect(spy).toHaveBeenCalledTimes(2);
});

test('reload() retries with the latest signature after an error, without auto-retrying on rotation', async () => {
	const spy = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (input) =>
			String(input).includes('sig=expired')
				? mockResponse('', { ok: false, status: 403 })
				: mockResponse('recovered body'),
		);
	const { result, rerender } = renderHook(({ url }) => useSignedUrlText(url), {
		initialProps: { url: '/api/assets/abc?exp=1&sig=expired' },
	});
	await waitFor(() => expect(result.current.error).toContain('403'));
	expect(result.current.text).toBeNull();

	// A list refetch hands out a fresh, valid signature for the same asset. The
	// hook does NOT auto-retry on a signature rotation…
	rerender({ url: '/api/assets/abc?exp=2&sig=valid' });
	await act(async () => {
		await Promise.resolve();
	});
	expect(spy).toHaveBeenCalledTimes(1);
	expect(result.current.error).toContain('403');

	// …but reload() forces a fetch, and it uses the LATEST signature (proving the
	// effect closure reads the current url even though url is out of its deps).
	act(() => result.current.reload());
	await waitFor(() => expect(result.current.text).toBe('recovered body'));
	expect(result.current.error).toBeNull();
	expect(spy).toHaveBeenLastCalledWith('/api/assets/abc?exp=2&sig=valid');
});
