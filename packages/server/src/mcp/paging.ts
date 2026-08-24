import { z } from 'zod';
import { buildCursorPage, decodeCursor, encodeCursor } from '../lib/pagination';

export { decodeCursor, encodeCursor };

/** A decoded keyset position: the sort half plus the row id tiebreak. */
export type DecodedCursor = { value: string; id: string };

/**
 * Shared paging primitives for the MCP tool surface.
 *
 * Every read tool that can return a list of rows or an unbounded blob of
 * content pages through one of exactly two shapes, so an agent learns the
 * convention once instead of per tool:
 *
 * - **Lists** use keyset paging: `limit` + an opaque `cursor` in, and an
 *   `{ items, next_cursor, has_more }` envelope out. Keyset rather than
 *   OFFSET so a page boundary stays stable while rows are being inserted,
 *   and `has_more` rather than `COUNT(*)` so a table that only grows never
 *   pays a full scan to render a page (AGENTS.md, "Design for scale").
 * - **Large single content** uses byte windows: `offset` + `max_bytes` in,
 *   and `{ content, offset, returned_bytes, total_bytes, next_offset }` out.
 *
 * Both shapes report their own continuation, so a paged result is
 * self-describing: an agent that has never seen the convention can still
 * follow `next_cursor`/`next_offset` to the end from the response alone.
 */

/** Rows returned when a caller does not ask for a specific page size. */
export const DEFAULT_LIST_LIMIT = 50;

/**
 * Ceiling on rows per page. Matches the REST `parsePagination` ceiling so the
 * two surfaces agree on what "one page" means; the byte guard in `tool()` is
 * the backstop for rows that are individually wide.
 */
export const MAX_LIST_LIMIT = 200;

export type PagedList<T> = {
	items: T[];
	next_cursor: string | null;
	has_more: boolean;
	paging_hint?: string;
};

/**
 * A row orderable by a `(<sort column>, id)` keyset. The sort column is
 * `created_at` for most tools; a few order on their own timestamp (run rows on
 * `started_at`), so it is a parameter rather than a hard-coded name.
 */
export type KeysetRow = {
	id: string;
} & Record<string, unknown>;

/** Default keyset sort column. */
export const DEFAULT_SORT_COLUMN = 'created_at';

/**
 * How a list tool orders its rows, so the cursor predicate matches the ORDER BY
 * exactly. A mismatch silently skips or repeats rows at a page boundary.
 *
 * Time-ordered lists (tasks, runs, approvals) page newest-first on a timestamp;
 * name-ordered lists (teams, agents, templates) page ascending on a text
 * column. Both need the row `id` as a tiebreak, or rows sharing a sort value
 * straddle the boundary.
 */
export type KeysetOpts = {
	/** Sort column on the aliased table. Default `created_at`. */
	column?: string;
	/** Sort direction. Default `desc`, matching newest-first lists. */
	direction?: 'asc' | 'desc';
	/** Postgres cast for the sort bind param. Default `timestamptz`. */
	cast?: string;
	/**
	 * Table alias holding the row `id`, when it differs from the alias holding
	 * the sort column (a join that sorts on one side and keys on the other).
	 * Defaults to the sort column's alias.
	 */
	idAlias?: string;
};

/**
 * SQL fragment continuing a `ORDER BY <alias>.created_at DESC, <alias>.id DESC`
 * scan after `cursor`, pushing its two bind params onto `params`.
 *
 * Compares the row tuple directly rather than looking the anchor row up in a
 * subquery, so the predicate can use a `(created_at, id)` index and does not
 * break when the anchor row has been deleted. Returns null when there is no
 * cursor, so callers can spread it into their conditions unconditionally.
 */
export function keysetPredicate(
	alias: string,
	cursor: DecodedCursor | null,
	params: unknown[],
	opts: KeysetOpts = {},
): string | null {
	if (!cursor) return null;
	const column = opts.column ?? DEFAULT_SORT_COLUMN;
	const cmp = (opts.direction ?? 'desc') === 'desc' ? '<' : '>';
	const cast = opts.cast ?? 'timestamptz';
	const idAlias = opts.idAlias ?? alias;
	const a = params.push(cursor.value);
	const b = params.push(cursor.id);
	return `(${alias}.${column}, ${idAlias}.id) ${cmp} ($${a}::${cast}, $${b}::uuid)`;
}

/** ORDER BY matching `keysetPredicate`'s comparison, so pages line up. */
export function keysetOrderBy(alias: string, opts: KeysetOpts = {}): string {
	const column = opts.column ?? DEFAULT_SORT_COLUMN;
	const dir = (opts.direction ?? 'desc') === 'desc' ? 'DESC' : 'ASC';
	const idAlias = opts.idAlias ?? alias;
	return `${alias}.${column} ${dir}, ${idAlias}.id ${dir}`;
}

/** Clamp a caller-supplied page size into [1, MAX_LIST_LIMIT]. */
export function parseListLimit(limit: unknown): number {
	if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
	return Math.max(1, Math.min(Math.floor(limit), MAX_LIST_LIMIT));
}

/**
 * Build the list envelope from an over-fetched row set.
 *
 * Callers query `limit + 1` rows; the extra row is the `has_more` probe and is
 * dropped from `items`. That keeps the "is there another page" answer exact
 * without a second query or a `COUNT(*)`.
 */
export function pagedList<T extends Record<string, unknown>>(
	rows: T[],
	limit: number,
	toolName: string,
	opts: {
		/** Row field the cursor's sort half is read from. Default `created_at`. */
		column?: string;
		/** Row field holding the stable identity. Default `id`. */
		idKey?: string;
	} = {},
): PagedList<T> {
	const column = opts.column ?? DEFAULT_SORT_COLUMN;
	const idKey = opts.idKey ?? 'id';
	const { data, meta } = buildCursorPage(rows, limit, (row) => {
		const sortValue = row[column];
		const iso = sortValue instanceof Date ? sortValue.toISOString() : String(sortValue ?? '');
		return encodeCursor(iso, String(row[idKey]));
	});
	return {
		items: data,
		next_cursor: meta.next_cursor,
		has_more: meta.has_more,
		...(meta.next_cursor !== null
			? {
					paging_hint: `More rows exist beyond this page of ${data.length}. Call ${toolName} again with cursor: "${meta.next_cursor}"; repeat until has_more is false.`,
				}
			: {}),
	};
}

/**
 * Shared `limit`/`cursor` schema fragment, so every list tool declares paging
 * identically and the `result_too_large` guard can detect it generically.
 *
 * Descriptions here are rendered verbatim into docs/reference/mcp-api.md and
 * re-emitted on GET /SKILL.md, so they use hyphens, never em or en dashes.
 */
export function listPagingArgs() {
	return {
		limit: z
			.number()
			.int()
			.positive()
			.max(MAX_LIST_LIMIT)
			.optional()
			.describe(
				`Max rows to return in this page (default ${DEFAULT_LIST_LIMIT}, ceiling ${MAX_LIST_LIMIT}).`,
			),
		cursor: z
			.string()
			.optional()
			.describe(
				'Opaque cursor from a previous call. Pass back the `next_cursor` you were given to fetch the following page; keep going until `has_more` is false. Treat it as opaque - do not construct or parse one.',
			),
	};
}

/**
 * Largest index <= `end` that does not fall inside a multi-byte UTF-8
 * codepoint, so a Buffer slice taken at this index never splits a character.
 * UTF-8 continuation bytes match 0b10xxxxxx; back off them onto the preceding
 * lead byte. Applied to a window start (the slice includes it, keeping the
 * whole leading codepoint) and to a window end (the slice excludes it,
 * dropping a partial trailing codepoint).
 */
export function utf8FloorBoundary(buf: Buffer, end: number): number {
	let e = Math.max(0, Math.min(end, buf.length));
	while (e > 0 && e < buf.length && (buf[e] & 0xc0) === 0x80) e--;
	return e;
}

export type ContentWindow = {
	content: string;
	offset: number;
	returned_bytes: number;
	total_bytes: number;
	next_offset: number | null;
	truncated: boolean;
	paging_hint?: string;
};

/**
 * Window a large text body so the serialized result stays under a tool's byte
 * cap, letting an agent page arbitrarily large content via `offset`/
 * `next_offset` instead of tripping the generic `result_too_large` guard.
 *
 * `build` wraps the window in the tool's own result shape; it is called
 * repeatedly because a byte-accurate content window can still serialize larger
 * than its byte count (JSON escaping inflates newlines, quotes and
 * backslashes, and a tool's sibling metadata adds bytes on top). The loop
 * measures with the same serialization the wrapper guard uses and trims until
 * it fits. It terminates because the budget strictly shrinks; if the metadata
 * alone exceeds the cap, content trims to empty and the generic guard reports
 * `result_too_large` - which is the honest answer at that point.
 */
export function windowContent<T>(opts: {
	text: string;
	offset?: number;
	maxBytes?: number;
	/** Effective byte cap for the whole serialized result. */
	limit: number;
	/** Headroom reserved for the result envelope around the content. */
	reserve: number;
	/** Wrap a window in the calling tool's result shape. */
	build: (window: ContentWindow) => T;
	/** Continuation sentence, given the window's position. */
	hint: (position: { start: number; end: number; total: number }) => string;
}): T {
	const { text, limit, reserve, build, hint } = opts;
	const buf = Buffer.from(text, 'utf8');
	const total = buf.length;
	const start = utf8FloorBoundary(buf, Math.max(0, Math.min(opts.offset ?? 0, total)));
	const requested = opts.maxBytes ?? limit;
	let budget = Math.min(requested, limit - reserve);
	let end = utf8FloorBoundary(buf, start + budget);

	const shape = (e: number): T => {
		const nextOffset = e < total ? e : null;
		return build({
			content: buf.subarray(start, e).toString('utf8'),
			offset: start,
			returned_bytes: e - start,
			total_bytes: total,
			next_offset: nextOffset,
			truncated: start > 0 || e < total,
			...(nextOffset !== null ? { paging_hint: hint({ start, end: e, total }) } : {}),
		});
	};

	let result = shape(end);
	while (end > start && Buffer.byteLength(JSON.stringify(result, null, 2), 'utf8') > limit) {
		budget = Math.max(0, Math.floor(budget * 0.9) - 1);
		end = utf8FloorBoundary(buf, start + budget);
		result = shape(end);
	}
	return result;
}

/**
 * Trim an already-loaded text window until the serialized result fits `limit`.
 *
 * The character-based sibling of `windowContent`'s byte loop, for tools that
 * window in storage by character offset and never hold the full body -
 * `get_run_log` reads only the requested slice from the chunk store, so the
 * shrink has to run on that slice rather than on the whole text. The loop is
 * what stands between an escape-dense window and the `result_too_large` guard:
 * JSON escaping can inflate a log several-fold past its character count, and a
 * discarded-whole result on a tool's DEFAULT parameters leaves the caller no
 * working spelling at all - the failure mode that once had a reviewer repeat
 * the same rejected call thousands of times.
 *
 * `keep` names which end survives: a tail keeps its end, a forward window its
 * start. `build` wraps the kept text in the tool's own result shape and is
 * measured with the same serialization the admission guard uses. Terminates
 * because the kept length strictly shrinks; an empty window that still does not
 * fit falls through to the guard, which is the honest answer at that point.
 */
export function fitSerializedWindow<T>(opts: {
	text: string;
	keep: 'start' | 'end';
	/** Effective byte cap for the whole serialized result. */
	limit: number;
	/** Wrap the kept text in the calling tool's result shape. */
	build: (kept: string) => T;
}): T {
	let kept = opts.text;
	let result = opts.build(kept);
	while (
		kept.length > 0 &&
		Buffer.byteLength(JSON.stringify(result, null, 2), 'utf8') > opts.limit
	) {
		const next = Math.max(0, Math.floor(kept.length * 0.9) - 1);
		kept = opts.keep === 'start' ? kept.slice(0, next) : kept.slice(kept.length - next);
		result = opts.build(kept);
	}
	return result;
}
