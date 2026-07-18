import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let adminUserId: string;

function pngWithDimensions(width: number, height: number): Buffer {
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(25);
	ihdr.writeUInt32BE(13, 0);
	ihdr.write('IHDR', 4, 'ascii');
	ihdr.writeUInt32BE(width, 8);
	ihdr.writeUInt32BE(height, 12);
	return Buffer.concat([sig, ihdr]);
}

function iconForm(bytes: Buffer, type = 'image/png'): FormData {
	const fd = new FormData();
	fd.set('file', new Blob([bytes], { type }), 'icon.png');
	return fd;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const users = await app.request('/api/users', { headers: authHeader(token) });
	const list: { id: string; is_superuser: boolean }[] = (await users.json()).data;
	adminUserId = list.find((u) => u.is_superuser)?.id ?? list[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('user (admin) icon upload/serve', () => {
	it('lists the admin user', async () => {
		const res = await app.request('/api/users', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const list = (await res.json()).data;
		expect(list.length).toBeGreaterThanOrEqual(1);
		expect(list.some((u: { is_superuser: boolean }) => u.is_superuser)).toBe(true);
	});

	it('requires authentication', async () => {
		const res = await app.request('/api/users');
		expect(res.status).toBe(401);
	});

	it('rejects a non-superuser (403)', async () => {
		const reg = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Regular', false) RETURNING id",
		);
		const regToken = await signAdminJwt(masterKeyManager, reg.rows[0].id);
		const res = await app.request('/api/users', { headers: authHeader(regToken) });
		expect(res.status).toBe(403);
	});

	it('uploads an avatar and returns a signed url', async () => {
		const res = await app.request(`/api/users/${adminUserId}/icon`, {
			method: 'PUT',
			headers: authHeader(token),
			body: iconForm(pngWithDimensions(512, 512)),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.icon_url).toMatch(/\/api\/users\/[\w-]+\/icon\?exp=\d+&sig=[^&]+&v=\d+/);
		expect(body.data.icon_updated_at).toBeTruthy();
	});

	it('carries the signed icon_url on the users list', async () => {
		const res = await app.request('/api/users', { headers: authHeader(token) });
		const admin = (await res.json()).data.find((u: { id: string }) => u.id === adminUserId);
		expect(admin.icon_url).toBeTruthy();
	});

	it('serves the stored bytes from the signed url', async () => {
		const res = await app.request('/api/users', { headers: authHeader(token) });
		const admin = (await res.json()).data.find((u: { id: string }) => u.id === adminUserId);

		const serve = await app.request(admin.icon_url);
		expect(serve.status).toBe(200);
		expect(serve.headers.get('Content-Type')).toBe('image/png');
		const buf = Buffer.from(await serve.arrayBuffer());
		expect(buf.equals(pngWithDimensions(512, 512))).toBe(true);
	});

	it('rejects an unsigned request to the serve endpoint', async () => {
		const res = await app.request(`/api/users/${adminUserId}/icon`);
		expect(res.status).toBe(401);
	});

	it('rejects an image exceeding 512px', async () => {
		const res = await app.request(`/api/users/${adminUserId}/icon`, {
			method: 'PUT',
			headers: authHeader(token),
			body: iconForm(pngWithDimensions(513, 512)),
		});
		expect(res.status).toBe(400);
	});

	it('rejects an unsupported content type', async () => {
		const res = await app.request(`/api/users/${adminUserId}/icon`, {
			method: 'PUT',
			headers: authHeader(token),
			body: iconForm(Buffer.from('<svg/>'), 'image/svg+xml'),
		});
		expect(res.status).toBe(400);
	});

	it('removes the avatar', async () => {
		const del = await app.request(`/api/users/${adminUserId}/icon`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(del.status).toBe(200);

		const res = await app.request('/api/users', { headers: authHeader(token) });
		const admin = (await res.json()).data.find((u: { id: string }) => u.id === adminUserId);
		expect(admin.icon_url).toBeNull();
	});
});
