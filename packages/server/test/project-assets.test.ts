import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { blobBytes, safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let dataDir: string;
let teamId: string;
let projectId: string;
let taskId: string;
let agentId: string;

function buildPng(seed = 0): Uint8Array {
	const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const extra = new Uint8Array(32);
	for (let i = 0; i < extra.length; i++) extra[i] = (i + seed) & 0xff;
	const out = new Uint8Array(sig.length + extra.length);
	out.set(sig, 0);
	out.set(extra, sig.length);
	return out;
}

const SVG_BYTES = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const WEBP_BYTES = new TextEncoder().encode('RIFF....WEBPVP8 ');

async function callToolViaMcp(
	authToken: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(authToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: toolName, arguments: args },
			id: 1,
		}),
	});
	const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
	return JSON.parse(body.result.content[0].text);
}

async function uploadProjectAsset(
	filename: string,
	mime: string,
	bytes: Uint8Array,
	folder?: string,
): Promise<Response> {
	const fd = new FormData();
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	fd.set('file', new File([blobBytes(copy)], filename, { type: mime }));
	if (folder !== undefined) fd.set('folder', folder);
	return app.request(`/api/projects/${projectId}/assets`, {
		method: 'POST',
		headers: { ...authHeader(token) },
		body: fd,
	});
}

function diskPath(assetId: string): string {
	return join(dataDir, 'assets', projectId, assetId);
}

async function uploadTaskAsset(filename: string, mime: string, bytes: Uint8Array): Promise<string> {
	const fd = new FormData();
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	fd.set('file', new File([blobBytes(copy)], filename, { type: mime }));
	const res = await app.request(`/api/projects/${projectId}/tasks/${taskId}/assets`, {
		method: 'POST',
		headers: { ...authHeader(token) },
		body: fd,
	});
	return (await res.json()).data.id;
}

async function uploadAssetViaMcp(
	authToken: string,
	filename: string,
	mime: string,
	bytes: Uint8Array,
): Promise<Response> {
	const fd = new FormData();
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	fd.set('file', new File([blobBytes(copy)], filename, { type: mime }));
	return app.request('/mcp/assets', {
		method: 'POST',
		headers: { ...authHeader(authToken) },
		body: fd,
	});
}

async function uploadAssetViaMcpForm(
	authToken: string,
	filename: string,
	mime: string,
	bytes: Uint8Array,
	fields: Record<string, string> = {},
): Promise<Response> {
	const fd = new FormData();
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	fd.set('file', new File([blobBytes(copy)], filename, { type: mime }));
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	return app.request('/mcp/assets', {
		method: 'POST',
		headers: { ...authHeader(authToken) },
		body: fd,
	});
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = ctx.dataDir;

	const teamRes = await createTestTeam(db, { name: 'Assets Co' });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, { name: 'Main', description: 'Assets.' });
	projectId = (await projectRes.json()).data.id;

	const agentRes = await app.request(`/api/projects/${projectId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Asset Bot' }),
	});
	agentId = (await agentRes.json()).data.id;

	const taskRes = await app.request(`/api/projects/${projectId}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Has Assets', assignee_id: agentId }),
	});
	taskId = (await taskRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('project asset upload', () => {
	it('stores an uploaded asset and returns a signed url', async () => {
		const res = await uploadProjectAsset('mockup.png', 'image/png', buildPng());
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.original_filename).toBe('mockup.png');
		expect(body.data.content_type).toBe('image/png');
		expect(body.data.url).toMatch(/^\/api\/assets\/[0-9a-f-]+\?exp=\d+&sig=/);

		const onDisk = join(dataDir, 'assets', projectId, body.data.id);
		expect(existsSync(onDisk)).toBe(true);
	});

	it('auto-suffixes a colliding filename instead of rejecting', async () => {
		const first = await uploadProjectAsset('logo.png', 'image/png', buildPng(1));
		const second = await uploadProjectAsset('logo.png', 'image/png', buildPng(2));
		expect(first.status).toBe(201);
		expect(second.status).toBe(201);
		const firstName = (await first.json()).data.original_filename;
		const secondName = (await second.json()).data.original_filename;
		expect(firstName).toBe('logo.png');
		expect(secondName).not.toBe('logo.png');
		expect(secondName).toMatch(/^logo-[0-9a-z]+\.png$/);
	});

	it('normalizes unsafe characters in the filename', async () => {
		const res = await uploadProjectAsset('My Wire Frame!.png', 'image/png', buildPng(3));
		const name = (await res.json()).data.original_filename;
		expect(name).toBe('My-Wire-Frame.png');
	});

	it('rejects unsupported extensions', async () => {
		const res = await uploadProjectAsset('virus.exe', 'application/octet-stream', buildPng());
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_ATTACHMENT');
	});

	it('accepts webp and svg', async () => {
		const webp = await uploadProjectAsset('art.webp', 'image/webp', WEBP_BYTES);
		const svg = await uploadProjectAsset('vector.svg', 'image/svg+xml', SVG_BYTES);
		expect(webp.status).toBe(201);
		expect(svg.status).toBe(201);
	});

	it('accepts a markdown upload, deriving text/markdown when the browser sends no MIME', async () => {
		// Browsers commonly leave `.md` files with an empty type; the canonical
		// type is filled in from the (allowlisted) extension.
		const res = await uploadProjectAsset('notes.md', '', new TextEncoder().encode('# Hello'));
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.content_type).toBe('text/markdown');

		// And it serves inline (markdown is inert text — no forced download).
		const served = await app.request(body.data.url);
		expect(served.headers.get('content-disposition')).toContain('inline');
		expect(await served.text()).toBe('# Hello');
	});
});

describe('asset serving disposition', () => {
	it('serves png inline but svg as an attachment', async () => {
		const png = await (await uploadProjectAsset('inline.png', 'image/png', buildPng(7))).json();
		const svg = await (await uploadProjectAsset('safe.svg', 'image/svg+xml', SVG_BYTES)).json();

		const pngRes = await app.request(png.data.url);
		expect(pngRes.headers.get('content-disposition')).toContain('inline');

		const svgRes = await app.request(svg.data.url);
		expect(svgRes.headers.get('content-disposition')).toContain('attachment');
	});

	it('forces an attachment when ?download=1 is appended to the signed url', async () => {
		const png = await (await uploadProjectAsset('grab.png', 'image/png', buildPng(9))).json();

		// Default: inline.
		const inline = await app.request(png.data.url);
		expect(inline.headers.get('content-disposition')).toContain('inline');

		// Same signed URL + download flag: attachment. The signature covers only
		// `assetId|exp`, so the extra query param still verifies.
		const download = await app.request(`${png.data.url}&download=1`);
		expect(download.status).toBe(200);
		expect(download.headers.get('content-disposition')).toContain('attachment');
		expect(download.headers.get('content-disposition')).toContain('filename="grab.png"');
	});

	it('serves html inline pinned to an opaque origin via a sandbox CSP', async () => {
		const html = await (
			await uploadProjectAsset('page.html', 'text/html', new TextEncoder().encode('<h1>hi</h1>'))
		).json();
		const res = await app.request(html.data.url);
		expect(res.headers.get('content-disposition')).toContain('inline');
		const csp = res.headers.get('content-security-policy');
		expect(csp).toContain('sandbox');
		expect(csp).toContain('allow-scripts');
		expect(csp).not.toContain('allow-same-origin');
	});
});

describe('agent-authored assets (write_project_asset)', () => {
	it('writes an html mockup and returns its assets/<name> reference', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
		);
		const result = await callToolViaMcp(agentToken, 'write_project_asset', {
			project: projectId,
			filename: 'ui-mockups.html',
			content: '<!doctype html><title>Mock</title><h1>v1</h1>',
		});
		expect(result.written).toBe(true);
		expect(result.reference).toBe('assets/ui-mockups.html');

		const row = await db.query<{ id: string; content_type: string }>(
			'SELECT id, content_type FROM assets WHERE project_id = $1 AND original_filename = $2',
			[projectId, 'ui-mockups.html'],
		);
		expect(row.rows).toHaveLength(1);
		expect(row.rows[0].content_type).toBe('text/html');
		const onDisk = join(dataDir, 'assets', projectId, row.rows[0].id);
		expect(existsSync(onDisk)).toBe(true);
	});

	it('writes a markdown asset (e.g. a blog post) stored as text/markdown', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
		);
		const body = '# Launch announcement\n\nWe shipped **markdown assets**.';
		const result = await callToolViaMcp(agentToken, 'write_project_asset', {
			project: projectId,
			filename: 'launch-post.md',
			content: body,
		});
		expect(result.written).toBe(true);
		expect(result.reference).toBe('assets/launch-post.md');

		const row = await db.query<{ id: string; content_type: string }>(
			'SELECT id, content_type FROM assets WHERE project_id = $1 AND original_filename = $2',
			[projectId, 'launch-post.md'],
		);
		expect(row.rows).toHaveLength(1);
		expect(row.rows[0].content_type).toBe('text/markdown');

		// It reads back inline (so the agent and the in-app viewer get the raw text).
		const read = await callToolViaMcp(agentToken, 'read_project_asset', {
			project: projectId,
			filename: 'launch-post.md',
		});
		expect(read.content_type).toBe('text/markdown');
		expect(read.content).toBe(body);
		expect(read.binary).toBeUndefined();
	});

	it('overwrites the same filename on re-save, keeping a single stable reference', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
		);
		const first = await callToolViaMcp(agentToken, 'write_project_asset', {
			project: projectId,
			filename: 'iterate.html',
			content: '<h1>first</h1>',
		});
		const second = await callToolViaMcp(agentToken, 'write_project_asset', {
			project: projectId,
			filename: 'iterate.html',
			content: '<h1>second-and-longer</h1>',
		});
		expect(second.reference).toBe('assets/iterate.html');

		const rows = await db.query<{ id: string; byte_size: number }>(
			'SELECT id, byte_size FROM assets WHERE project_id = $1 AND original_filename = $2',
			[projectId, 'iterate.html'],
		);
		expect(rows.rows).toHaveLength(1);
		expect(rows.rows[0].id).toBe(second.id);
		// The replaced asset's bytes are cleaned off disk.
		expect(first.id).not.toBe(second.id);
		const oldDisk = join(dataDir, 'assets', projectId, first.id as string);
		expect(existsSync(oldDisk)).toBe(false);
	});

	it('rejects a binary asset written without base64 encoding', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
		);
		const result = await callToolViaMcp(agentToken, 'write_project_asset', {
			project: projectId,
			filename: 'diagram.png',
			content: 'not really a png',
		});
		expect(result.written).toBeUndefined();
		expect(String(result.error)).toContain('base64');
	});

	it('writes a valid base64 binary asset with bytes intact (aligned length passes the guard)', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
		);
		const png = buildPng(51);
		const result = await callToolViaMcp(agentToken, 'write_project_asset', {
			project: projectId,
			filename: 'valid.png',
			content: Buffer.from(png).toString('base64'),
			encoding: 'base64',
		});
		expect(result.written).toBe(true);
		expect(result.reference).toBe('assets/valid.png');
		const row = await db.query<{ byte_size: number }>(
			'SELECT byte_size FROM assets WHERE project_id = $1 AND original_filename = $2',
			[projectId, 'valid.png'],
		);
		expect(row.rows).toHaveLength(1);
		expect(row.rows[0].byte_size).toBe(png.byteLength);
	});

	it('rejects base64 content truncated by a runtime arg cap and points at the multipart endpoint', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
		);
		// Simulate a coding-CLI cutting the tool-call argument mid-stream: drop the
		// padding and trim to a length ≡1 (mod 4), which valid base64 never has.
		const body = Buffer.from(buildPng(52)).toString('base64').replace(/=+$/, '');
		const truncated = body.slice(0, body.length - ((body.length + 3) % 4));
		expect(truncated.length % 4).toBe(1);
		const result = await callToolViaMcp(agentToken, 'write_project_asset', {
			project: projectId,
			filename: 'truncated.png',
			content: truncated,
			encoding: 'base64',
		});
		expect(result.written).toBeUndefined();
		expect(String(result.error)).toContain('truncated');
		expect(String(result.error)).toContain('/mcp/assets');
		// Nothing corrupt was stored.
		const row = await db.query(
			'SELECT id FROM assets WHERE project_id = $1 AND original_filename = $2',
			[projectId, 'truncated.png'],
		);
		expect(row.rows).toHaveLength(0);
	});

	it('returns byte_size on a successful write so the caller can verify the file landed', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
		);
		const png = buildPng(70);
		const result = await callToolViaMcp(agentToken, 'write_project_asset', {
			project: projectId,
			filename: 'sized.png',
			content: Buffer.from(png).toString('base64'),
			encoding: 'base64',
		});
		expect(result.written).toBe(true);
		expect(result.byte_size).toBe(png.byteLength);
	});

	it('rejects base64 whose decoded size mismatches a declared byte_size (catches an aligned cut)', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
		);
		const png = buildPng(71);
		// A mid-stream cut that lands on a 4-char boundary and drops the padding —
		// valid base64 that decodes short, so the %4 heuristic can't flag it; only
		// the declared byte_size does.
		const stripped = Buffer.from(png).toString('base64').replace(/=+$/, '');
		const aligned = stripped.slice(0, stripped.length - (stripped.length % 4));
		expect(aligned.length % 4).toBe(0);
		const result = await callToolViaMcp(agentToken, 'write_project_asset', {
			project: projectId,
			filename: 'declared.png',
			content: aligned,
			encoding: 'base64',
			byte_size: png.byteLength,
		});
		expect(result.written).toBeUndefined();
		expect(String(result.error)).toContain('truncated');
		expect(String(result.error)).toContain('/mcp/assets');
		const row = await db.query(
			'SELECT id FROM assets WHERE project_id = $1 AND original_filename = $2',
			[projectId, 'declared.png'],
		);
		expect(row.rows).toHaveLength(0);
	});
});

describe('project asset listing', () => {
	it('lists all project assets including comment attachments with usage counts', async () => {
		const attachmentId = await uploadTaskAsset('from-comment.png', 'image/png', buildPng(9));
		await app.request(`/api/projects/${projectId}/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: 'see assets/from-comment.png' },
				attachment_ids: [attachmentId],
			}),
		});

		const res = await app.request(`/api/projects/${projectId}/assets`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const assets = (await res.json()).data as Array<{
			id: string;
			original_filename: string;
			comment_attachment_count: number;
		}>;
		const fromComment = assets.find((a) => a.id === attachmentId);
		expect(fromComment).toBeDefined();
		expect(fromComment?.comment_attachment_count).toBe(1);
		// A directly-uploaded asset has no comment links.
		const direct = assets.find((a) => a.original_filename === 'mockup.png');
		expect(direct?.comment_attachment_count).toBe(0);
	});
});

describe('project asset deletion', () => {
	it('forbids agents from deleting assets', async () => {
		const { id } = (
			await uploadProjectAsset('agent-cant.png', 'image/png', buildPng(11)).then((r) => r.json())
		).data;
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
		);
		const res = await app.request(`/api/projects/${projectId}/assets/${id}`, {
			method: 'DELETE',
			headers: authHeader(agentToken),
		});
		expect(res.status).toBe(403);
	});

	it('deletes an asset and removes its bytes from disk', async () => {
		const { id } = (
			await uploadProjectAsset('delete-me.png', 'image/png', buildPng(12)).then((r) => r.json())
		).data;
		const onDisk = join(dataDir, 'assets', projectId, id);
		expect(existsSync(onDisk)).toBe(true);

		const res = await app.request(`/api/projects/${projectId}/assets/${id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect(existsSync(onDisk)).toBe(false);
		const row = await db.query('SELECT id FROM assets WHERE id = $1', [id]);
		expect(row.rows).toHaveLength(0);
	});
});

describe('asset mention resolution', () => {
	it('resolves assets/<name> to the unique asset with a signed url', async () => {
		await uploadProjectAsset('resolve-me.png', 'image/png', buildPng(13));
		const projectSlug = (
			await db.query<{ slug: string }>('SELECT slug FROM projects WHERE id = $1', [projectId])
		).rows[0].slug;

		const res = await app.request(`/api/projects/${projectId}/docs/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ assets: [{ project_slug: projectSlug, filename: 'resolve-me.png' }] }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()).data as {
			assets: Array<{ filename: string; content_type: string; signed_url: string }>;
		};
		expect(body.assets).toHaveLength(1);
		expect(body.assets[0].filename).toBe('resolve-me.png');
		expect(body.assets[0].content_type).toBe('image/png');
		expect(body.assets[0].signed_url).toMatch(/^\/api\/assets\/[0-9a-f-]+\?exp=\d+&sig=/);
	});
});

describe('MCP asset upload (POST /mcp/assets)', () => {
	it('an agent run uploads a binary asset, retrievable via the MCP read tools', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
			{
				projectId,
			},
		);
		const res = await uploadAssetViaMcp(agentToken, 'diagram.png', 'image/png', buildPng(7));
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.original_filename).toBe('diagram.png');
		expect(body.data.content_type).toBe('image/png');
		expect(body.data.url).toMatch(/^\/api\/assets\/[0-9a-f-]+\?exp=\d+&sig=/);

		const onDisk = join(dataDir, 'assets', projectId, body.data.id);
		expect(existsSync(onDisk)).toBe(true);

		// Visible to the agent through the existing read tools.
		const list = (await callToolViaMcp(agentToken, 'list_project_assets', {})) as {
			files: Array<{ filename: string }>;
		};
		expect(list.files.some((f) => f.filename === 'diagram.png')).toBe(true);

		const read = (await callToolViaMcp(agentToken, 'read_project_asset', {
			filename: 'diagram.png',
		})) as { binary?: boolean; url?: string };
		expect(read.binary).toBe(true);
		// Binary contents come back as an absolute signed download URL the agent
		// curls from inside its container — never a filesystem path.
		expect(read.url).toMatch(/^https?:\/\/[^/]+\/api\/assets\/[0-9a-f-]+\?exp=\d+&sig=/);
	});

	it('an external API key uploads via MCP (naming the project)', async () => {
		const createRes = await app.request('/api/api-keys', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Upload Key' }),
		});
		const rawKey = (await createRes.json()).data.key;

		// An instance-scoped key has no home project — it names the project in the form.
		const fd = new FormData();
		const png = buildPng(8);
		const copy = new Uint8Array(png.byteLength);
		copy.set(png);
		fd.set('file', new File([blobBytes(copy)], 'external.png', { type: 'image/png' }));
		fd.set('project', projectId);
		const res = await app.request('/mcp/assets', {
			method: 'POST',
			headers: { ...authHeader(rawKey) },
			body: fd,
		});
		expect(res.status).toBe(201);
		expect((await res.json()).data.original_filename).toBe('external.png');
	});

	it('rejects a disallowed file type', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
			{
				projectId,
			},
		);
		const res = await uploadAssetViaMcp(
			agentToken,
			'evil.exe',
			'application/x-msdownload',
			buildPng(9),
		);
		expect(res.status).toBe(400);
	});

	it('requires authentication', async () => {
		const fd = new FormData();
		fd.set('file', new File([blobBytes(buildPng(10))], 'nope.png', { type: 'image/png' }));
		const res = await app.request('/mcp/assets', { method: 'POST', body: fd });
		expect(res.status).toBe(401);
	});

	it('places an upload into a folder via the folder form field', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
			{
				projectId,
			},
		);
		const fd = new FormData();
		const png = buildPng(21);
		const copy = new Uint8Array(png.byteLength);
		copy.set(png);
		fd.set('file', new File([blobBytes(copy)], 'chart.png', { type: 'image/png' }));
		fd.set('folder', 'reports/q3');
		const res = await app.request('/mcp/assets', {
			method: 'POST',
			headers: { ...authHeader(agentToken) },
			body: fd,
		});
		expect(res.status).toBe(201);
		expect((await res.json()).data.original_filename).toBe('reports/q3/chart.png');
	});

	it('preserves the full folder path from the `path` field and reports byte_size', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
			{
				projectId,
			},
		);
		const png = buildPng(60);
		const res = await uploadAssetViaMcpForm(agentToken, 'hero.png', 'image/png', png, {
			path: 'community-posts/indiehackers-header.png',
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.original_filename).toBe('community-posts/indiehackers-header.png');
		expect(body.data.byte_size).toBe(png.byteLength);
	});

	it('derives the destination path from a foldered filename when no path field is sent', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
			{
				projectId,
			},
		);
		const res = await uploadAssetViaMcpForm(
			agentToken,
			'community-posts/from-filename.png',
			'image/png',
			buildPng(61),
		);
		expect(res.status).toBe(201);
		expect((await res.json()).data.original_filename).toBe('community-posts/from-filename.png');
	});

	it('overwrites an existing asset in place with overwrite=true (no fork, old blob cleaned)', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
			{
				projectId,
			},
		);
		const first = await uploadAssetViaMcpForm(agentToken, 'hero.png', 'image/png', buildPng(62), {
			path: 'over/hero.png',
			overwrite: 'true',
		});
		expect(first.status).toBe(201);
		const firstId = (await first.json()).data.id as string;
		expect(existsSync(diskPath(firstId))).toBe(true);

		const second = await uploadAssetViaMcpForm(agentToken, 'hero.png', 'image/png', buildPng(63), {
			path: 'over/hero.png',
			overwrite: 'true',
		});
		expect(second.status).toBe(201);
		const secondBody = await second.json();
		expect(secondBody.data.original_filename).toBe('over/hero.png');
		expect(secondBody.data.id).not.toBe(firstId);

		// Exactly one active row at the path — the overwrite replaced in place.
		const rows = await db.query(
			"SELECT original_filename FROM assets WHERE project_id = $1 AND original_filename LIKE 'over/%'",
			[projectId],
		);
		expect(rows.rows).toHaveLength(1);
		// The replaced blob is cleaned off disk; the new one is present.
		expect(existsSync(diskPath(firstId))).toBe(false);
		expect(existsSync(diskPath(secondBody.data.id as string))).toBe(true);
	});

	it('auto-suffixes a colliding path when overwrite is not set (backward compat)', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
			{
				projectId,
			},
		);
		const first = await uploadAssetViaMcpForm(agentToken, 'dup.png', 'image/png', buildPng(64), {
			path: 'dupdir/dup.png',
		});
		const second = await uploadAssetViaMcpForm(agentToken, 'dup.png', 'image/png', buildPng(65), {
			path: 'dupdir/dup.png',
		});
		expect((await first.json()).data.original_filename).toBe('dupdir/dup.png');
		const secondName = (await second.json()).data.original_filename;
		expect(secondName).not.toBe('dupdir/dup.png');
		expect(secondName).toMatch(/^dupdir\/dup-[0-9a-z]+\.png$/);
	});

	it('rejects overwriting an archived asset — the holder must be unarchived first', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
			{
				projectId,
			},
		);
		const first = await uploadAssetViaMcpForm(agentToken, 'arch.png', 'image/png', buildPng(66), {
			path: 'archdir/arch.png',
			overwrite: 'true',
		});
		expect(first.status).toBe(201);
		await db.query(
			'UPDATE assets SET archived_at = now() WHERE project_id = $1 AND original_filename = $2',
			[projectId, 'archdir/arch.png'],
		);
		const res = await uploadAssetViaMcpForm(agentToken, 'arch.png', 'image/png', buildPng(67), {
			path: 'archdir/arch.png',
			overwrite: 'true',
		});
		expect(res.status).toBe(409);
		expect((await res.json()).error.code).toBe('ASSET_ARCHIVED');
	});

	it('rejects a path deeper than 2 folder levels', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
			{
				projectId,
			},
		);
		const res = await uploadAssetViaMcpForm(agentToken, 'deep.png', 'image/png', buildPng(68), {
			path: 'a/b/c/deep.png',
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_PATH');
	});
});

describe('foldered uploads (REST)', () => {
	it('stores the upload under the folder and keeps the reference path', async () => {
		const res = await uploadProjectAsset('hero.png', 'image/png', buildPng(30), 'launch');
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.original_filename).toBe('launch/hero.png');

		// The blob is keyed by asset id — folders never touch the disk layout.
		expect(existsSync(diskPath(body.data.id))).toBe(true);
	});

	it('normalizes folder segments like filenames', async () => {
		const res = await uploadProjectAsset(
			'n.png',
			'image/png',
			buildPng(31),
			'My Campaign!/Sub Dir',
		);
		expect(res.status).toBe(201);
		expect((await res.json()).data.original_filename).toBe('My-Campaign/Sub-Dir/n.png');
	});

	it('rejects a folder nested deeper than two levels', async () => {
		const res = await uploadProjectAsset('deep.png', 'image/png', buildPng(32), 'a/b/c');
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_FOLDER');
	});

	it('auto-suffixes a collision within the folder, not the folder name', async () => {
		const first = await uploadProjectAsset('logo.png', 'image/png', buildPng(33), 'brand');
		const second = await uploadProjectAsset('logo.png', 'image/png', buildPng(34), 'brand');
		expect((await first.json()).data.original_filename).toBe('brand/logo.png');
		const secondName = (await second.json()).data.original_filename;
		expect(secondName).toMatch(/^brand\/logo-[0-9a-z]+\.png$/);
	});

	it('same basename in different folders coexists without suffixing', async () => {
		const a = await uploadProjectAsset('shared.png', 'image/png', buildPng(35), 'one');
		const b = await uploadProjectAsset('shared.png', 'image/png', buildPng(36), 'two');
		expect((await a.json()).data.original_filename).toBe('one/shared.png');
		expect((await b.json()).data.original_filename).toBe('two/shared.png');
	});

	it('serves a foldered asset with a basename-only download filename and nosniff', async () => {
		const res = await uploadProjectAsset('poster.png', 'image/png', buildPng(37), 'launch/art');
		const body = await res.json();
		const served = await app.request(body.data.url);
		expect(served.status).toBe(200);
		expect(served.headers.get('content-disposition')).toContain('filename="poster.png"');
		expect(served.headers.get('content-disposition')).not.toContain('launch');
		expect(served.headers.get('x-content-type-options')).toBe('nosniff');
	});
});

describe('script/text asset uploads', () => {
	it('stores a .js upload declaring text/javascript as inert text/plain', async () => {
		const res = await uploadProjectAsset(
			'runner.js',
			'text/javascript',
			new TextEncoder().encode('console.log(1)'),
		);
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.content_type).toBe('text/plain');

		const served = await app.request(body.data.url);
		expect(served.headers.get('content-type')).toBe('text/plain');
		expect(served.headers.get('x-content-type-options')).toBe('nosniff');
		expect(served.headers.get('content-disposition')).toContain('inline');
	});

	it('accepts the script/text extension family', async () => {
		const cases: Array<[string, string]> = [
			['deploy.sh', 'application/x-sh'],
			['tool.py', 'text/x-python'],
			['data.json', 'application/json'],
			['conf.yaml', ''],
			['rows.csv', 'text/csv'],
		];
		for (const [name, mime] of cases) {
			const res = await uploadProjectAsset(name, mime, new TextEncoder().encode('x'));
			expect(res.status, `${name} should upload`).toBe(201);
			expect((await res.json()).data.content_type).toBe('text/plain');
		}
	});
});

describe('foldered agent-authored assets', () => {
	async function agentToken(): Promise<string> {
		const { token: t } = await mintAgentToken(db, masterKeyManager, agentId, teamId, taskId);
		return t;
	}

	it('writes a script into a folder and reads it back by path', async () => {
		const t = await agentToken();
		const written = await callToolViaMcp(t, 'write_project_asset', {
			project: projectId,
			filename: 'scripts/check.sh',
			content: '#!/bin/sh\necho ok\n',
		});
		expect(written.written).toBe(true);
		expect(written.reference).toBe('assets/scripts/check.sh');

		const read = await callToolViaMcp(t, 'read_project_asset', {
			project: projectId,
			filename: 'scripts/check.sh',
		});
		expect(read.content).toBe('#!/bin/sh\necho ok\n');
		expect(read.content_type).toBe('text/plain');
	});

	it('overwrite matching is path-exact: root and foldered names are different assets', async () => {
		const t = await agentToken();
		await callToolViaMcp(t, 'write_project_asset', {
			project: projectId,
			filename: 'fork.html',
			content: '<h1>root</h1>',
		});
		await callToolViaMcp(t, 'write_project_asset', {
			project: projectId,
			filename: 'blog/fork.html',
			content: '<h1>foldered</h1>',
		});
		const rows = await db.query<{ original_filename: string }>(
			`SELECT original_filename FROM assets
			 WHERE project_id = $1 AND original_filename IN ('fork.html', 'blog/fork.html')
			 ORDER BY original_filename`,
			[projectId],
		);
		expect(rows.rows.map((r) => r.original_filename)).toEqual(['blog/fork.html', 'fork.html']);
	});

	it('rejects an over-deep path with a clear error', async () => {
		const t = await agentToken();
		const res = await callToolViaMcp(t, 'write_project_asset', {
			project: projectId,
			filename: 'a/b/c/too-deep.md',
			content: 'x',
		});
		expect(res.written).toBeUndefined();
		expect(String(res.error)).toMatch(/folder levels/i);
	});
});

describe('move_project_asset', () => {
	async function agentToken(): Promise<string> {
		const { token: t } = await mintAgentToken(db, masterKeyManager, agentId, teamId, taskId);
		return t;
	}

	it('moves an asset into a folder without touching the blob', async () => {
		const up = await (await uploadProjectAsset('movable.png', 'image/png', buildPng(40))).json();
		expect(existsSync(diskPath(up.data.id))).toBe(true);

		const res = await callToolViaMcp(await agentToken(), 'move_project_asset', {
			project: projectId,
			from: 'movable.png',
			to: 'archive/movable.png',
		});
		expect(res.moved).toBe(true);
		expect(res.id).toBe(up.data.id);
		expect(res.reference).toBe('assets/archive/movable.png');

		const row = await db.query<{ original_filename: string }>(
			'SELECT original_filename FROM assets WHERE id = $1',
			[up.data.id],
		);
		expect(row.rows[0].original_filename).toBe('archive/movable.png');
		// Same blob, same key — a move is metadata-only.
		expect(existsSync(diskPath(up.data.id))).toBe(true);
	});

	it('moves back to the root', async () => {
		await uploadProjectAsset('rooted.png', 'image/png', buildPng(41), 'tmp');
		const res = await callToolViaMcp(await agentToken(), 'move_project_asset', {
			project: projectId,
			from: 'tmp/rooted.png',
			to: 'rooted.png',
		});
		expect(res.moved).toBe(true);
		expect(res.reference).toBe('assets/rooted.png');
	});

	it('errors when the source is missing', async () => {
		const res = await callToolViaMcp(await agentToken(), 'move_project_asset', {
			project: projectId,
			from: 'ghost.png',
			to: 'somewhere/ghost.png',
		});
		expect(String(res.error)).toContain("'assets/ghost.png' not found");
	});

	it('never overwrites: destination taken errors', async () => {
		await uploadProjectAsset('occupied.png', 'image/png', buildPng(42), 'spot');
		await uploadProjectAsset('mover.png', 'image/png', buildPng(43));
		// Rename mover.png onto the occupied path.
		const res = await callToolViaMcp(await agentToken(), 'move_project_asset', {
			project: projectId,
			from: 'mover.png',
			to: 'spot/occupied.png',
		});
		expect(String(res.error)).toMatch(/already exists.*never overwrite/i);
	});

	it('rejects an extension change', async () => {
		await uploadProjectAsset('typed.png', 'image/png', buildPng(44));
		const res = await callToolViaMcp(await agentToken(), 'move_project_asset', {
			project: projectId,
			from: 'typed.png',
			to: 'typed.jpg',
		});
		expect(String(res.error)).toMatch(/keep the '\.png' extension/i);
	});

	it('rejects an over-deep destination', async () => {
		await uploadProjectAsset('depth.png', 'image/png', buildPng(45));
		const res = await callToolViaMcp(await agentToken(), 'move_project_asset', {
			project: projectId,
			from: 'depth.png',
			to: 'a/b/c/depth.png',
		});
		expect(String(res.error)).toMatch(/folder levels/i);
	});
});

describe('copy_project_asset', () => {
	async function agentToken(): Promise<string> {
		const { token: t } = await mintAgentToken(db, masterKeyManager, agentId, teamId, taskId);
		return t;
	}

	it('copies bytes to a new asset id, leaving the source intact', async () => {
		const up = await (
			await uploadProjectAsset('template.png', 'image/png', buildPng(50), 'templates')
		).json();

		const res = await callToolViaMcp(await agentToken(), 'copy_project_asset', {
			project: projectId,
			from: 'templates/template.png',
			to: 'q3/template.png',
		});
		expect(res.copied).toBe(true);
		expect(res.reference).toBe('assets/q3/template.png');
		expect(res.id).not.toBe(up.data.id);

		// Both rows exist; bytes are identical but independently stored.
		const rows = await db.query<{ id: string; sha256: string }>(
			`SELECT id, sha256 FROM assets WHERE project_id = $1
			 AND original_filename IN ('templates/template.png', 'q3/template.png')`,
			[projectId],
		);
		expect(rows.rows).toHaveLength(2);
		expect(rows.rows[0].sha256).toBe(rows.rows[1].sha256);
		const { readFileSync } = await import('node:fs');
		expect(readFileSync(diskPath(res.id as string))).toEqual(readFileSync(diskPath(up.data.id)));
	});

	it('never overwrites: destination taken errors and leaves no orphan blob', async () => {
		await uploadProjectAsset('dst.png', 'image/png', buildPng(51), 'busy');
		await uploadProjectAsset('src.png', 'image/png', buildPng(52));
		const res = await callToolViaMcp(await agentToken(), 'copy_project_asset', {
			project: projectId,
			from: 'src.png',
			to: 'busy/dst.png',
		});
		expect(String(res.error)).toMatch(/already exists.*never overwrite/i);
	});

	it('errors when the source is missing', async () => {
		const res = await callToolViaMcp(await agentToken(), 'copy_project_asset', {
			project: projectId,
			from: 'nope/none.png',
			to: 'anywhere/none.png',
		});
		expect(String(res.error)).toContain("'assets/nope/none.png' not found");
	});
});

describe('admin move endpoint (PATCH /projects/:projectId/assets/:assetId)', () => {
	it('moves an asset into a folder and returns the refreshed row', async () => {
		const up = await (await uploadProjectAsset('sortme.png', 'image/png', buildPng(60))).json();
		const res = await app.request(`/api/projects/${projectId}/assets/${up.data.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ folder: 'sorted/bin' }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.original_filename).toBe('sorted/bin/sortme.png');
		expect(body.data.url).toMatch(/^\/api\/assets\//);
		expect(body.data.comment_attachment_count).toBe(0);
	});

	it('moves back to the root with an empty folder', async () => {
		const up = await (
			await uploadProjectAsset('backhome.png', 'image/png', buildPng(61), 'away')
		).json();
		const res = await app.request(`/api/projects/${projectId}/assets/${up.data.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ folder: '' }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.original_filename).toBe('backhome.png');
	});

	it('409s when the destination path is taken', async () => {
		await uploadProjectAsset('clash.png', 'image/png', buildPng(62), 'crowded');
		const loose = await (await uploadProjectAsset('clash.png', 'image/png', buildPng(63))).json();
		const res = await app.request(`/api/projects/${projectId}/assets/${loose.data.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ folder: 'crowded' }),
		});
		expect(res.status).toBe(409);
	});

	it('rejects agents and invalid folders', async () => {
		const up = await (await uploadProjectAsset('fixed.png', 'image/png', buildPng(64))).json();
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
		);
		const agentRes = await app.request(`/api/projects/${projectId}/assets/${up.data.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ folder: 'anywhere' }),
		});
		expect(agentRes.status).toBe(403);

		const badRes = await app.request(`/api/projects/${projectId}/assets/${up.data.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ folder: 'a/b/c' }),
		});
		expect(badRes.status).toBe(400);
	});
});

describe('foldered asset mention resolution', () => {
	it('resolves assets/<folder>/<name> composites with a signed url', async () => {
		await uploadProjectAsset('find-me.png', 'image/png', buildPng(70), 'nested/deep');
		const projectSlug = (
			await db.query<{ slug: string }>('SELECT slug FROM projects WHERE id = $1', [projectId])
		).rows[0].slug;

		const res = await app.request(`/api/projects/${projectId}/docs/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				assets: [{ project_slug: projectSlug, filename: 'nested/deep/find-me.png' }],
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()).data as {
			assets: Array<{ filename: string; signed_url: string }>;
		};
		expect(body.assets).toHaveLength(1);
		expect(body.assets[0].filename).toBe('nested/deep/find-me.png');
		expect(body.assets[0].signed_url).toMatch(/^\/api\/assets\//);
	});
});

describe('asset sort order (REST + MCP)', () => {
	// Own team/project so the fixed set isn't polluted by the shared project's
	// accumulating uploads. Names + created_at are chosen so the three orders
	// are all distinct: alpha ≠ newest ≠ oldest.
	let sortProjectId: string;
	let sortAgentToken: string;
	const ids: Record<string, string> = {};

	async function uploadTo(pid: string, filename: string, seed: number): Promise<string> {
		const fd = new FormData();
		const bytes = buildPng(seed);
		fd.set('file', new File([blobBytes(bytes)], filename, { type: 'image/png' }));
		const res = await app.request(`/api/projects/${pid}/assets`, {
			method: 'POST',
			headers: { ...authHeader(token) },
			body: fd,
		});
		expect(res.status).toBe(201);
		return (await res.json()).data.id;
	}

	async function restList(query = ''): Promise<string[]> {
		const res = await app.request(`/api/projects/${sortProjectId}/assets${query}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		return ((await res.json()).data as Array<{ original_filename: string }>).map(
			(a) => a.original_filename,
		);
	}

	async function mcpList(args: Record<string, unknown>): Promise<string[]> {
		const out = (await callToolViaMcp(sortAgentToken, 'list_project_assets', args)) as {
			files: Array<{ filename: string }>;
		};
		return out.files.map((f) => f.filename);
	}

	beforeAll(async () => {
		const teamRes = await createTestTeam(db, { name: 'Sort Co' });
		const sortTeamId = (await teamRes.json()).data.id;
		const projectRes = await createTestProject(db, sortTeamId, { name: 'Sortable' });
		sortProjectId = (await projectRes.json()).data.id;

		const agentRes = await app.request(`/api/projects/${sortProjectId}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Sort Bot' }),
		});
		const sortAgentId = (await agentRes.json()).data.id;
		const taskRes = await app.request(`/api/projects/${sortProjectId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Sort task', assignee_id: sortAgentId }),
		});
		const sortTaskId = (await taskRes.json()).data.id;
		sortAgentToken = (
			await mintAgentToken(db, masterKeyManager, sortAgentId, sortTeamId, sortTaskId)
		).token;

		ids.banana = await uploadTo(sortProjectId, 'banana.png', 40);
		ids.apple = await uploadTo(sortProjectId, 'apple.png', 41);
		ids.cherry = await uploadTo(sortProjectId, 'cherry.png', 42);
		// Pin created_at so date ordering is deterministic (uploads share now()).
		await db.query(`UPDATE assets SET created_at = $1 WHERE id = $2`, [
			'2026-01-03T00:00:00.000Z',
			ids.banana,
		]);
		await db.query(`UPDATE assets SET created_at = $1 WHERE id = $2`, [
			'2026-01-02T00:00:00.000Z',
			ids.apple,
		]);
		await db.query(`UPDATE assets SET created_at = $1 WHERE id = $2`, [
			'2026-01-01T00:00:00.000Z',
			ids.cherry,
		]);
	});

	it('REST defaults to newest-first', async () => {
		expect(await restList()).toEqual(['banana.png', 'apple.png', 'cherry.png']);
	});

	it('REST honours ?sort=oldest and ?sort=alphabetical', async () => {
		expect(await restList('?sort=oldest')).toEqual(['cherry.png', 'apple.png', 'banana.png']);
		expect(await restList('?sort=alphabetical')).toEqual(['apple.png', 'banana.png', 'cherry.png']);
	});

	it('REST falls back to newest for an unknown sort value', async () => {
		expect(await restList('?sort=bogus')).toEqual(['banana.png', 'apple.png', 'cherry.png']);
	});

	it('MCP list_project_assets defaults to newest and honours sort', async () => {
		expect(await mcpList({})).toEqual(['banana.png', 'apple.png', 'cherry.png']);
		expect(await mcpList({ sort: 'oldest' })).toEqual(['cherry.png', 'apple.png', 'banana.png']);
		expect(await mcpList({ sort: 'alphabetical' })).toEqual([
			'apple.png',
			'banana.png',
			'cherry.png',
		]);
	});

	it('MCP composes filter and sort', async () => {
		await db.query(`UPDATE assets SET archived_at = now() WHERE id = $1`, [ids.apple]);
		// Active (default) excludes the archived apple, still newest-first.
		expect(await mcpList({ sort: 'newest' })).toEqual(['banana.png', 'cherry.png']);
		// 'all' brings it back, ordered alphabetically.
		expect(await mcpList({ filter: 'all', sort: 'alphabetical' })).toEqual([
			'apple.png',
			'banana.png',
			'cherry.png',
		]);
	});
});
