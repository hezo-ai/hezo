import { useEffect, useRef } from 'react';
import { Button } from './ui/button';

/**
 * Bottom-of-list infinite-scroll control shared by every paged list (tasks,
 * skills, connectors, credentials, runs). Renders an invisible sentinel `div`
 * that auto-fetches the next page when it scrolls into view, plus a "Load more"
 * button as the deterministic fallback.
 *
 * The component-test harness stubs `IntersectionObserver` to a no-op, so the
 * button is what those tests click; the observer drives real-browser scroll.
 * The sentinel `div` is always rendered (browser specs scroll it into view in a
 * retry loop); only the button is gated on there being another page.
 */
export function InfiniteScrollSentinel({
	hasNextPage,
	isFetchingNextPage,
	onLoadMore,
	testId,
}: {
	hasNextPage: boolean;
	isFetchingNextPage: boolean;
	onLoadMore: () => void;
	/** Base test id; the sentinel/button get `-sentinel` / `-load-more` suffixes. */
	testId: string;
}) {
	const sentinelRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (typeof IntersectionObserver === 'undefined') return;
		const el = sentinelRef.current;
		if (!el) return;
		const observer = new IntersectionObserver((entries) => {
			if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
				onLoadMore();
			}
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [hasNextPage, isFetchingNextPage, onLoadMore]);

	return (
		<div className="flex flex-col items-center gap-2">
			{hasNextPage && (
				<Button
					variant="secondary"
					size="sm"
					className="mt-2"
					disabled={isFetchingNextPage}
					onClick={onLoadMore}
					data-testid={`${testId}-load-more`}
				>
					{isFetchingNextPage ? 'Loading…' : 'Load more'}
				</Button>
			)}
			{/* When this scrolls into view the observer auto-fetches the next page. */}
			<div
				ref={sentinelRef}
				data-testid={`${testId}-sentinel`}
				aria-hidden="true"
				className="h-px w-full"
			/>
		</div>
	);
}
