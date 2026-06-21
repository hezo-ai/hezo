import type { PGlite } from '@electric-sql/pglite';
import { HIGHLIGHT_SENTINEL } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHighlightedSnippet, hasLiteralMatch } from '../src/lib/snippet';
import {
	EMBEDDING_DIMENSIONS,
	embedAndStore,
	generateEmbedding,
	isModelReady,
	processPendingEmbeddings,
	semanticSearch,
} from '../src/services/embeddings';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

let db: PGlite;
let teamId: string;
let projectId: string;

// Create a fake embedding vector of the correct dimensions
function fakeVector(seed = 0.5): number[] {
	return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => Math.sin(i * seed));
}

function vectorStr(vec: number[]): string {
	return `[${vec.join(',')}]`;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;

	// Create a team and project directly
	const teamResult = await db.query<{ id: string }>(
		"INSERT INTO teams (name, slug) VALUES ('Embed Co', 'embed-co') RETURNING id",
	);
	teamId = teamResult.rows[0].id;

	const projectResult = await db.query<{ id: string }>(
		"INSERT INTO projects (team_id, name, slug, task_prefix) VALUES ($1, 'Embed Project', 'embed-project', 'EP') RETURNING id",
		[teamId],
	);
	projectId = projectResult.rows[0].id;
	await db.query('INSERT INTO project_task_counters (project_id, next_number) VALUES ($1, 1)', [
		projectId,
	]);
});

afterAll(async () => {
	await safeClose(db);
});

describe('EMBEDDING_DIMENSIONS', () => {
	it('is 384 for bge-small-en-v1.5', () => {
		expect(EMBEDDING_DIMENSIONS).toBe(384);
	});
});

describe('isModelReady', () => {
	it('returns false when model has not been initialized', () => {
		// The model is not loaded during tests (no transformers.js)
		expect(isModelReady()).toBe(false);
	});
});

describe('generateEmbedding', () => {
	it('returns null when model is not loaded', async () => {
		const result = await generateEmbedding('hello world', 'document');
		expect(result).toBeNull();
	});

	it('returns null for query type when model is not loaded', async () => {
		const result = await generateEmbedding('search query', 'query');
		expect(result).toBeNull();
	});
});

describe('embedAndStore', () => {
	it('is a no-op when model is not loaded', async () => {
		const docResult = await db.query<{ id: string }>(
			`INSERT INTO documents (team_id, project_id, type, slug, title, content)
			 VALUES ($1, $2, 'project_doc', 'embed-test', 'Embed Test', 'content') RETURNING id`,
			[teamId, projectId],
		);
		const docId = docResult.rows[0].id;

		await embedAndStore(db, 'documents', docId, 'Embed Test\ncontent');

		const check = await db.query<{ embedding: unknown }>(
			'SELECT embedding FROM documents WHERE id = $1',
			[docId],
		);
		expect(check.rows[0].embedding).toBeNull();
	});
});

describe('semanticSearch', () => {
	it('returns empty array when model is not loaded', async () => {
		const results = await semanticSearch(db, [teamId], 'test query');
		expect(results).toEqual([]);
	});

	it('returns empty array with scope filter when model is not loaded', async () => {
		const results = await semanticSearch(db, [teamId], 'test', { scope: 'project_docs' });
		expect(results).toEqual([]);
	});
});

describe('semanticSearch with pre-populated embeddings', () => {
	beforeAll(async () => {
		const vec2 = fakeVector(0.6);
		const vec3 = fakeVector(0.9);
		const vec4 = fakeVector(1.2);

		const numRes = await db.query<{ number: number }>(
			'SELECT next_project_task_number($1) AS number',
			[projectId],
		);
		const num = numRes.rows[0].number;

		await db.query(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, description, embedding)
			 VALUES ($1, $2, $3, $4, 'Fix login bug', 'Users cannot log in with SSO', $5::vector)`,
			[teamId, projectId, num, `EP-${num}`, vectorStr(vec2)],
		);

		await db.query(
			`INSERT INTO skills (name, slug, content, is_active, embedding)
			 VALUES ('Deploy Skill', 'deploy-skill', 'How to deploy to production', true, $1::vector)`,
			[vectorStr(vec3)],
		);

		await db.query(
			`INSERT INTO documents (team_id, project_id, type, slug, content, embedding)
			 VALUES ($1, $2, 'project_doc', 'spec.md', 'Product spec for the project', $3::vector)`,
			[teamId, projectId, vectorStr(vec4)],
		);
	});

	it('tasks query returns results with valid embeddings', async () => {
		const queryVec = fakeVector(0.61);
		const r = await db.query<{ id: string; title: string; score: number }>(
			`SELECT id, title, 1 - (embedding <=> $1::vector) AS score
			 FROM tasks
			 WHERE team_id = $2 AND embedding IS NOT NULL
			 ORDER BY embedding <=> $1::vector
			 LIMIT 5`,
			[vectorStr(queryVec), teamId],
		);
		expect(r.rows.length).toBeGreaterThanOrEqual(1);
		expect(r.rows[0].title).toBe('Fix login bug');
	});

	it('skills query returns only active skills', async () => {
		const queryVec = fakeVector(0.91);
		const r = await db.query<{ id: string; name: string; score: number }>(
			`SELECT id, name, 1 - (embedding <=> $1::vector) AS score
			 FROM skills
			 WHERE embedding IS NOT NULL AND is_active = true
			 ORDER BY embedding <=> $1::vector
			 LIMIT 5`,
			[vectorStr(queryVec)],
		);
		expect(r.rows.length).toBeGreaterThanOrEqual(1);
		expect(r.rows[0].name).toBe('Deploy Skill');
	});

	it('project_docs query returns results', async () => {
		const queryVec = fakeVector(1.21);
		const r = await db.query<{ id: string; filename: string; score: number }>(
			`SELECT id, slug AS filename, 1 - (embedding <=> $1::vector) AS score
			 FROM documents
			 WHERE type = 'project_doc' AND team_id = $2 AND embedding IS NOT NULL
			 ORDER BY embedding <=> $1::vector
			 LIMIT 5`,
			[vectorStr(queryVec), teamId],
		);
		expect(r.rows.length).toBeGreaterThanOrEqual(1);
		expect(r.rows[0].filename).toBe('spec.md');
	});

	it('results are team-scoped', async () => {
		const co2 = await db.query<{ id: string }>(
			"INSERT INTO teams (name, slug) VALUES ('Other Co', 'other-co') RETURNING id",
		);
		const otherTeamId = co2.rows[0].id;

		const queryVec = fakeVector(0.31);
		const r = await db.query<{ id: string }>(
			`SELECT id FROM documents
			 WHERE type = 'project_doc' AND team_id = $2 AND embedding IS NOT NULL
			 ORDER BY embedding <=> $1::vector
			 LIMIT 5`,
			[vectorStr(queryVec), otherTeamId],
		);
		expect(r.rows.length).toBe(0);
	});
});

describe('comment search with pre-populated embeddings', () => {
	let commentTaskId: string;
	const commentVec = fakeVector(0.42);

	beforeAll(async () => {
		const numRes = await db.query<{ number: number }>(
			'SELECT next_project_task_number($1) AS number',
			[projectId],
		);
		const num = numRes.rows[0].number;
		const taskRes = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, description)
			 VALUES ($1, $2, $3, $4, 'Payment flow', 'Stripe checkout') RETURNING id`,
			[teamId, projectId, num, `EP-${num}`],
		);
		commentTaskId = taskRes.rows[0].id;

		await db.query(
			`INSERT INTO task_comments (task_id, content_type, content, embedding)
			 VALUES ($1, 'text', $2::jsonb, $3::vector)`,
			[
				commentTaskId,
				JSON.stringify({ text: 'We should retry failed Stripe webhooks' }),
				vectorStr(commentVec),
			],
		);
	});

	it('comment query returns the text comment joined to its task + project', async () => {
		const queryVec = fakeVector(0.421);
		const r = await db.query<{
			id: string;
			identifier: string;
			project_slug: string;
			snippet: string;
			score: number;
		}>(
			`SELECT c.id, t.identifier, p.slug AS project_slug, c.content->>'text' AS snippet,
			        1 - (c.embedding <=> $1::vector) AS score
			 FROM task_comments c
			 JOIN tasks t ON t.id = c.task_id
			 JOIN projects p ON p.id = t.project_id
			 WHERE t.team_id = ANY($2::uuid[]) AND c.embedding IS NOT NULL AND c.content_type = 'text'
			 ORDER BY c.embedding <=> $1::vector
			 LIMIT 5`,
			[vectorStr(queryVec), [teamId]],
		);
		expect(r.rows.length).toBeGreaterThanOrEqual(1);
		expect(r.rows[0].project_slug).toBe('embed-project');
		expect(r.rows[0].snippet).toContain('Stripe');
	});

	it('comment search is team-scoped (another team sees nothing)', async () => {
		const other = await db.query<{ id: string }>(
			"INSERT INTO teams (name, slug) VALUES ('Comment Other Co', 'comment-other-co') RETURNING id",
		);
		const queryVec = fakeVector(0.421);
		const r = await db.query<{ id: string }>(
			`SELECT c.id
			 FROM task_comments c
			 JOIN tasks t ON t.id = c.task_id
			 WHERE t.team_id = ANY($2::uuid[]) AND c.embedding IS NOT NULL AND c.content_type = 'text'
			 ORDER BY c.embedding <=> $1::vector
			 LIMIT 5`,
			[vectorStr(queryVec), [other.rows[0].id]],
		);
		expect(r.rows.length).toBe(0);
	});

	it('backfill selects only non-empty text comments (system + blank excluded)', async () => {
		await db.query(
			`INSERT INTO task_comments (task_id, content_type, content)
			 VALUES ($1, 'system', $2::jsonb), ($1, 'text', $3::jsonb)`,
			[commentTaskId, JSON.stringify({ kind: 'status_change' }), JSON.stringify({ text: '   ' })],
		);
		const r = await db.query<{ content_type: string; text: string }>(
			`SELECT content_type, content->>'text' AS text
			 FROM task_comments
			 WHERE embedding IS NULL AND content_type = 'text'
			   AND content->>'text' IS NOT NULL AND length(trim(content->>'text')) > 0`,
		);
		for (const row of r.rows) {
			expect(row.content_type).toBe('text');
			expect(row.text.trim().length).toBeGreaterThan(0);
		}
	});
});

describe('snippet shaping over real DB rows', () => {
	// The seeded comment text is "We should retry failed Stripe webhooks" on a
	// task titled "Payment flow" (see the comment-search beforeAll above).
	async function fetchCommentRow() {
		// Mirrors the production comment query's widened projection.
		const r = await db.query<{ snippet: string; identifier: string; task_title: string }>(
			`SELECT LEFT(c.content->>'text', 4000) AS snippet, t.identifier, t.title AS task_title
			 FROM task_comments c
			 JOIN tasks t ON t.id = c.task_id
			 WHERE c.content_type = 'text' AND c.content->>'text' ILIKE '%Stripe%'
			 LIMIT 1`,
		);
		expect(r.rows.length).toBe(1);
		return r.rows[0];
	}

	it('builds a highlighted snippet from the widened select; not semantic-only', async () => {
		const row = await fetchCommentRow();
		const { snippet, matched } = buildHighlightedSnippet(row.snippet, 'stripe');
		expect(matched).toBe(true);
		// Case-insensitive match, original casing preserved inside the marker pair.
		expect(snippet).toContain(`${HIGHLIGHT_SENTINEL}Stripe${HIGHLIGHT_SENTINEL}`);

		const title = `${row.identifier} — ${row.task_title}`;
		expect(!matched && !hasLiteralMatch(title, 'stripe')).toBe(false);
	});

	it('flags semantic-only when the term is in neither body nor title', async () => {
		const row = await fetchCommentRow();
		const query = 'kubernetes'; // absent from both the comment and the task title
		const { snippet, matched } = buildHighlightedSnippet(row.snippet, query);
		expect(matched).toBe(false);
		expect(snippet).not.toContain(HIGHLIGHT_SENTINEL); // lead-text fallback, no marker

		const title = `${row.identifier} — ${row.task_title}`;
		expect(!matched && !hasLiteralMatch(title, query)).toBe(true);
	});
});

describe('processPendingEmbeddings', () => {
	it('returns 0 when model is not loaded', async () => {
		const count = await processPendingEmbeddings(db);
		expect(count).toBe(0);
	});
});
