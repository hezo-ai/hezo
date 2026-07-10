import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

// Review comments on project assets: CRUD via
// /api/projects/:projectId/assets/:assetId/review-comments, the per-type
// anchor rules (text assets quote-anchored like docs, everything else
// whole-asset only), the wipe on write_project_asset overwrite (which swaps
// the asset id — the FK regression case), and the MCP read_project_asset
// exposure.

let app: Hono<Env>;
let db: Db;
let token: string;

let projectSlug: string;
let otherProjectSlug: string;

interface AssetRow {
	id: string;
	sha256: string;
	original_filename: string;
	content_type: string;
	archived_at: string | null;
}

function buildPng(seed = 0): Uint8Array {
	const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const extra = new Uint8Array(32);
	for (let i = 0; i < extra.length; i++) extra[i] = (i + seed) & 0xff;
	const out = new Uint8Array(sig.length + extra.length);
	out.set(sig, 0);
	out.set(extra, sig.length);
	return out;
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

async function uploadAsset(
	filename: string,
	mime: string,
	bytes: Uint8Array,
	project = projectSlug,
): Promise<void> {
	const fd = new FormData();
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	fd.set('file', new File([copy.buffer], filename, { type: mime }));
	const res = await app.request(`/api/projects/${project}/assets`, {
		method: 'POST',
		headers: { ...authHeader(token) },
		body: fd,
	});
	expect(res.status).toBe(201);
}

async function findAsset(filename: string, project = projectSlug): Promise<AssetRow> {
	const res = await app.request(`/api/projects/${project}/assets`, {
		headers: authHeader(token),
	});
	expect(res.status).toBe(200);
	const rows = (await res.json()).data as AssetRow[];
	const row = rows.find((r) => r.original_filename === filename);
	expect(row).toBeDefined();
	return row as AssetRow;
}

function reviewBase(assetId: string, project = projectSlug): string {
	return `/api/projects/${project}/assets/${assetId}/review-comments`;
}

async function listComments(assetId: string, project = projectSlug): Promise<Response> {
	return app.request(reviewBase(assetId, project), { headers: authHeader(token) });
}

async function createComment(
	assetId: string,
	body: Record<string, unknown>,
	project = projectSlug,
): Promise<Response> {
	return app.request(reviewBase(assetId, project), {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'Asset Review Co' });
	const teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, {
		name: 'Asset Review Project',
		description: 'Assets under review.',
	});
	projectSlug = (await projectRes.json()).data.slug;

	const teamBRes = await createTestTeam(db, { name: 'Asset Review Co B' });
	const teamBId = (await teamBRes.json()).data.id;
	const projectBRes = await createTestProject(db, teamBId, {
		name: 'Other Asset Project',
		description: 'Isolation check.',
	});
	otherProjectSlug = (await projectBRes.json()).data.slug;

	// A text-anchored asset (markdown), a whole-asset-only binary (png), and a
	// whole-asset-only text-authorable type (html).
	const written = await mcp('write_project_asset', {
		project: projectSlug,
		filename: 'notes.md',
		content: '# Notes\n\nAlpha paragraph.\n\nBeta paragraph.',
	});
	expect(written.written).toBe(true);
	await uploadAsset('shot.png', 'image/png', buildPng());
	const html = await mcp('write_project_asset', {
		project: projectSlug,
		filename: 'mock.html',
		content: '<!doctype html><h1>Mock</h1>',
	});
	expect(html.written).toBe(true);
});

afterAll(async () => {
	await safeClose(db);
});

describe('review comment CRUD on a text asset', () => {
	let asset: AssetRow;
	let commentId: string;

	beforeAll(async () => {
		asset = await findAsset('notes.md');
	});

	it('starts empty', async () => {
		const res = await listComments(asset.id);
		expect(res.status).toBe(200);
		expect((await res.json()).data).toEqual([]);
	});

	it('creates a comment anchored to a quote', async () => {
		const res = await createComment(asset.id, {
			quote: 'Alpha paragraph.',
			occurrence: 0,
			comment: 'Expand this with numbers',
			asset_sha256: asset.sha256,
		});
		expect(res.status).toBe(201);
		const row = (await res.json()).data;
		commentId = row.id;
		expect(row.asset_id).toBe(asset.id);
		expect(row.document_id).toBeNull();
		expect(row.quote).toBe('Alpha paragraph.');
		expect(row.occurrence).toBe(0);
		expect(row.asset_sha256).toBe(asset.sha256);
	});

	it('validates the payload', async () => {
		expect((await createComment(asset.id, { comment: 'no quote' })).status).toBe(400);
		expect((await createComment(asset.id, { quote: 'Alpha paragraph.' })).status).toBe(400);
		expect((await createComment(asset.id, { quote: 'x', comment: '   ' })).status).toBe(400);
		expect(
			(await createComment(asset.id, { quote: 'x', comment: 'y', occurrence: -1 })).status,
		).toBe(400);
	});

	it('lists the created comment', async () => {
		const body = await (await listComments(asset.id)).json();
		expect(body.data.length).toBe(1);
		expect(body.data[0].id).toBe(commentId);
	});

	it('updates the comment text', async () => {
		const res = await app.request(`${reviewBase(asset.id)}/${commentId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ comment: 'Expand with Q2 numbers' }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.comment).toBe('Expand with Q2 numbers');
	});

	it('404s for an unknown comment id', async () => {
		const res = await app.request(`${reviewBase(asset.id)}/00000000-0000-0000-0000-000000000000`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ comment: 'nope' }),
		});
		expect(res.status).toBe(404);
	});

	it('404s when the asset is addressed through another project', async () => {
		const res = await listComments(asset.id, otherProjectSlug);
		expect(res.status).toBe(404);
	});

	it('rejects a create against a stale asset version', async () => {
		const res = await createComment(asset.id, {
			quote: 'Beta paragraph.',
			comment: 'stale attempt',
			asset_sha256: 'not-the-current-hash',
		});
		expect(res.status).toBe(409);
		expect((await res.json()).error.code).toBe('CONFLICT');
	});

	it('deletes one comment', async () => {
		const res = await app.request(`${reviewBase(asset.id)}/${commentId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await (await listComments(asset.id)).json()).data).toEqual([]);
	});

	it('clears all comments via the collection DELETE', async () => {
		expect(
			(await createComment(asset.id, { quote: 'Alpha paragraph.', comment: 'one' })).status,
		).toBe(201);
		expect(
			(await createComment(asset.id, { quote: 'Beta paragraph.', comment: 'two' })).status,
		).toBe(201);
		const res = await app.request(reviewBase(asset.id), {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await (await listComments(asset.id)).json()).data).toEqual([]);
	});
});

describe('anchor rules per content type', () => {
	it('rejects a quote anchor on an image', async () => {
		const png = await findAsset('shot.png');
		const res = await createComment(png.id, { quote: 'nope', comment: 'not text' });
		expect(res.status).toBe(400);
	});

	it('rejects a quote anchor on html (region anchoring is future work)', async () => {
		const html = await findAsset('mock.html');
		const res = await createComment(html.id, { quote: 'Mock', comment: 'not anchored' });
		expect(res.status).toBe(400);
	});

	it('accepts whole-asset comments on an image and on html', async () => {
		const png = await findAsset('shot.png');
		const pngRes = await createComment(png.id, {
			comment: 'The logo is off-center',
			asset_sha256: png.sha256,
		});
		expect(pngRes.status).toBe(201);
		const pngRow = (await pngRes.json()).data;
		expect(pngRow.quote).toBeNull();

		const html = await findAsset('mock.html');
		const htmlRes = await createComment(html.id, { comment: 'Header contrast is too low' });
		expect(htmlRes.status).toBe(201);
	});

	it('rejects a whole-asset comment on a text asset', async () => {
		const md = await findAsset('notes.md');
		const res = await createComment(md.id, { comment: 'anchorless on markdown' });
		expect(res.status).toBe(400);
	});
});

describe('archived assets freeze their review', () => {
	let png: AssetRow;

	beforeAll(async () => {
		png = await findAsset('shot.png');
		const res = await app.request(`/api/projects/${projectSlug}/assets/${png.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ archived: true }),
		});
		expect(res.status).toBe(200);
	});

	afterAll(async () => {
		const res = await app.request(`/api/projects/${projectSlug}/assets/${png.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ archived: false }),
		});
		expect(res.status).toBe(200);
	});

	it('still lists comments', async () => {
		const res = await listComments(png.id);
		expect(res.status).toBe(200);
		expect((await res.json()).data.length).toBe(1);
	});

	it('rejects create, update, delete, and clear', async () => {
		expect((await createComment(png.id, { comment: 'frozen' })).status).toBe(403);
		const existing = (await (await listComments(png.id)).json()).data[0];
		const patch = await app.request(`${reviewBase(png.id)}/${existing.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ comment: 'still frozen' }),
		});
		expect(patch.status).toBe(403);
		const del = await app.request(`${reviewBase(png.id)}/${existing.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(del.status).toBe(403);
		const clear = await app.request(reviewBase(png.id), {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(clear.status).toBe(403);
	});
});

describe('wipe on overwrite and cascade on delete', () => {
	it('write_project_asset overwrite succeeds with pending comments and wipes them', async () => {
		const before = await findAsset('notes.md');
		expect(
			(
				await createComment(before.id, {
					quote: 'Beta paragraph.',
					comment: 'will be consumed by the rewrite',
				})
			).status,
		).toBe(201);

		// The overwrite swaps the asset id; without the in-transaction wipe this
		// UPDATE would trip the review_comments FK — the regression this guards.
		const result = await mcp('write_project_asset', {
			project: projectSlug,
			filename: 'notes.md',
			content: '# Notes\n\nRewritten entirely.',
		});
		expect(result.written).toBe(true);

		const after = await findAsset('notes.md');
		expect(after.id).not.toBe(before.id);
		expect((await (await listComments(after.id)).json()).data).toEqual([]);
		const orphans = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM review_comments WHERE asset_id = $1`,
			[before.id],
		);
		expect(orphans.rows[0].c).toBe(0);
	});

	it('REST hard delete cascades the comments', async () => {
		await uploadAsset('temp.png', 'image/png', buildPng(7));
		const temp = await findAsset('temp.png');
		expect((await createComment(temp.id, { comment: 'short-lived' })).status).toBe(201);

		const res = await app.request(`/api/projects/${projectSlug}/assets/${temp.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const orphans = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM review_comments WHERE asset_id = $1`,
			[temp.id],
		);
		expect(orphans.rows[0].c).toBe(0);
	});
});

describe('MCP read_project_asset exposure', () => {
	it('includes review_comments inline for a text asset', async () => {
		const md = await findAsset('notes.md');
		expect(
			(
				await createComment(md.id, {
					quote: 'Rewritten entirely.',
					occurrence: 0,
					comment: 'Needs more detail',
					asset_sha256: md.sha256,
				})
			).status,
		).toBe(201);

		const result = await mcp('read_project_asset', { project: projectSlug, filename: 'notes.md' });
		expect(result.content).toBeDefined();
		const comments = result.review_comments as Array<Record<string, unknown>>;
		expect(comments.length).toBe(1);
		expect(comments[0].quote).toBe('Rewritten entirely.');
		expect(comments[0].occurrence).toBe(0);
		expect(comments[0].comment).toBe('Needs more detail');
	});

	it('includes whole-asset review_comments on the binary branch, without quote', async () => {
		const result = await mcp('read_project_asset', { project: projectSlug, filename: 'shot.png' });
		expect(result.binary).toBe(true);
		expect(result.url).toBeDefined();
		const comments = result.review_comments as Array<Record<string, unknown>>;
		expect(comments.length).toBe(1);
		expect(comments[0].comment).toBe('The logo is off-center');
		expect('quote' in comments[0]).toBe(false);
		expect('occurrence' in comments[0]).toBe(false);
	});

	it('omits review_comments when there are none', async () => {
		const md = await findAsset('notes.md');
		await app.request(reviewBase(md.id), { method: 'DELETE', headers: authHeader(token) });
		const result = await mcp('read_project_asset', { project: projectSlug, filename: 'notes.md' });
		expect(result.review_comments).toBeUndefined();
	});
});
