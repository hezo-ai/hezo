import type { PGlite } from '@electric-sql/pglite';
import type { SearchResult, SearchScope } from '@hezo/shared';
import { buildHighlightedSnippet } from '../lib/snippet';

const TEXT_SEARCH_CONFIG = 'english';

/**
 * Turn raw user input into a `to_tsquery`-safe string for as-you-type search:
 * split into alphanumeric terms, AND them together, and make the final term a
 * prefix match (`foo & bar:*`) so "log" matches "login" before the word is
 * finished. Returns '' when there is no usable term, so callers can short-circuit
 * to no results rather than handing an empty query to Postgres.
 */
export function buildSearchTsQuery(raw: string): string {
	const terms = raw
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
	if (terms.length === 0) return '';
	return terms.map((term, i) => (i === terms.length - 1 ? `${term}:*` : term)).join(' & ');
}

/**
 * Cross-team full-text search over project docs, tasks, comments and skills,
 * backed by the generated `search_tsv` columns (+ GIN indexes) in the schema.
 * There is no model to load and no async indexing step — a row is searchable the
 * moment it is written, since `search_tsv` is a STORED generated column.
 *
 * `teamIds` scopes team-owned content (tasks, project docs, comments); skills are
 * instance-global and returned regardless of team. `limit` applies **per type** —
 * each branch caps at `limit` and the results are merged sorted by rank with no
 * cross-type truncation, so callers (the web palette) can group by type and show
 * accurate per-type counts.
 */
export async function fullTextSearch(
	db: PGlite,
	teamIds: string[],
	query: string,
	options: {
		scope?: SearchScope;
		limit?: number;
	} = {},
): Promise<SearchResult[]> {
	const tsQuery = buildSearchTsQuery(query);
	if (!tsQuery) return [];

	const limit = options.limit ?? 10;
	const scope = options.scope ?? 'all';
	const results: SearchResult[] = [];

	if (scope === 'all' || scope === 'project_docs') {
		const docResults = await db.query<{
			id: string;
			title: string;
			slug: string;
			content: string;
			project_slug: string;
			score: number;
		}>(
			`SELECT d.id, d.title, d.slug, LEFT(d.content, 4000) AS content,
			        p.slug AS project_slug, ts_rank(d.search_tsv, q) AS score
			 FROM documents d
			 JOIN projects p ON p.id = d.project_id,
			      to_tsquery('${TEXT_SEARCH_CONFIG}', $1) q
			 WHERE d.team_id = ANY($2::uuid[]) AND d.type = 'project_doc'
			   AND d.archived_at IS NULL AND d.search_tsv @@ q
			 ORDER BY score DESC
			 LIMIT $3`,
			[tsQuery, teamIds, limit],
		);
		for (const r of docResults.rows) {
			const title = r.title || r.slug;
			const { snippet } = buildHighlightedSnippet(r.content, query);
			results.push({
				type: 'project_doc',
				id: r.id,
				title,
				snippet,
				score: r.score,
				projectSlug: r.project_slug,
				docSlug: r.slug,
			});
		}
	}

	if (scope === 'all' || scope === 'tasks') {
		const taskResults = await db.query<{
			id: string;
			title: string;
			description: string;
			identifier: string;
			project_slug: string;
			score: number;
		}>(
			`SELECT t.id, t.title, LEFT(t.description, 4000) AS description, t.identifier,
			        p.slug AS project_slug, ts_rank(t.search_tsv, q) AS score
			 FROM tasks t
			 JOIN projects p ON p.id = t.project_id,
			      to_tsquery('${TEXT_SEARCH_CONFIG}', $1) q
			 WHERE t.team_id = ANY($2::uuid[]) AND t.search_tsv @@ q
			 ORDER BY score DESC
			 LIMIT $3`,
			[tsQuery, teamIds, limit],
		);
		for (const r of taskResults.rows) {
			const title = `${r.identifier} — ${r.title}`;
			const { snippet } = buildHighlightedSnippet(r.description, query);
			results.push({
				type: 'task',
				id: r.id,
				title,
				snippet,
				score: r.score,
				projectSlug: r.project_slug,
				taskIdentifier: r.identifier,
			});
		}
	}

	if (scope === 'all' || scope === 'comments') {
		const commentResults = await db.query<{
			id: string;
			public_id: string;
			identifier: string;
			task_title: string;
			project_slug: string;
			snippet: string;
			score: number;
		}>(
			`SELECT c.id, c.public_id, t.identifier, t.title AS task_title,
			        p.slug AS project_slug, LEFT(c.content->>'text', 4000) AS snippet,
			        ts_rank(c.search_tsv, q) AS score
			 FROM task_comments c
			 JOIN tasks t ON t.id = c.task_id
			 JOIN projects p ON p.id = t.project_id,
			      to_tsquery('${TEXT_SEARCH_CONFIG}', $1) q
			 WHERE t.team_id = ANY($2::uuid[]) AND c.content_type = 'text' AND c.search_tsv @@ q
			 ORDER BY score DESC
			 LIMIT $3`,
			[tsQuery, teamIds, limit],
		);
		for (const r of commentResults.rows) {
			const title = `${r.identifier} — ${r.task_title}`;
			const { snippet } = buildHighlightedSnippet(r.snippet, query);
			results.push({
				type: 'comment',
				id: r.id,
				title,
				snippet,
				score: r.score,
				projectSlug: r.project_slug,
				taskIdentifier: r.identifier,
				commentPublicId: r.public_id,
			});
		}
	}

	if (scope === 'all' || scope === 'skills') {
		const skillResults = await db.query<{
			id: string;
			name: string;
			content: string;
			score: number;
		}>(
			`SELECT id, name, LEFT(content, 4000) AS content, ts_rank(search_tsv, q) AS score
			 FROM skills, to_tsquery('${TEXT_SEARCH_CONFIG}', $1) q
			 WHERE is_active = true AND search_tsv @@ q
			 ORDER BY score DESC
			 LIMIT $2`,
			[tsQuery, limit],
		);
		for (const r of skillResults.rows) {
			const { snippet } = buildHighlightedSnippet(r.content, query);
			results.push({
				type: 'skill',
				id: r.id,
				title: r.name,
				snippet,
				score: r.score,
			});
		}
	}

	results.sort((a, b) => b.score - a.score);
	return results;
}
