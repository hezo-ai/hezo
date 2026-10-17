import {
	installAnalytics,
	installAnalyticsClicks,
	shouldRecordThisVisit,
	startSessionRecording,
	trackAnalyticsPageView,
} from '@hezo/ui';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export interface Analytics {
	umami: {
		host: string;
		website_id: string;
		distinct_id: string;
		/** Null when this account is never recorded. */
		replay: { sample_rate: number; show_text: boolean } | null;
	};
}

/**
 * The product analytics this deployment runs on the instance owner's use.
 *
 * Asked only where an issuer signs people in **and somebody has**, for the
 * reason `useSupport` is: the route answers 404 to an instance with no issuer
 * and 401 before a session exists, and a self-hosted instance would otherwise
 * spend a request on every load to hear it. A 404 is the ordinary answer, so it
 * is not retried.
 */
export function useAnalytics(identified: boolean) {
	return useQuery({
		queryKey: queryKeys.analytics(),
		queryFn: () => api.get<Analytics>('/api/analytics'),
		enabled: identified,
		retry: false,
		retryOnMount: false,
	});
}

type AppRouter = ReturnType<typeof useRouter>;

/**
 * The route pattern of the page on screen, as `/projects/$projectId/tasks/$taskId`:
 * the deepest match's full path, which names the route and none of its params.
 * Read from the router at the moment it is asked, never captured. An index
 * route's full path ends in a slash the address does not have, so it is dropped.
 */
function routePattern(router: AppRouter): string {
	const matches = router.state.matches;
	const fullPath: string = matches[matches.length - 1]?.fullPath ?? '';
	return fullPath.replace(/(.)\/$/, '$1') || '/';
}

/**
 * Count the owner's page views and named clicks, and record their visit where
 * the deployer asks for it.
 *
 * **Only for a signed-in owner of a hosted instance.** Nothing loads before a
 * session exists, and a self-hosted instance never asks.
 *
 * **One subscription reports every page view after the first.** The tracker's
 * own history hook is off, because it sees `pushState` and `replaceState` but
 * not back and forward; the router's `onResolved` sees all of them, once each,
 * after the new page's matches are in place. A change of query or fragment
 * alone is the same page and is not counted.
 */
export function useProductAnalytics(identified: boolean): void {
	const umami = useAnalytics(identified).data?.umami;
	const router = useRouter();

	useEffect(() => {
		if (!umami) return;

		// Each of these is once per page, so a remount adds nothing.
		installAnalytics({
			host: umami.host,
			websiteId: umami.website_id,
			distinctId: umami.distinct_id,
			pagePattern: () => routePattern(router),
		});
		installAnalyticsClicks();
		if (umami.replay && shouldRecordThisVisit(umami.replay.sample_rate)) {
			startSessionRecording({ showText: umami.replay.show_text });
		}

		return router.subscribe('onResolved', (event) => {
			if (event.pathChanged) trackAnalyticsPageView();
		});
	}, [umami, router]);
}
