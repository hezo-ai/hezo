import type { PGlite } from '@electric-sql/pglite';
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
	table: 'documents' | 'issues' | 'skills',
	id: string,
	text: string,
): Promise<void> {
	const embedding = await generateEmbedding(text, 'document');
	if (!embedding) return;

	const vectorStr = `[${embedding.join(',')}]`;
	await db.query(`UPDATE ${table} SET embedding = $1::vector WHERE id = $2`, [vectorStr, id]);
}

export interface SearchResult {
	type: 'kb_doc' | 'issue' | 'skill' | 'project_doc';
	id: string;
	title: string;
	snippet: string;
	score: number;
}

export type SearchScope = 'all' | 'kb_docs' | 'issues' | 'skills' | 'project_docs';

export async function semanticSearch(
	db: PGlite,
	companyId: string,
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

	const wantKb = scope === 'all' || scope === 'kb_docs';
	const wantProjectDocs = scope === 'all' || scope === 'project_docs';
	if (wantKb || wantProjectDocs) {
		const types: string[] = [];
		if (wantKb) types.push('kb_doc');
		if (wantProjectDocs) types.push('project_doc');
		const docResults = await db.query<{
			id: string;
			type: 'kb_doc' | 'project_doc';
			title: string;
			slug: string;
			content: string;
			score: number;
		}>(
			`SELECT id, type, title, slug, LEFT(content, 200) AS content,
			        1 - (embedding <=> $1::vector) AS score
			 FROM documents
			 WHERE company_id = $2 AND embedding IS NOT NULL AND type = ANY($3::document_type[])
			 ORDER BY embedding <=> $1::vector
			 LIMIT $4`,
			[vectorStr, companyId, types, limit],
		);
		for (const r of docResults.rows) {
			results.push({
				type: r.type,
				id: r.id,
				title: r.title || r.slug,
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

	results.sort((a, b) => b.score - a.score);
	return results.slice(0, limit);
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
		 WHERE embedding IS NULL AND type IN ('kb_doc', 'project_doc')
		 LIMIT 5`,
	);
	for (const doc of docs.rows) {
		const heading = doc.title || doc.slug;
		await embedAndStore(db, 'documents', doc.id, `${heading}\n${doc.content}`);
		processed++;
	}

	const issues = await db.query<{ id: string; title: string; description: string }>(
		`SELECT id, title, description FROM issues WHERE embedding IS NULL LIMIT 5`,
	);
	for (const issue of issues.rows) {
		await embedAndStore(db, 'issues', issue.id, `${issue.title}\n${issue.description}`);
		processed++;
	}

	const skills = await db.query<{ id: string; name: string; content: string }>(
		`SELECT id, name, content FROM skills WHERE embedding IS NULL AND is_active = true LIMIT 5`,
	);
	for (const skill of skills.rows) {
		await embedAndStore(db, 'skills', skill.id, `${skill.name}\n${skill.content}`);
		processed++;
	}

	return processed;
}
