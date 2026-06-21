import type { PGlite } from '@electric-sql/pglite';
import type { SearchResult, SearchScope } from '@hezo/shared';
import { buildHighlightedSnippet, hasLiteralMatch } from '../lib/snippet';
import { logger } from '../logger';

const log = logger.child('embeddings');

export const EMBEDDING_DIMENSIONS = 384;
const MODEL_ID = 'Xenova/bge-small-en-v1.5';
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

let extractor:
	| ((
			texts: string[],
			options: { pooling: string; normalize: boolean },
	  ) => Promise<{ tolist(): number[][] }>)
	| null = null;
let initPromise: Promise<void> | null = null;

export async function initializeEmbeddingModel(cacheDir?: string): Promise<void> {
	if (extractor) return;
	if (initPromise) return initPromise;

	initPromise = (async () => {
		try {
			const transformers = await import('@huggingface/transformers');
			if (cacheDir) {
				transformers.env.cacheDir = cacheDir;
			}
			const pipe = await transformers.pipeline('feature-extraction', MODEL_ID, {
				dtype: 'q8' as 'fp32',
			});
			extractor = pipe as unknown as typeof extractor;
			log.info('Model loaded:', MODEL_ID);
		} catch (err) {
			log.error('Failed to load model:', err);
			initPromise = null;
		}
	})();

	return initPromise;
}

export function isModelReady(): boolean {
	return extractor !== null;
}

export async function generateEmbedding(
	text: string,
	type: 'query' | 'document',
): Promise<number[] | null> {
	if (!extractor) return null;

	const input = type === 'query' ? `${QUERY_PREFIX}${text}` : text;
	const truncated = input.slice(0, 2000);

	const output = await extractor([truncated], { pooling: 'cls', normalize: true });
	const vectors = output.tolist();
	return vectors[0];
}

export async function embedAndStore(
	db: PGlite,
	table: 'documents' | 'tasks' | 'skills' | 'task_comments',
	id: string,
	text: string,
): Promise<void> {
	const embedding = await generateEmbedding(text, 'document');
	if (!embedding) return;

	const vectorStr = `[${embedding.join(',')}]`;
	await db.query(`UPDATE ${table} SET embedding = $1::vector WHERE id = $2`, [vectorStr, id]);
}

/**
 * Cross-team semantic search. `teamIds` scopes team-owned content (tasks, project
 * docs, comments); skills are instance-global and returned regardless of team.
 * `limit` applies **per type** — each branch caps at `limit` and the results are
 * merged sorted by score with no cross-type truncation, so callers (the web
 * palette) can group by type and show accurate per-type counts.
 */
export async function semanticSearch(
	db: PGlite,
	teamIds: string[],
	query: string,
	options: {
		scope?: SearchScope;
		limit?: number;
	} = {},
): Promise<SearchResult[]> {
	const queryEmbedding = await generateEmbedding(query, 'query');
	if (!queryEmbedding) return [];

	const vectorStr = `[${queryEmbedding.join(',')}]`;
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
			        p.slug AS project_slug, 1 - (d.embedding <=> $1::vector) AS score
			 FROM documents d
			 JOIN projects p ON p.id = d.project_id
			 WHERE d.team_id = ANY($2::uuid[]) AND d.embedding IS NOT NULL AND d.type = 'project_doc'
			 ORDER BY d.embedding <=> $1::vector
			 LIMIT $3`,
			[vectorStr, teamIds, limit],
		);
		for (const r of docResults.rows) {
			const title = r.title || r.slug;
			const { snippet, matched } = buildHighlightedSnippet(r.content, query);
			results.push({
				type: 'project_doc',
				id: r.id,
				title,
				snippet,
				semanticOnly: !matched && !hasLiteralMatch(title, query),
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
			        p.slug AS project_slug, 1 - (t.embedding <=> $1::vector) AS score
			 FROM tasks t
			 JOIN projects p ON p.id = t.project_id
			 WHERE t.team_id = ANY($2::uuid[]) AND t.embedding IS NOT NULL
			 ORDER BY t.embedding <=> $1::vector
			 LIMIT $3`,
			[vectorStr, teamIds, limit],
		);
		for (const r of taskResults.rows) {
			const title = `${r.identifier} — ${r.title}`;
			const { snippet, matched } = buildHighlightedSnippet(r.description, query);
			results.push({
				type: 'task',
				id: r.id,
				title,
				snippet,
				semanticOnly: !matched && !hasLiteralMatch(title, query),
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
			        1 - (c.embedding <=> $1::vector) AS score
			 FROM task_comments c
			 JOIN tasks t ON t.id = c.task_id
			 JOIN projects p ON p.id = t.project_id
			 WHERE t.team_id = ANY($2::uuid[]) AND c.embedding IS NOT NULL AND c.content_type = 'text'
			 ORDER BY c.embedding <=> $1::vector
			 LIMIT $3`,
			[vectorStr, teamIds, limit],
		);
		for (const r of commentResults.rows) {
			const title = `${r.identifier} — ${r.task_title}`;
			const { snippet, matched } = buildHighlightedSnippet(r.snippet, query);
			results.push({
				type: 'comment',
				id: r.id,
				title,
				snippet,
				semanticOnly: !matched && !hasLiteralMatch(title, query),
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
			`SELECT id, name, LEFT(content, 4000) AS content, 1 - (embedding <=> $1::vector) AS score
			 FROM skills
			 WHERE embedding IS NOT NULL AND is_active = true
			 ORDER BY embedding <=> $1::vector
			 LIMIT $2`,
			[vectorStr, limit],
		);
		for (const r of skillResults.rows) {
			const { snippet, matched } = buildHighlightedSnippet(r.content, query);
			results.push({
				type: 'skill',
				id: r.id,
				title: r.name,
				snippet,
				semanticOnly: !matched && !hasLiteralMatch(r.name, query),
				score: r.score,
			});
		}
	}

	results.sort((a, b) => b.score - a.score);
	return results;
}

export async function processPendingEmbeddings(db: PGlite): Promise<number> {
	if (!extractor) return 0;

	let processed = 0;

	const docs = await db.query<{
		id: string;
		type: string;
		title: string;
		slug: string;
		content: string;
	}>(
		`SELECT id, type, title, slug, content
		 FROM documents
		 WHERE embedding IS NULL AND type IN ('project_doc')
		 LIMIT 5`,
	);
	for (const doc of docs.rows) {
		const heading = doc.title || doc.slug;
		await embedAndStore(db, 'documents', doc.id, `${heading}\n${doc.content}`);
		processed++;
	}

	const tasks = await db.query<{ id: string; title: string; description: string }>(
		`SELECT id, title, description FROM tasks WHERE embedding IS NULL LIMIT 5`,
	);
	for (const task of tasks.rows) {
		await embedAndStore(db, 'tasks', task.id, `${task.title}\n${task.description}`);
		processed++;
	}

	const skills = await db.query<{ id: string; name: string; content: string }>(
		`SELECT id, name, content FROM skills WHERE embedding IS NULL AND is_active = true LIMIT 5`,
	);
	for (const skill of skills.rows) {
		await embedAndStore(db, 'skills', skill.id, `${skill.name}\n${skill.content}`);
		processed++;
	}

	// Only human/agent prose (`text`) comments — system/run/action comments are
	// auto-generated noise. Skip blank text so empties are never re-selected.
	const comments = await db.query<{ id: string; text: string }>(
		`SELECT id, content->>'text' AS text
		 FROM task_comments
		 WHERE embedding IS NULL AND content_type = 'text'
		   AND content->>'text' IS NOT NULL AND length(trim(content->>'text')) > 0
		 LIMIT 5`,
	);
	for (const comment of comments.rows) {
		await embedAndStore(db, 'task_comments', comment.id, comment.text);
		processed++;
	}

	return processed;
}
