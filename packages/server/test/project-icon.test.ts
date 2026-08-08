import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { blobBytes, safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let projectSlug: string;

const DESCRIPTION = 'A backend API that serves authenticated requests for the main app.';

/**
 * Build a minimal but structurally-valid PNG: the 8-byte signature plus an IHDR
 * chunk carrying the given dimensions. `readImageDimensions` only parses the
 * header, so the rest of the file body is omitted.
 */
function pngWithDimensions(width: number, height: number): Buffer {
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(25);
	ihdr.writeUInt32BE(13, 0); // chunk length
	ihdr.write('IHDR', 4, 'ascii');
	ihdr.writeUInt32BE(width, 8);
	ihdr.writeUInt32BE(height, 12);
	return Buffer.concat([sig, ihdr]);
}

function iconForm(bytes: Buffer, type = 'image/png'): FormData {
	const fd = new FormData();
	fd.set('file', new Blob([blobBytes(bytes)], { type }), 'icon.png');
	return fd;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const res = await app.request('/api/projects', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Icon Project', description: DESCRIPTION }),
	});
	projectSlug = (await res.json()).data.slug;
});

afterAll(async () => {
	await safeClose(db);
});

describe('project icon upload/serve', () => {
	it('uploads an icon and returns a signed url', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/icon`, {
			method: 'PUT',
			headers: authHeader(token),
			body: iconForm(pngWithDimensions(512, 512)),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.icon_url).toMatch(/\/api\/projects\/[\w-]+\/icon\?exp=\d+&sig=[^&]+&v=\d+/);
		expect(body.data.icon_updated_at).toBeTruthy();
	});

	it('serves the stored bytes from the signed url', async () => {
		const list = await app.request('/api/projects', { headers: authHeader(token) });
		const project = (await list.json()).data.find((p: { slug: string }) => p.slug === projectSlug);
		expect(project.icon_url).toBeTruthy();

		const res = await app.request(project.icon_url);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/png');
		const buf = Buffer.from(await res.arrayBuffer());
		expect(buf.equals(pngWithDimensions(512, 512))).toBe(true);
	});

	it('rejects an unsigned request to the serve endpoint', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/icon`);
		expect(res.status).toBe(401);
	});

	it('rejects an image exceeding 512px', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/icon`, {
			method: 'PUT',
			headers: authHeader(token),
			body: iconForm(pngWithDimensions(513, 512)),
		});
		expect(res.status).toBe(400);
	});

	it('rejects an unsupported content type', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/icon`, {
			method: 'PUT',
			headers: authHeader(token),
			body: iconForm(Buffer.from('<svg/>'), 'image/svg+xml'),
		});
		expect(res.status).toBe(400);
	});

	it('removes the icon', async () => {
		const del = await app.request(`/api/projects/${projectSlug}/icon`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(del.status).toBe(200);

		const list = await app.request('/api/projects', { headers: authHeader(token) });
		const project = (await list.json()).data.find((p: { slug: string }) => p.slug === projectSlug);
		expect(project.icon_url).toBeNull();

		const rows = await db.query('SELECT 1 FROM project_icons WHERE project_id IS NOT NULL');
		expect(rows.rows.length).toBe(0);
	});
});
