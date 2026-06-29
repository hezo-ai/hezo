import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import { signAssetUrl } from '../src/lib/asset-urls';
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
let projectSlug: string;
let taskId: string;
let agentId: string;

function buildPng(seed = 0): Uint8Array {
	const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const extra = new Uint8Array(16);
	for (let i = 0; i < extra.length; i++) extra[i] = (i + seed) & 0xff;
	const out = new Uint8Array(sig.length + extra.length);
	out.set(sig, 0);
	out.set(extra, sig.length);
	return out;
}

async function uploadProjectAsset(
	filename: string,
	mime: string,
	bytes: Uint8Array,
	pid = projectId,
): Promise<Response> {
	const fd = new FormData();
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	fd.set('file', new File([copy.buffer], filename, { type: mime }));
	return app.request(`/api/projects/${pid}/assets`, {
		method: 'POST',
		headers: { ...authHeader(token) },
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

	const teamRes = await createTestTeam(db, { name: 'Asset Cov Co' });
	teamId = (await teamRes.json()).data.id;
	const projRes = await createTestProject(db, teamId, { name: 'Main', description: 'x' });
	const proj = (await projRes.json()).data;
	projectId = proj.id;
	projectSlug = proj.slug;

	const agentRes = await app.request(`/api/projects/${projectId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Cov Bot' }),
	});
	agentId = (await agentRes.json()).data.id;

	const taskRes = await app.request(`/api/projects/${projectId}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Asset Task', assignee_id: agentId }),
	});
	taskId = (await taskRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('upload validation branches', () => {
	it('400s when the multipart form has no file field', async () => {
		const fd = new FormData();
		fd.set('notfile', 'oops');
		const res = await app.request(`/api/projects/${projectId}/assets`, {
			method: 'POST',
			headers: { ...authHeader(token) },
			body: fd,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('400s when the file field is a plain string, not a Blob', async () => {
		const fd = new FormData();
		fd.set('file', 'just-a-string');
		const res = await app.request(`/api/projects/${projectId}/assets`, {
			method: 'POST',
			headers: { ...authHeader(token) },
			body: fd,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('rejects an allowed extension carrying a contradictory, specific MIME type', async () => {
		// A .png with a real-but-disallowed MIME (not octet-stream) is suspicious and rejected.
		const res = await uploadProjectAsset('shady.png', 'application/x-msdownload', buildPng(1));
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_ATTACHMENT');
	});

	it('rejects an unsupported extension before reading MIME', async () => {
		const res = await uploadProjectAsset('archive.zip', 'application/zip', buildPng(2));
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_ATTACHMENT');
	});

	it('404s when uploading to a non-existent project', async () => {
		const res = await uploadProjectAsset('x.png', 'image/png', buildPng(3), 'no-such-project');
		expect(res.status).toBe(404);
		expect((await res.json()).error.code).toBe('NOT_FOUND');
	});
});

describe('task-asset upload branches', () => {
	it('404s when the task does not exist on the team', async () => {
		const fd = new FormData();
		fd.set('file', new File([buildPng(4)], 'a.png', { type: 'image/png' }));
		const res = await app.request(
			`/api/projects/${projectId}/tasks/00000000-0000-0000-0000-000000000000/assets`,
			{ method: 'POST', headers: { ...authHeader(token) }, body: fd },
		);
		expect(res.status).toBe(404);
	});

	it('400s when the task-asset form has no file field', async () => {
		const fd = new FormData();
		fd.set('nope', 'x');
		const res = await app.request(`/api/projects/${projectId}/tasks/${taskId}/assets`, {
			method: 'POST',
			headers: { ...authHeader(token) },
			body: fd,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});
});

describe('delete branches', () => {
	it('404s deleting from a non-existent project', async () => {
		const res = await app.request(
			'/api/projects/no-such-project/assets/00000000-0000-0000-0000-000000000000',
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('404s deleting an unknown asset id', async () => {
		const res = await app.request(
			`/api/projects/${projectId}/assets/00000000-0000-0000-0000-000000000000`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
		expect((await res.json()).error.code).toBe('NOT_FOUND');
	});

	it('forbids an agent from deleting (403 before any lookup)', async () => {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			taskId,
		);
		const res = await app.request(
			`/api/projects/${projectId}/assets/00000000-0000-0000-0000-000000000000`,
			{ method: 'DELETE', headers: authHeader(agentToken) },
		);
		expect(res.status).toBe(403);
		expect((await res.json()).error.code).toBe('FORBIDDEN');
	});
});

describe('listing branch', () => {
	it('404s listing a non-existent project', async () => {
		const res = await app.request('/api/projects/no-such-project/assets', {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});
});

describe('public asset serving branches', () => {
	it('401s when the signature query params are missing', async () => {
		const res = await app.request('/api/assets/00000000-0000-0000-0000-000000000000');
		expect(res.status).toBe(401);
		expect((await res.json()).error.message).toMatch(/Missing signature/);
	});

	it('401s on an invalid signature', async () => {
		const res = await app.request(
			'/api/assets/00000000-0000-0000-0000-000000000000?exp=9999999999&sig=deadbeef',
		);
		expect(res.status).toBe(401);
		expect((await res.json()).error.message).toMatch(/Invalid or expired/);
	});

	it('404s on a validly-signed url for an asset that does not exist', async () => {
		// Sign a random (nonexistent) id so the signature verifies but the row is missing.
		const ghostId = '11111111-1111-1111-1111-111111111111';
		const url = await signAssetUrl(ghostId, masterKeyManager);
		const res = await app.request(url);
		expect(res.status).toBe(404);
		expect((await res.json()).error.message).toMatch(/Asset not found/);
	});

	it('404s when the row exists but the blob is missing on disk', async () => {
		const uploaded = await (
			await uploadProjectAsset('vanish.png', 'image/png', buildPng(5))
		).json();
		const onDisk = join(
			dataDir,
			'teams',
			teamId,
			'projects',
			projectId,
			'assets',
			uploaded.data.id,
		);
		expect(existsSync(onDisk)).toBe(true);
		// Delete only the blob, leaving the DB row, to exercise the readFile catch.
		await rm(onDisk, { force: true });

		const res = await app.request(uploaded.data.url);
		expect(res.status).toBe(404);
		expect((await res.json()).error.message).toMatch(/file missing/);
	});

	it('serves a stored asset with caching headers when valid', async () => {
		const uploaded = await (
			await uploadProjectAsset('served.png', 'image/png', buildPng(6))
		).json();
		const res = await app.request(uploaded.data.url);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
		expect(res.headers.get('cache-control')).toContain('private');
		expect(res.headers.get('content-disposition')).toContain('inline');
	});
});

describe('signed url shape', () => {
	it('produces a url scoped to the project asset (sanity)', async () => {
		const uploaded = await (await uploadProjectAsset('shape.png', 'image/png', buildPng(7))).json();
		expect(uploaded.data.url).toMatch(/^\/api\/assets\/[0-9a-f-]+\?exp=\d+&sig=/);
		// projectSlug is part of the test surface; assert it round-trips for clarity.
		expect(projectSlug).toBeTruthy();
	});
});
