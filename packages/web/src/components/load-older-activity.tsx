/**
 * "Load older" control for the keyset-paginated activity feed.
 *
 * The feed reads an append-only table, so it pages by cursor rather than page
 * number - there is deliberately no total to render a pager against, since
 * counting the table on every page load costs more than the page itself.
 */
export function LoadOlderActivity({
	hasMore,
	loadMore,
	isLoading,
}: {
	hasMore: boolean;
	loadMore: () => void;
	isLoading: boolean;
}) {
	if (!hasMore) return null;
	return (
		<div className="mt-4 flex justify-center">
			<button
				type="button"
				onClick={loadMore}
				disabled={isLoading}
				data-testid="load-older-activity"
				className="rounded-md border border-border px-3 py-1.5 text-[13px] text-text-2 hover:text-text-1 hover:bg-surface-2 disabled:opacity-60"
			>
				{isLoading ? 'Loading…' : 'Load older activity'}
			</button>
		</div>
	);
}
