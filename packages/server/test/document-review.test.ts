import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

// Review comments on project docs: CRUD via
// /api/projects/:projectId/docs/:filename/review-comments, the version-scoped
// auto-wipe on document content changes (REST PUT, MCP write_project_doc,
// revision restore), and the MCP read_project_doc exposure.

let app: Hono<Env>;
let db: Db;
let token: string;

let projectSlug: string;
let otherProjectSlug: string;

const DOC = 'review-me.md';
const DOC_V1 = '# Review Me\n\nAlpha paragraph.\n\nBeta paragraph.';

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'Review Co' });
	const teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, {
		name: 'Review Project',
		description: 'Docs under review.',
	});
	projectSlug = (await projectRes.json()).data.slug;

	const teamBRes = await createTestTeam(db, { name: 'Review Co B' });
	const teamBId = (await teamBRes.json()).data.id;
	const projectBRes = await createTestProject(db, teamBId, {
		name: 'Other Project',
		description: 'Isolation check.',
	});
	otherProjectSlug = (await projectBRes.json()).data.slug;

	await putDoc(DOC, DOC_V1);
});

afterAll(async () => {
	await safeClose(db);
});

async function putDoc(filename: string, content: string): Promise<Record<string, unknown>> {
	const res = await app.request(`/api/projects/${projectSlug}/docs/${filename}`, {
		method: 'PUT',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ content }),
	});
	expect(res.status).toBe(200);
	return (await res.json()).data;
}

async function getDoc(filename: string): Promise<{ updated_at: string }> {
	const res = await app.request(`/api/projects/${projectSlug}/docs/${filename}`, {
		headers: authHeader(token),
	});
	expect(res.status).toBe(200);
	return (await res.json()).data;
}

async function listComments(filename = DOC, project = projectSlug): Promise<Response> {
	return app.request(`/api/projects/${project}/docs/${filename}/review-comments`, {
		headers: authHeader(token),
	});
}

async function createComment(
	body: Record<string, unknown>,
	filename = DOC,
	project = projectSlug,
): Promise<Response> {
	return app.request(`/api/projects/${project}/docs/${filename}/review-comments`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

async function mcp(
	toolName: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: toolName, arguments: args },
			id: 1,
		}),
	});
	const body = (await res.json()) as { result?: { content: Array<{ text: string }> } };
	return JSON.parse(body.result?.content[0].text ?? '{}') as Record<string, unknown>;
}

describe('review comment CRUD', () => {
	let commentId: string;

	it('starts empty', async () => {
		const res = await listComments();
		expect(res.status).toBe(200);
		expect((await res.json()).data).toEqual([]);
	});

	it('creates a comment anchored to a quote', async () => {
		const doc = await getDoc(DOC);
		const res = await createComment({
			quote: 'Alpha paragraph.',
			occurrence: 0,
			comment: 'Expand this with numbers',
			doc_updated_at: doc.updated_at,
		});
		expect(res.status).toBe(201);
		const row = (await res.json()).data;
		commentId = row.id;
		expect(row.quote).toBe('Alpha paragraph.');
		expect(row.occurrence).toBe(0);
		expect(row.comment).toBe('Expand this with numbers');
		expect(row.doc_updated_at).toBeDefined();
	});

	it('validates the payload', async () => {
		expect((await createComment({ comment: 'no quote' })).status).toBe(400);
		expect((await createComment({ quote: 'Alpha paragraph.' })).status).toBe(400);
		expect((await createComment({ quote: 'x', comment: '   ' })).status).toBe(400);
		expect((await createComment({ quote: 'x', comment: 'y', occurrence: -1 })).status).toBe(400);
	});

	it('lists the created comment', async () => {
		const body = await (await listComments()).json();
		expect(body.data.length).toBe(1);
		expect(body.data[0].id).toBe(commentId);
	});

	it('updates the comment text', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/docs/${DOC}/review-comments/${commentId}`,
			{
				method: 'PATCH',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ comment: 'Expand with Q2 numbers' }),
			},
		);
		expect(res.status).toBe(200);
		expect((await res.json()).data.comment).toBe('Expand with Q2 numbers');
	});

	it('404s for an unknown comment id', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/docs/${DOC}/review-comments/00000000-0000-0000-0000-000000000000`,
			{
				method: 'PATCH',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ comment: 'nope' }),
			},
		);
		expect(res.status).toBe(404);
	});

	it('404s when addressed through another project', async () => {
		const res = await listComments(DOC, otherProjectSlug);
		expect(res.status).toBe(404); // doc doesn't exist in that project
	});

	it('deletes one comment', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/docs/${DOC}/review-comments/${commentId}`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		expect((await (await listComments()).json()).data).toEqual([]);
	});

	it('rejects a create against a stale document version', async () => {
		const stale = await getDoc(DOC);
		await putDoc(DOC, `${DOC_V1}\n\nGamma paragraph.`);
		const res = await createComment({
			quote: 'Beta paragraph.',
			comment: 'stale attempt',
			doc_updated_at: stale.updated_at,
		});
		expect(res.status).toBe(409);
		expect((await res.json()).error.code).toBe('CONFLICT');
	});

	it('clears all comments via the collection DELETE', async () => {
		expect((await createComment({ quote: 'Beta paragraph.', comment: 'one' })).status).toBe(201);
		expect((await createComment({ quote: 'Gamma paragraph.', comment: 'two' })).status).toBe(201);
		const res = await app.request(`/api/projects/${projectSlug}/docs/${DOC}/review-comments`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await (await listComments()).json()).data).toEqual([]);
	});
});

describe('auto-wipe on document change', () => {
	it('a content-changing PUT wipes all review comments', async () => {
		await createComment({ quote: 'Alpha paragraph.', comment: 'will be wiped' });
		expect((await (await listComments()).json()).data.length).toBe(1);

		await putDoc(DOC, '# Review Me\n\nRewritten entirely.');
		expect((await (await listComments()).json()).data).toEqual([]);
	});

	it('an identical-content PUT does NOT wipe', async () => {
		const res = await createComment({
			quote: 'Rewritten entirely.',
			comment: 'survives no-op save',
		});
		expect(res.status).toBe(201);

		await putDoc(DOC, '# Review Me\n\nRewritten entirely.');
		expect((await (await listComments()).json()).data.length).toBe(1);
	});

	it('an agent write via MCP write_project_doc wipes too', async () => {
		expect((await (await listComments()).json()).data.length).toBe(1);
		const result = await mcp('write_project_doc', {
			project: projectSlug,
			filename: DOC,
			content: '# Review Me\n\nAgent rewrote this.',
		});
		expect(result.written).toBe(true);
		expect((await (await listComments()).json()).data).toEqual([]);
	});

	it('a revision restore that changes content wipes too', async () => {
		await createComment({ quote: 'Agent rewrote this.', comment: 'wiped by restore' });

		const revisions = await (
			await app.request(`/api/projects/${projectSlug}/docs/${DOC}/revisions`, {
				headers: authHeader(token),
			})
		).json();
		const revisionNumber = revisions.data[0].revision_number;

		const res = await app.request(`/api/projects/${projectSlug}/docs/${DOC}/restore`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ revision_number: revisionNumber }),
		});
		expect(res.status).toBe(200);
		expect((await (await listComments()).json()).data).toEqual([]);
	});
});

describe('MCP read_project_doc exposure', () => {
	it('includes review_comments when the doc has pending feedback', async () => {
		const doc = await getDoc(DOC);
		await createComment({
			quote: 'Review Me',
			occurrence: 0,
			comment: 'Retitle this doc',
			doc_updated_at: doc.updated_at,
		});

		const result = await mcp('read_project_doc', { project: projectSlug, filename: DOC });
		expect(result.filename).toBe(DOC);
		const comments = result.review_comments as Array<Record<string, unknown>>;
		expect(comments.length).toBe(1);
		expect(comments[0].quote).toBe('Review Me');
		expect(comments[0].comment).toBe('Retitle this doc');
		expect(comments[0].occurrence).toBe(0);
		expect(comments[0].id).toBeDefined();
	});

	it('omits review_comments when there are none', async () => {
		await app.request(`/api/projects/${projectSlug}/docs/${DOC}/review-comments`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		const result = await mcp('read_project_doc', { project: projectSlug, filename: DOC });
		expect(result.review_comments).toBeUndefined();
		expect(result.content).toBeDefined();
	});
});
