import { applyAnalyticsSettings, trackAnalyticsPageView } from '@hezo/ui';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { ApiError, api } from '../lib/api';
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
 * How often a page running analytics asks whether to tighten it. Two minutes:
 * the policy reaches the instance about once a minute, and the recorder's next
 * full snapshot follows within thirty seconds.
 */
const ANALYTICS_RECHECK_MS = 2 * 60_000;

/**
 * The route's answers that end analytics on this page: 404 when it is not
 * configured or no longer is, and 401 when the session has ended, as it does
 * when the token expires on a tab left open. Any other failure, a network error
 * among them, leaves the page as it was.
 */
const ENDING_STATUSES: ReadonlySet<number> = new Set([401, 404]);

function endsAnalytics(error: unknown): boolean {
	return error instanceof ApiError && ENDING_STATUSES.has(error.status);
}

/**
 * The product analytics this deployment runs on the instance owner's use.
 *
 * Asked only where an issuer signs people in **and somebody has**, for the
 * reason `useSupport` is: the route answers 404 to an instance with no issuer
 * and 401 before a session exists, and a self-hosted instance would otherwise
 * spend a request on every load to hear it. A 404 is the ordinary answer, so it
 * is not retried.
 *
 * **Asked again every `ANALYTICS_RECHECK_MS` while the deployment runs
 * analytics here**, and never once it answers 404 or 401. The deployer can stop
 * analytics, stop recording the account, or end a recording that shows page
 * text while the owner keeps the app open for hours; the app never refetches on
 * focus, so without this the change would wait for a reload.
 */
export function useAnalytics(identified: boolean) {
	return useQuery({
		queryKey: queryKeys.analytics(),
		queryFn: () => api.get<Analytics>('/api/analytics'),
		enabled: identified,
		retry: false,
		retryOnMount: false,
		refetchInterval: (query) =>
			query.state.data && !endsAnalytics(query.state.error) ? ANALYTICS_RECHECK_MS : false,
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
 * **Every answer goes to `applyAnalyticsSettings`**, which starts analytics on
 * the first and only ever tightens it after: a 404 after a good answer means
 * the deployment stopped analytics, and losing the signed-in owner (here, or a
 * 401 from the recheck) means there is nobody to count, and both are applied as
 * nothing.
 *
 * **One subscription reports every page view after the first.** The tracker's
 * own history hook is off, because it sees `pushState` and `replaceState` but
 * not back and forward; the router's `onResolved` sees all of them, once each,
 * after the new page's matches are in place. A change of query or fragment
 * alone is the same page and is not counted. Before analytics starts, and after
 * it stops, a page view is nothing.
 */
export function useProductAnalytics(identified: boolean): void {
	const { data, error } = useAnalytics(identified);
	const umami = data?.umami;
	const stopped = endsAnalytics(error);
	const router = useRouter();

	useEffect(() => {
		// The owner gone (the vault locked, or the session ended) or analytics
		// withdrawn: the page stops, and starting again waits for a reload.
		if (!identified || stopped) {
			applyAnalyticsSettings(null);
			return;
		}
		if (!umami) return;
		applyAnalyticsSettings({
			analytics: {
				host: umami.host,
				websiteId: umami.website_id,
				distinctId: umami.distinct_id,
				scriptIntegrity: umami.script_integrity,
				pagePattern: () => routePattern(router),
			},
			replay: umami.replay
				? {
						sampleRate: umami.replay.sample_rate,
						showText: umami.replay.show_text,
						recorderIntegrity: umami.recorder_integrity,
					}
				: null,
		});
	}, [identified, umami, stopped, router]);

	useEffect(
		() =>
			router.subscribe('onResolved', (event) => {
				if (event.pathChanged) trackAnalyticsPageView();
			}),
		[router],
	);
}
