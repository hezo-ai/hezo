import type { Context } from 'hono';

const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE = 200;

export function parsePagination(c: Context) {
	const page = Math.max(1, Number(c.req.query('page')) || 1);
	const perPage = Math.min(
		MAX_PER_PAGE,
		Math.max(1, Number(c.req.query('per_page')) || DEFAULT_PER_PAGE),
	);
	const offset = (page - 1) * perPage;
	return { page, perPage, offset };
}

export function buildMeta(page: number, perPage: number, total: number) {
	return { page, per_page: perPage, total };
}

/**
 * Keyset (cursor) pagination, for feeds over tables that only grow.
 *
 * Offset pagination needs a `COUNT(*)` to render a page number, and on an
 * append-only table with no other predicate that is a full scan on every page
 * load - a cost that rises forever while telling the reader nothing they act on.
 * It also drifts: rows inserted while someone reads shift every later offset.
 * A cursor keyed on the sort columns has neither problem, and reads the index
 * it already sorts by.
 *
 * The cursor is opaque to clients: `<sort-value>|<id>`, the id breaking ties so
 * the order is total and no row can be skipped or repeated across pages. Both
 * halves are validated here because they are client-supplied and land in a typed
 * SQL comparison: the id as a uuid (every table's key is one) and the sort value
 * as a timestamp, which is what every feed built on this sorts by. A feed keyed
 * on something else needs the value check widened, not skipped.
 */
const DEFAULT_CURSOR_LIMIT = 50;
const MAX_CURSOR_LIMIT = 200;

export interface CursorPagination {
	limit: number;
	cursor: { value: string; id: string } | null;
	/**
	 * A cursor was supplied but does not parse. The caller must reject the
	 * request rather than fall back to the first page: silently restarting the
	 * feed would replay rows the client has already rendered, and the client
	 * would have no way to tell that from a genuine result.
	 */
	invalidCursor: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseCursorPagination(c: Context): CursorPagination {
	const limit = Math.min(
		MAX_CURSOR_LIMIT,
		Math.max(1, Number(c.req.query('limit')) || DEFAULT_CURSOR_LIMIT),
	);
	const raw = c.req.query('cursor');
	if (!raw) return { limit, cursor: null, invalidCursor: false };
	// Split on the LAST separator: the sort value may itself contain one.
	const at = raw.lastIndexOf('|');
	if (at <= 0 || at === raw.length - 1) return { limit, cursor: null, invalidCursor: true };
	const value = raw.slice(0, at);
	const id = raw.slice(at + 1);
	// The cursor is client-supplied and is interpolated into a typed comparison,
	// so a malformed half would otherwise reach the database and 500 on a cast.
	if (!UUID_RE.test(id) || Number.isNaN(Date.parse(value))) {
		return { limit, cursor: null, invalidCursor: true };
	}
	return { limit, cursor: { value, id }, invalidCursor: false };
}

export function encodeCursor(value: string, id: string): string {
	return `${value}|${id}`;
}

/**
 * Trim an over-fetched page (`limit + 1` rows) back to `limit` and report
 * whether more remain. Over-fetching by one is what makes `has_more` exact
 * without counting anything.
 */
export function buildCursorPage<T>(
	rows: T[],
	limit: number,
	toCursor: (row: T) => string,
): { data: T[]; meta: { has_more: boolean; next_cursor: string | null } } {
	const hasMore = rows.length > limit;
	const data = hasMore ? rows.slice(0, limit) : rows;
	const last = data[data.length - 1];
	return {
		data,
		meta: { has_more: hasMore, next_cursor: hasMore && last ? toCursor(last) : null },
	};
}
