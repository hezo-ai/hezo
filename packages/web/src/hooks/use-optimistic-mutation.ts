import { type QueryKey, useMutation } from '@tanstack/react-query';
import type { ApiError } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { toast } from './use-toast';

interface OptimisticMutationOptions<TVars, TData, TCache> {
	/** Network call. */
	mutationFn: (vars: TVars) => Promise<TData>;

	/** Cache entry that the optimistic update edits. Can be derived from the mutation vars. */
	queryKey: QueryKey | ((vars: TVars) => QueryKey);

	/** Compute the predicted next cache value from the current one + the mutation vars. */
	applyOptimistic: (current: TCache | undefined, vars: TVars) => TCache | undefined;

	/**
	 * Optional: reconcile the cache once the server has confirmed, e.g. to pick up
	 * server-computed fields (timestamps, status set by automations, etc.). Receives the
	 * cache as it stands after the optimistic update.
	 */
	mergeResponse?: (current: TCache | undefined, response: TData, vars: TVars) => TCache | undefined;

	/** Additional query keys to invalidate once the mutation settles. */
	invalidateOnSettled?: QueryKey[];

	/** Message shown via toast.error on rollback. String, or a function of the thrown error. */
	errorMessage: string | ((err: ApiError | Error) => string);
}

interface MutationContext<TCache> {
	key: QueryKey;
	previous: TCache | undefined;
}

export function useOptimisticMutation<TVars, TData, TCache>(
	opts: OptimisticMutationOptions<TVars, TData, TCache>,
) {
	const {
		mutationFn,
		queryKey,
		applyOptimistic,
		mergeResponse,
		invalidateOnSettled,
		errorMessage,
	} = opts;
	const resolveKey = (vars: TVars): QueryKey =>
		typeof queryKey === 'function' ? queryKey(vars) : queryKey;

	return useMutation<TData, ApiError | Error, TVars, MutationContext<TCache>>({
		mutationFn,
		onMutate: async (vars) => {
			const key = resolveKey(vars);
			await queryClient.cancelQueries({ queryKey: key });
			const previous = queryClient.getQueryData<TCache>(key);
			queryClient.setQueryData<TCache | undefined>(key, (current) =>
				applyOptimistic(current, vars),
			);
			return { key, previous };
		},
		onSuccess: (response, vars, context) => {
			if (!mergeResponse || !context) return;
			queryClient.setQueryData<TCache | undefined>(context.key, (current) =>
				mergeResponse(current, response, vars),
			);
		},
		onError: (err, _vars, context) => {
			if (context) {
				queryClient.setQueryData<TCache | undefined>(context.key, context.previous);
			}
			const message = typeof errorMessage === 'function' ? errorMessage(err) : errorMessage;
			toast.error(err.message ? `${message}: ${err.message}` : message);
		},
		onSettled: (_data, _err, _vars, context) => {
			if (context) queryClient.invalidateQueries({ queryKey: context.key });
			for (const key of invalidateOnSettled ?? []) {
				queryClient.invalidateQueries({ queryKey: key });
			}
		},
	});
}
