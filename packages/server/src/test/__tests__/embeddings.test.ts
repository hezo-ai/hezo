import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	EMBEDDING_DIMENSIONS,
	embedAndStore,
	generateEmbedding,
	isModelReady,
	processPendingEmbeddings,
	semanticSearch,
} from '../../services/embeddings';
import { safeClose } from '../helpers';
import { createTestApp } from '../helpers/app';

let db: PGlite;
let companyId: string;
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

	// Create a company and project directly
	const companyResult = await db.query<{ id: string }>(
		"INSERT INTO companies (name, slug, issue_prefix) VALUES ('Embed Co', 'embed-co', 'EMB') RETURNING id",
	);
	companyId = companyResult.rows[0].id;

	const projectResult = await db.query<{ id: string }>(
		"INSERT INTO projects (company_id, name, slug) VALUES ($1, 'Embed Project', 'embed-project') RETURNING id",
		[companyId],
	);
	projectId = projectResult.rows[0].id;
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
		// Create a KB doc
		const docResult = await db.query<{ id: string }>(
			"INSERT INTO kb_docs (company_id, title, slug, content) VALUES ($1, 'Embed Test', 'embed-test', 'content') RETURNING id",
			[companyId],
		);
		const docId = docResult.rows[0].id;

		// embedAndStore should be a no-op — embedding stays null
		await embedAndStore(db, 'kb_docs', docId, 'Embed Test\ncontent');

		const check = await db.query<{ embedding: unknown }>(
			'SELECT embedding FROM kb_docs WHERE id = $1',
			[docId],
		);
		expect(check.rows[0].embedding).toBeNull();
	});
});

describe('semanticSearch', () => {
	it('returns empty array when model is not loaded', async () => {
		const results = await semanticSearch(db, companyId, 'test query');
		expect(results).toEqual([]);
	});

	it('returns empty array with scope filter when model is not loaded', async () => {
		const results = await semanticSearch(db, companyId, 'test', { scope: 'kb_docs' });
		expect(results).toEqual([]);
	});
});

describe('semanticSearch with pre-populated embeddings', () => {
	let kbDocId: string;
	let issueId: string;
	let skillId: string;
	let projectDocId: string;

	beforeAll(async () => {
		// Manually insert rows with embeddings to test search queries
		const vec1 = fakeVector(0.3);
		const vec2 = fakeVector(0.6);
		const vec3 = fakeVector(0.9);
		const vec4 = fakeVector(1.2);

		const kbRes = await db.query<{ id: string }>(
			`INSERT INTO kb_docs (company_id, title, slug, content, embedding)
			 VALUES ($1, 'Architecture Guide', 'arch-guide', 'How the system architecture works', $2::vector)
			 RETURNING id`,
			[companyId, vectorStr(vec1)],
		);
		kbDocId = kbRes.rows[0].id;

		// Create a number for the issue
		const numRes = await db.query<{ number: number }>('SELECT next_issue_number($1) AS number', [
			companyId,
		]);
		const num = numRes.rows[0].number;

		const issueRes = await db.query<{ id: string }>(
			`INSERT INTO issues (company_id, project_id, number, identifier, title, description, embedding)
			 VALUES ($1, $2, $3, $4, 'Fix login bug', 'Users cannot log in with SSO', $5::vector)
			 RETURNING id`,
			[companyId, projectId, num, `EMB-${num}`, vectorStr(vec2)],
		);
		issueId = issueRes.rows[0].id;

		const skillRes = await db.query<{ id: string }>(
			`INSERT INTO skills (company_id, name, slug, content, is_active, embedding)
			 VALUES ($1, 'Deploy Skill', 'deploy-skill', 'How to deploy to production', true, $2::vector)
			 RETURNING id`,
			[companyId, vectorStr(vec3)],
		);
		skillId = skillRes.rows[0].id;

		const pdRes = await db.query<{ id: string }>(
			`INSERT INTO project_docs (company_id, project_id, filename, content, embedding)
			 VALUES ($1, $2, 'spec.md', 'Product spec for the project', $3::vector)
			 RETURNING id`,
			[companyId, projectId, vectorStr(vec4)],
		);
		projectDocId = pdRes.rows[0].id;
	});

	// Since the model is not loaded, semanticSearch returns [] — but we can test the
	// SQL queries directly by inserting a query vector and running the search logic ourselves.
	it('kb_docs query returns results with valid embeddings', async () => {
		const queryVec = fakeVector(0.31); // close to vec1
		const r = await db.query<{ id: string; title: string; score: number }>(
			`SELECT id, title, 1 - (embedding <=> $1::vector) AS score
			 FROM kb_docs
			 WHERE company_id = $2 AND embedding IS NOT NULL
			 ORDER BY embedding <=> $1::vector
			 LIMIT 5`,
			[vectorStr(queryVec), companyId],
		);
		expect(r.rows.length).toBeGreaterThanOrEqual(1);
		expect(r.rows[0].title).toBe('Architecture Guide');
		// Score is cosine similarity; with synthetic vectors it may be any value
		expect(typeof r.rows[0].score).toBe('number');
	});

	it('issues query returns results with valid embeddings', async () => {
		const queryVec = fakeVector(0.61);
		const r = await db.query<{ id: string; title: string; score: number }>(
			`SELECT id, title, 1 - (embedding <=> $1::vector) AS score
			 FROM issues
			 WHERE company_id = $2 AND embedding IS NOT NULL
			 ORDER BY embedding <=> $1::vector
			 LIMIT 5`,
			[vectorStr(queryVec), companyId],
		);
		expect(r.rows.length).toBeGreaterThanOrEqual(1);
		expect(r.rows[0].title).toBe('Fix login bug');
	});

	it('skills query returns only active skills', async () => {
		const queryVec = fakeVector(0.91);
		const r = await db.query<{ id: string; name: string; score: number }>(
			`SELECT id, name, 1 - (embedding <=> $1::vector) AS score
			 FROM skills
			 WHERE company_id = $2 AND embedding IS NOT NULL AND is_active = true
			 ORDER BY embedding <=> $1::vector
			 LIMIT 5`,
			[vectorStr(queryVec), companyId],
		);
		expect(r.rows.length).toBeGreaterThanOrEqual(1);
		expect(r.rows[0].name).toBe('Deploy Skill');
	});

	it('project_docs query returns results', async () => {
		const queryVec = fakeVector(1.21);
		const r = await db.query<{ id: string; filename: string; score: number }>(
			`SELECT id, filename, 1 - (embedding <=> $1::vector) AS score
			 FROM project_docs
			 WHERE company_id = $2 AND embedding IS NOT NULL
			 ORDER BY embedding <=> $1::vector
			 LIMIT 5`,
			[vectorStr(queryVec), companyId],
		);
		expect(r.rows.length).toBeGreaterThanOrEqual(1);
		expect(r.rows[0].filename).toBe('spec.md');
	});

	it('results are company-scoped', async () => {
		// Create a second company
		const co2 = await db.query<{ id: string }>(
			"INSERT INTO companies (name, slug, issue_prefix) VALUES ('Other Co', 'other-co', 'OTH') RETURNING id",
		);
		const otherCompanyId = co2.rows[0].id;

		const queryVec = fakeVector(0.31);
		const r = await db.query<{ id: string }>(
			`SELECT id FROM kb_docs
			 WHERE company_id = $2 AND embedding IS NOT NULL
			 ORDER BY embedding <=> $1::vector
			 LIMIT 5`,
			[vectorStr(queryVec), otherCompanyId],
		);
		expect(r.rows.length).toBe(0);
	});
});

describe('processPendingEmbeddings', () => {
	it('returns 0 when model is not loaded', async () => {
		const count = await processPendingEmbeddings(db);
		expect(count).toBe(0);
	});
});
