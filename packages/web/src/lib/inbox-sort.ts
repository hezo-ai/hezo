// Date ordering for the inbox list, shared by the two inbox routes and the view
// they both render. Web-only: the rows are fetched in full and merged in the
// browser from two feeds, so there is no server counterpart to mirror.

/**
 * Order for the inbox list. Newest is the default (it is how the list has always
 * arrived, and how both feeds are ordered on the server).
 */
export const InboxSortOrder = {
	Newest: 'newest',
	Oldest: 'oldest',
} as const;
export type InboxSortOrder = (typeof InboxSortOrder)[keyof typeof InboxSortOrder];

export function isInboxSortOrder(value: unknown): value is InboxSortOrder {
	return typeof value === 'string' && (Object.values(InboxSortOrder) as string[]).includes(value);
}

/** The minimal row shape the sort comparison reads. */
export interface InboxSortFields {
	created_at: string;
	/** `approval:<id>` / `mention:<id>` - unique across both feeds. */
	key: string;
}

/**
 * Compare two inbox rows for the given order:
 * - Newest: created_at DESC, then key ASC
 * - Oldest: created_at ASC,  then key ASC
 *
 * The key tiebreak is what makes the order total. Approvals and mentions come
 * from two endpoints and are interleaved here, so rows sharing a `created_at`
 * otherwise land in whatever order the merge happened to produce and can swap
 * places between renders.
 */
export function compareInboxRowsForSort(
	a: InboxSortFields,
	b: InboxSortFields,
	order: InboxSortOrder,
): number {
	// ISO-8601 timestamps sort chronologically as plain strings.
	const byDate =
		order === InboxSortOrder.Oldest
			? a.created_at.localeCompare(b.created_at)
			: b.created_at.localeCompare(a.created_at);
	if (byDate !== 0) return byDate;
	return a.key.localeCompare(b.key);
}

/** The `sort` search param both inbox routes carry. */
export interface InboxSearch {
	/** Sort order - absent means the default Newest-first view. */
	sort?: InboxSortOrder;
}

/**
 * `validateSearch` for both inbox routes. The default is dropped to `undefined`
 * so it leaves no URL noise, and anything unrecognised (a hand-typed value, a
 * stale link) falls back to it rather than reaching the comparator.
 */
export function validateInboxSearch(search: Record<string, unknown>): InboxSearch {
	return {
		sort:
			isInboxSortOrder(search.sort) && search.sort !== InboxSortOrder.Newest
				? search.sort
				: undefined,
	};
}
