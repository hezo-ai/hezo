import { DEFAULT_TASK_VIEW, TaskView } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { DEFAULT_TASK_VIEW_KEY, setSystemMeta } from '../src/lib/system-meta';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let nonSuperuserToken: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const nonAdmin = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Regular Admin', false) RETURNING id",
	);
	nonSuperuserToken = await signAdminJwt(ctx.masterKeyManager, nonAdmin.rows[0].id);
});

afterAll(async () => {
	await safeClose(db);
});

function patchTaskView(value: unknown, authToken = token) {
	return app.request('/api/instance-settings', {
		method: 'PATCH',
		headers: { ...authHeader(authToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ default_task_view: value }),
	});
}

async function readTaskView(authToken = token): Promise<unknown> {
	const res = await app.request('/api/instance-settings', { headers: authHeader(authToken) });
	expect(res.status).toBe(200);
	return (await res.json()).data.default_task_view;
}

describe('default_task_view', () => {
	it('reports the shipped default on a fresh instance', async () => {
		expect(await readTaskView()).toBe(DEFAULT_TASK_VIEW);
		expect(await readTaskView()).toBe(TaskView.Conversation);
	});

	it('is readable by a non-superuser', async () => {
		expect(await readTaskView(nonSuperuserToken)).toBe(TaskView.Conversation);
	});

	it('stores a superuser write and echoes it back', async () => {
		const res = await patchTaskView(TaskView.Detailed);
		expect(res.status).toBe(200);
		// Response-driven: the PATCH echo is what the client caches.
		expect((await res.json()).data.default_task_view).toBe(TaskView.Detailed);
		expect(await readTaskView()).toBe(TaskView.Detailed);
		expect(await readTaskView(nonSuperuserToken)).toBe(TaskView.Detailed);
	});

	it('switches back to conversation', async () => {
		const res = await patchTaskView(TaskView.Conversation);
		expect(res.status).toBe(200);
		expect(await readTaskView()).toBe(TaskView.Conversation);
	});

	it('rejects a write from a non-superuser and leaves the value alone', async () => {
		const res = await patchTaskView(TaskView.Detailed, nonSuperuserToken);
		expect(res.status).toBe(403);
		expect(await readTaskView()).toBe(TaskView.Conversation);
	});

	it('rejects an unrecognised view', async () => {
		for (const bad of ['simple', '', null, 3, true, { view: 'detailed' }]) {
			const res = await patchTaskView(bad);
			expect(res.status).toBe(400);
			expect((await res.json()).error.message).toContain('default_task_view must be one of');
		}
		expect(await readTaskView()).toBe(TaskView.Conversation);
	});

	it('falls back to the default when the stored row is not a view', async () => {
		// A value written by a newer build, then downgraded past it.
		await setSystemMeta(db, DEFAULT_TASK_VIEW_KEY, 'timeline');
		expect(await readTaskView()).toBe(DEFAULT_TASK_VIEW);
		await setSystemMeta(db, DEFAULT_TASK_VIEW_KEY, TaskView.Conversation);
	});

	it('leaves the other settings untouched', async () => {
		const before = await app.request('/api/instance-settings', { headers: authHeader(token) });
		const beforeBody = (await before.json()).data;
		const res = await patchTaskView(TaskView.Detailed);
		const afterBody = (await res.json()).data;
		expect(afterBody.max_chat_history_size).toBe(beforeBody.max_chat_history_size);
		expect(afterBody.default_container_disk_gb).toBe(beforeBody.default_container_disk_gb);
		expect(afterBody.base_url).toBe(beforeBody.base_url);
	});
});
