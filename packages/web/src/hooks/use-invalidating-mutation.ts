import { type QueryKey, useMutation } from '@tanstack/react-query';
import type { ApiError } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { toast } from './use-toast';

/**
 * Invalidate-and-refetch mutation: run the call, then invalidate the affected
 * queries and let React Query refetch. The sibling of
 * {@link useOptimisticMutation} for validation-heavy / long-running work and
 * security-sensitive mutations (provider verify, container lifecycle,
 * credentials) that must never optimistically appear applied.
 *
 * `errorMessage` is optional: when omitted no toast fires, so adopting this in
 * a hook that previously handled errors inline is behavior-preserving.
 */
interface InvalidatingMutationOptions<TVars, TData> {
	/** Network call. */
	mutationFn: (vars: TVars) => Promise<TData>;

	/** Query keys to invalidate on success. May be derived from vars + response. */
	invalidate: QueryKey[] | ((vars: TVars, data: TData) => QueryKey[]);

	/** Optional extra work after a successful mutation (e.g. setQueryData). */
	onSuccess?: (data: TData, vars: TVars) => void;

	/** Message shown via toast.error on failure. Omit to stay silent. */
	errorMessage?: string | ((err: ApiError | Error) => string);
}

export function useInvalidatingMutation<TVars, TData>(
	opts: InvalidatingMutationOptions<TVars, TData>,
) {
	const { mutationFn, invalidate, onSuccess, errorMessage } = opts;

	return useMutation<TData, ApiError | Error, TVars>({
		mutationFn,
		onSuccess: (data, vars) => {
			const keys = typeof invalidate === 'function' ? invalidate(vars, data) : invalidate;
			for (const key of keys) {
				queryClient.invalidateQueries({ queryKey: key });
			}
			onSuccess?.(data, vars);
		},
		onError: (err) => {
			if (!errorMessage) return;
			const message = typeof errorMessage === 'function' ? errorMessage(err) : errorMessage;
			toast.error(err.message ? `${message}: ${err.message}` : message);
		},
	});
}
