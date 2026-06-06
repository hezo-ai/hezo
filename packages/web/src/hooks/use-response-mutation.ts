import { type QueryKey, useMutation } from '@tanstack/react-query';
import type { ApiError } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { toast } from './use-toast';

/**
 * Response-driven mutation: seed the cache from the server response instead of
 * predicting it. The sibling of {@link useOptimisticMutation} for creates,
 * multi-resource responses, and fields where the server runs
 * validation/automations whose outcome the UI must not preempt (e.g. task
 * `status`). No optimistic edit, so nothing to roll back.
 *
 * `errorMessage` is optional: when omitted no toast fires, so adopting this in
 * a hook that previously surfaced errors inline (or not at all) is
 * behavior-preserving.
 */
interface ResponseMutationOptions<TVars, TData, TCache> {
	/** Network call. */
	mutationFn: (vars: TVars) => Promise<TData>;

	/** Cache entry seeded from the response. May be derived from vars + response. */
	queryKey: QueryKey | ((vars: TVars, data: TData) => QueryKey);

	/** Compute the next cache value from the current one + the server response. */
	merge: (current: TCache | undefined, data: TData, vars: TVars) => TCache | undefined;

	/** Additional query keys to invalidate once the mutation settles. */
	invalidateOnSettled?: QueryKey[] | ((vars: TVars) => QueryKey[]);

	/** Message shown via toast.error on failure. Omit to stay silent. */
	errorMessage?: string | ((err: ApiError | Error) => string);
}

export function useResponseMutation<TVars, TData, TCache>(
	opts: ResponseMutationOptions<TVars, TData, TCache>,
) {
	const { mutationFn, queryKey, merge, invalidateOnSettled, errorMessage } = opts;

	return useMutation<TData, ApiError | Error, TVars>({
		mutationFn,
		onSuccess: (data, vars) => {
			const key = typeof queryKey === 'function' ? queryKey(vars, data) : queryKey;
			queryClient.setQueryData<TCache | undefined>(key, (current) => merge(current, data, vars));
		},
		onError: (err) => {
			if (!errorMessage) return;
			const message = typeof errorMessage === 'function' ? errorMessage(err) : errorMessage;
			toast.error(err.message ? `${message}: ${err.message}` : message);
		},
		onSettled: (_data, _err, vars) => {
			const keys =
				typeof invalidateOnSettled === 'function' ? invalidateOnSettled(vars) : invalidateOnSettled;
			for (const key of keys ?? []) {
				queryClient.invalidateQueries({ queryKey: key });
			}
		},
	});
}
