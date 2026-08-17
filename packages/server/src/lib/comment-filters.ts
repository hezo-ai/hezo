import {
	contentTypesForCategories,
	DEFAULT_THREAD_ROW_CATEGORIES,
	THREAD_ROW_CATEGORIES,
	type ThreadRowCategory,
} from '@hezo/shared';

/**
 * The default selection's predicate, spelled as one literal.
 *
 * It must stay character-identical to the `WHERE` clause of
 * `idx_comments_task_created_no_run` in `063_run_health.sql`: the planner only
 * uses a partial index when it can prove the query implies the index predicate,
 * and an equivalent-but-differently-spelled clause reads as a plain filter over
 * the whole thread instead.
 */
export const COMMENT_NO_RUN_PREDICATE = `content_type <> 'run'::comment_content_type`;

function sameCategories(a: readonly ThreadRowCategory[], b: readonly ThreadRowCategory[]): boolean {
	return a.length === b.length && a.every((c) => b.includes(c));
}

/**
 * SQL fragment restricting a comment read to a set of thread-row categories,
 * pushing any bind param onto `params`.
 *
 * Returns null when every category is wanted, so a caller reading the whole
 * thread pays no predicate at all. Callers spread the result into their
 * conditions unconditionally.
 */
export function commentCategoryPredicate(
	alias: string,
	categories: readonly ThreadRowCategory[],
	params: unknown[],
): string | null {
	if (sameCategories(categories, THREAD_ROW_CATEGORIES)) return null;
	// The one selection with a dedicated index gets that index's own spelling.
	if (sameCategories(categories, DEFAULT_THREAD_ROW_CATEGORIES)) {
		return `${alias}.${COMMENT_NO_RUN_PREDICATE}`;
	}
	const i = params.push(contentTypesForCategories(categories));
	return `${alias}.content_type = ANY($${i}::comment_content_type[])`;
}

/**
 * Whether a caller-supplied `since` is a timestamp Postgres will accept.
 *
 * Checked before it reaches the query: the value is cast to `timestamptz`, so an
 * unparseable one fails inside the statement and surfaces as an internal error
 * rather than telling the caller what was wrong with what it sent.
 */
export function isValidSince(value: string): boolean {
	return !Number.isNaN(Date.parse(value));
}

/**
 * SQL fragment restricting a comment read to rows created after `since`, pushing
 * its bind param onto `params`. Strictly after, so passing the timestamp a
 * previous read ended at returns what has happened since and nothing twice.
 *
 * Callers validate with {@link isValidSince} first; an unchecked value reaches
 * the cast and fails there.
 */
export function commentSincePredicate(
	alias: string,
	since: string | undefined,
	params: unknown[],
): string | null {
	if (!since) return null;
	const i = params.push(since);
	return `${alias}.created_at > $${i}::timestamptz`;
}
