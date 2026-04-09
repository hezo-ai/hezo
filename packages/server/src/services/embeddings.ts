import type { PGlite } from '@electric-sql/pglite';

export const EMBEDDING_DIMENSIONS = 384;
const MODEL_ID = 'Xenova/bge-small-en-v1.5';
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

// Singleton pipeline instance — typed loosely to avoid coupling to transformers.js internals
let extractor:
	| ((
			texts: string[],
			options: { pooling: string; normalize: boolean },
	  ) => Promise<{ tolist(): number[][] }>)
	| null = null;
let initPromise: Promise<void> | null = null;

/**
 * Initialize the embedding model. Downloads on first use, caches locally.
 * Safe to call multiple times — only initializes once.
 */
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
			console.log('[embeddings] Model loaded:', MODEL_ID);
		} catch (err) {
			console.error('[embeddings] Failed to load model:', err);
			initPromise = null;
		}
	})();

	return initPromise;
}

/**
 * Check if the embedding model is ready.
 */
export function isModelReady(): boolean {
	return extractor !== null;
}

/**
 * Generate an embedding vector from text.
 * Returns null if the model isn't loaded.
 */
export async function generateEmbedding(
	text: string,
	type: 'query' | 'document',
): Promise<number[] | null> {
	if (!extractor) return null;

	const input = type === 'query' ? `${QUERY_PREFIX}${text}` : text;
	// Truncate to ~500 tokens worth of text to stay within model limits
	const truncated = input.slice(0, 2000);

	const output = await extractor([truncated], { pooling: 'cls', normalize: true });
	const vectors = output.tolist();
	return vectors[0];
}

/**
 * Generate an embedding and store it in the specified table row.
 * No-op if model not loaded.
 */
export async function embedAndStore(
	db: PGlite,
	table: 'kb_docs' | 'issues' | 'skills',
	id: string,
	text: string,
): Promise<void> {
	const embedding = await generateEmbedding(text, 'document');
	if (!embedding) return;

	const vectorStr = `[${embedding.join(',')}]`;
	await db.query(`UPDATE ${table} SET embedding = $1::vector WHERE id = $2`, [vectorStr, id]);
}

export interface SearchResult {
	type: 'kb_doc' | 'issue' | 'skill';
	id: string;
	title: string;
	snippet: string;
	score: number;
}

/**
 * Semantic search across kb_docs, issues, and skills.
 * Company-scoped. Returns ranked results.
 */
export async function semanticSearch(
	db: PGlite,
	companyId: string,
	query: string,
	options: {
		scope?: 'all' | 'kb_docs' | 'issues' | 'skills';
		limit?: number;
	} = {},
): Promise<SearchResult[]> {
	const queryEmbedding = await generateEmbedding(query, 'query');
	if (!queryEmbedding) return [];

	const vectorStr = `[${queryEmbedding.join(',')}]`;
	const limit = options.limit ?? 10;
	const scope = options.scope ?? 'all';
	const results: SearchResult[] = [];

	if (scope === 'all' || scope === 'kb_docs') {
		const kbResults = await db.query<{ id: string; title: string; content: string; score: number }>(
			`SELECT id, title, LEFT(content, 200) AS content, 1 - (embedding <=> $1::vector) AS score
			 FROM kb_docs
			 WHERE company_id = $2 AND embedding IS NOT NULL
			 ORDER BY embedding <=> $1::vector
			 LIMIT $3`,
			[vectorStr, companyId, limit],
		);
		for (const r of kbResults.rows) {
			results.push({
				type: 'kb_doc',
				id: r.id,
				title: r.title,
				snippet: r.content,
				score: r.score,
			});
		}
	}

	if (scope === 'all' || scope === 'issues') {
		const issueResults = await db.query<{
			id: string;
			title: string;
			description: string;
			identifier: string;
			score: number;
		}>(
			`SELECT id, title, LEFT(description, 200) AS description, identifier, 1 - (embedding <=> $1::vector) AS score
			 FROM issues
			 WHERE company_id = $2 AND embedding IS NOT NULL
			 ORDER BY embedding <=> $1::vector
			 LIMIT $3`,
			[vectorStr, companyId, limit],
		);
		for (const r of issueResults.rows) {
			results.push({
				type: 'issue',
				id: r.id,
				title: `${r.identifier} — ${r.title}`,
				snippet: r.description,
				score: r.score,
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
			`SELECT id, name, LEFT(content, 200) AS content, 1 - (embedding <=> $1::vector) AS score
			 FROM skills
			 WHERE company_id = $2 AND embedding IS NOT NULL AND is_active = true
			 ORDER BY embedding <=> $1::vector
			 LIMIT $3`,
			[vectorStr, companyId, limit],
		);
		for (const r of skillResults.rows) {
			results.push({ type: 'skill', id: r.id, title: r.name, snippet: r.content, score: r.score });
		}
	}

	// Sort all results by score descending
	results.sort((a, b) => b.score - a.score);
	return results.slice(0, limit);
}

/**
 * Process pending embeddings — finds rows with NULL embedding and generates them.
 * Call periodically from a background job.
 */
export async function processPendingEmbeddings(db: PGlite): Promise<number> {
	if (!extractor) return 0;

	let processed = 0;

	// KB docs
	const kbDocs = await db.query<{ id: string; title: string; content: string }>(
		`SELECT id, title, content FROM kb_docs WHERE embedding IS NULL LIMIT 5`,
	);
	for (const doc of kbDocs.rows) {
		await embedAndStore(db, 'kb_docs', doc.id, `${doc.title}\n${doc.content}`);
		processed++;
	}

	// Issues
	const issues = await db.query<{ id: string; title: string; description: string }>(
		`SELECT id, title, description FROM issues WHERE embedding IS NULL LIMIT 5`,
	);
	for (const issue of issues.rows) {
		await embedAndStore(db, 'issues', issue.id, `${issue.title}\n${issue.description}`);
		processed++;
	}

	// Skills
	const skills = await db.query<{ id: string; name: string; content: string }>(
		`SELECT id, name, content FROM skills WHERE embedding IS NULL AND is_active = true LIMIT 5`,
	);
	for (const skill of skills.rows) {
		await embedAndStore(db, 'skills', skill.id, `${skill.name}\n${skill.content}`);
		processed++;
	}

	return processed;
}
