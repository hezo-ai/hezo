import { type QueryKey, useMutation } from '@tanstack/react-query';
import { type ApiError, api } from '../lib/api';
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

interface SimpleOptimisticUpdateOptions<TVars> {
	/** Sibling queries (list views) to re-fetch once the mutation settles. */
	invalidateOnSettled?: QueryKey[];
	/** Message shown via toast.error on rollback. */
	errorMessage?: string;
	/**
	 * Fields applied only after the server confirms — server-authority values
	 * (status set by automations) or fields that live in a separate cache
	 * (system_prompt). Excluded from the optimistic apply, picked up by the
	 * response merge.
	 */
	omitOptimistic?: (keyof TVars)[];
}

/**
 * Thin wrapper over `useOptimisticMutation` for the common shape: PATCH a single
 * entity's editable fields, shallow-merge them into one detail cache entry, and
 * reconcile from the response. Use it for field-edit hooks whose optimistic and
 * merge logic is the shallow spread (optionally omitting a few server-authority
 * fields). Hooks with list-cache mapping or deep-merges stay on the raw
 * `useOptimisticMutation`.
 */
export function useSimpleOptimisticUpdate<
	TEntity extends object,
	TVars extends Partial<TEntity> = Partial<TEntity>,
>(endpoint: string, queryKey: QueryKey, options: SimpleOptimisticUpdateOptions<TVars> = {}) {
	const { invalidateOnSettled, errorMessage = 'Update failed', omitOptimistic } = options;
	return useOptimisticMutation<TVars, TEntity, TEntity>({
		mutationFn: (vars) => api.patch<TEntity>(endpoint, vars),
		queryKey,
		applyOptimistic: (current, vars) => {
			if (!current) return current;
			const optimistic = { ...vars };
			for (const key of omitOptimistic ?? []) delete optimistic[key];
			return { ...current, ...optimistic };
		},
		mergeResponse: (current, updated) => (current ? { ...current, ...updated } : current),
		invalidateOnSettled,
		errorMessage,
	});
}
