import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { useInvalidatingMutation } from '../src/hooks/use-invalidating-mutation';
import { useResponseMutation } from '../src/hooks/use-response-mutation';
import { queryClient } from '../src/lib/query-client';

function wrapper({ children }: { children: ReactNode }) {
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

afterEach(() => {
	queryClient.clear();
	vi.restoreAllMocks();
});

test('useResponseMutation seeds the cache from the server response', async () => {
	queryClient.setQueryData<string[]>(['items'], ['a']);
	const { result } = renderHook(
		() =>
			useResponseMutation<{ name: string }, { id: string }, string[]>({
				mutationFn: async (vars) => ({ id: vars.name }),
				queryKey: ['items'],
				merge: (current, data) => [...(current ?? []), data.id],
			}),
		{ wrapper },
	);

	await act(async () => {
		await result.current.mutateAsync({ name: 'b' });
	});

	expect(queryClient.getQueryData<string[]>(['items'])).toEqual(['a', 'b']);
});

test('useResponseMutation invalidates extra keys on settle', async () => {
	const spy = vi.spyOn(queryClient, 'invalidateQueries');
	const { result } = renderHook(
		() =>
			useResponseMutation<void, { id: string }, unknown>({
				mutationFn: async () => ({ id: 'x' }),
				queryKey: ['detail'],
				merge: (_current, data) => data,
				invalidateOnSettled: [['list']],
			}),
		{ wrapper },
	);
	await act(async () => {
		await result.current.mutateAsync();
	});
	expect(spy).toHaveBeenCalledWith({ queryKey: ['list'] });
});

test('useInvalidatingMutation invalidates the given keys on success', async () => {
	const spy = vi.spyOn(queryClient, 'invalidateQueries');
	const { result } = renderHook(
		() =>
			useInvalidatingMutation<{ id: string }, void>({
				mutationFn: async () => undefined,
				invalidate: (vars) => [['thing', vars.id]],
			}),
		{ wrapper },
	);
	await act(async () => {
		await result.current.mutateAsync({ id: '42' });
	});
	expect(spy).toHaveBeenCalledWith({ queryKey: ['thing', '42'] });
});

test('factories surface errors via toast only when errorMessage is set', async () => {
	const { toast } = await import('../src/hooks/use-toast');
	const errSpy = vi.spyOn(toast, 'error').mockImplementation(() => {});

	const silent = renderHook(
		() =>
			useInvalidatingMutation<void, void>({
				mutationFn: async () => {
					throw new Error('boom');
				},
				invalidate: [],
			}),
		{ wrapper },
	);
	await act(async () => {
		await silent.result.current.mutateAsync().catch(() => {});
	});
	expect(errSpy).not.toHaveBeenCalled();

	const loud = renderHook(
		() =>
			useInvalidatingMutation<void, void>({
				mutationFn: async () => {
					throw new Error('boom');
				},
				invalidate: [],
				errorMessage: 'Failed',
			}),
		{ wrapper },
	);
	await act(async () => {
		await loud.result.current.mutateAsync().catch(() => {});
	});
	await waitFor(() => expect(errSpy).toHaveBeenCalledWith('Failed: boom'));
});
