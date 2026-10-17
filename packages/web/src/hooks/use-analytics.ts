import {
	installAnalytics,
	installAnalyticsClicks,
	shouldRecordThisVisit,
	startSessionRecording,
	stopSessionRecording,
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
		script_integrity: string;
		recorder_integrity: string;
		/** Null when this account is never recorded. */
		replay: { sample_rate: number; show_text: boolean } | null;
	};
}

/**
 * How often a recorded page asks whether its recording should tighten. Two
 * minutes: the policy reaches the instance about once a minute, and the
 * recorder's next full snapshot follows within thirty seconds.
 */
const RECORDING_RECHECK_MS = 2 * 60_000;

/**
 * The product analytics this deployment runs on the instance owner's use.
 *
 * Asked only where an issuer signs people in **and somebody has**, for the
 * reason `useSupport` is: the route answers 404 to an instance with no issuer
 * and 401 before a session exists, and a self-hosted instance would otherwise
 * spend a request on every load to hear it. A 404 is the ordinary answer, so it
 * is not retried.
 *
 * **Asked again every `RECORDING_RECHECK_MS` while this account is recorded**,
 * and only then. The deployer can end a recording that shows page text, or stop
 * recording the account, while the owner keeps the app open for hours; the app
 * never refetches on focus, so without this the change would wait for a reload.
 * Nothing is asked for an account that is not recorded at all: turning its
 * recording on reaches the next page load.
 */
export function useAnalytics(identified: boolean) {
	return useQuery({
		queryKey: queryKeys.analytics(),
		queryFn: () => api.get<Analytics>('/api/analytics'),
		enabled: identified,
		retry: false,
		retryOnMount: false,
		refetchInterval: (query) => (query.state.data?.umami.replay ? RECORDING_RECHECK_MS : false),
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
			scriptIntegrity: umami.script_integrity,
			pagePattern: () => routePattern(router),
		});
		installAnalyticsClicks();
		// Run again whenever the settings change mid-page: a recording already
		// running only tightens (text hidden, or the rest of the page left out).
		if (!umami.replay) {
			stopSessionRecording();
		} else if (shouldRecordThisVisit(umami.replay.sample_rate)) {
			startSessionRecording({
				showText: umami.replay.show_text,
				recorderIntegrity: umami.recorder_integrity,
			});
		}

		return router.subscribe('onResolved', (event) => {
			if (event.pathChanged) trackAnalyticsPageView();
		});
	}, [umami, router]);
}
