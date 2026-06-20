import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
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
): Promise<Response> {
	const fd = new FormData();
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	fd.set('file', new File([copy.buffer], filename, { type: mime }));
	return app.request(`/api/projects/${projectId}/assets`, {
		method: 'POST',
		headers: { ...authHeader(token) },
		body: fd,
	});
}

async function uploadTaskAsset(filename: string, mime: string, bytes: Uint8Array): Promise<string> {
	const fd = new FormData();
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	fd.set('file', new File([copy.buffer], filename, { type: mime }));
	const res = await app.request(`/api/projects/${projectId}/tasks/${taskId}/assets`, {
		method: 'POST',
		headers: { ...authHeader(token) },
		body: fd,
	});
	return (await res.json()).data.id;
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

		const onDisk = join(dataDir, 'teams', teamId, 'projects', projectId, 'assets', body.data.id);
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
		const onDisk = join(dataDir, 'teams', teamId, 'projects', projectId, 'assets', row.rows[0].id);
		expect(existsSync(onDisk)).toBe(true);
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
		const oldDisk = join(
			dataDir,
			'teams',
			teamId,
			'projects',
			projectId,
			'assets',
			first.id as string,
		);
		expect(existsSync(oldDisk)).toBe(false);
	});

	it('rejects a binary asset type', async () => {
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
		expect(String(result.error)).toMatch(/text-based|\.html|\.svg|\.txt/i);
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
		const onDisk = join(dataDir, 'teams', teamId, 'projects', projectId, 'assets', id);
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
