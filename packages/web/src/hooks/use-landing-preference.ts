import { HQ_PROJECT_SLUG } from '@hezo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';
import { toast } from './use-toast';

/**
 * What the app opens on. `adaptive` is the shipped behaviour - the full-page
 * CEO chat until the first project exists, the dashboard after - and the two
 * explicit values pin one side of that transition.
 */
export type LandingPreference = 'adaptive' | 'dashboard' | 'chat';

/**
 * Per-user landing preference, stored in the ui-state seam (`member_users.settings`)
 * on the caller's HQ membership - every enrolled human has one, and the
 * preference is account-wide rather than per project or per browser.
 */
export function useLandingPreference() {
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: queryKeys.landingPreference(),
		queryFn: () => api.get<Record<string, unknown>>(`/api/projects/${HQ_PROJECT_SLUG}/ui-state`),
	});
	const raw = query.data?.landing;
	const preference: LandingPreference = raw === 'chat' || raw === 'dashboard' ? raw : 'adaptive';

	// Response-driven: the server's merged settings echo reseeds the cache, so
	// the control reflects what was actually stored.
	const mutation = useMutation({
		mutationFn: (next: LandingPreference) =>
			api.patch<Record<string, unknown>>(`/api/projects/${HQ_PROJECT_SLUG}/ui-state`, {
				landing: next === 'adaptive' ? null : next,
			}),
		onSuccess: (settings) => {
			queryClient.setQueryData(queryKeys.landingPreference(), settings);
		},
		// Response-driven means the control does not move until the server agrees,
		// so a failed save with no message reads as a dead control.
		onError: (error: { message?: string }) => {
			toast.error(error?.message ?? 'Failed to save the landing preference');
		},
	});

	return {
		preference,
		loaded: !query.isPending,
		setPreference: (next: LandingPreference) => mutation.mutate(next),
	};
}
