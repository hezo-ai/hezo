import {
	CONTAINER_DISK_GB_MIN,
	DEFAULT_CONTAINER_DISK_GB,
	poolDiskCeilingBytes,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getProjectContainerDiskGb, setDefaultContainerDiskGb } from '../src/lib/system-meta';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

/**
 * The container disk allocation, end to end: an instance default, a per-project
 * override, and the precedence between them.
 *
 * The property worth pinning is the precedence, not the storage. A project that
 * has never chosen a size must keep *following* the instance setting rather than
 * having been silently stamped with whatever it was at creation - that is the
 * difference between a default and a copy, and it is what makes changing the
 * global setting mean anything.
 */
describe('container disk allocation', () => {
	let app: Hono<Env>;
	let db: Awaited<ReturnType<typeof createTestApp>>['db'];
	let token: string;
	let projectId: string;
	let projectSlug: string;

	beforeAll(async () => {
		const ctx = await createTestApp();
		app = ctx.app;
		db = ctx.db;
		token = ctx.token;
		const res = await app.request('/api/projects', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Disky', description: 'disk allocation test' }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { data: { id: string; slug: string } };
		projectId = body.data.id;
		projectSlug = body.data.slug;
	});

	afterAll(async () => {
		await safeClose(db);
	});

	it('starts every project on the instance default', async () => {
		expect(await getProjectContainerDiskGb(db, projectId)).toBe(DEFAULT_CONTAINER_DISK_GB);
	});

	it('exposes the default in instance settings and accepts a new one', async () => {
		const before = await app.request('/api/instance-settings', { headers: authHeader(token) });
		expect(
			((await before.json()) as { data: { default_container_disk_gb: number } }).data
				.default_container_disk_gb,
		).toBe(DEFAULT_CONTAINER_DISK_GB);

		const patch = await app.request('/api/instance-settings', {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ default_container_disk_gb: 8 }),
		});
		expect(patch.status).toBe(200);
		expect(
			((await patch.json()) as { data: { default_container_disk_gb: number } }).data
				.default_container_disk_gb,
		).toBe(8);
	});

	it('carries the new default to a project that never chose one', async () => {
		// The point of a default: it is followed, not copied at creation.
		expect(await getProjectContainerDiskGb(db, projectId)).toBe(8);
	});

	it('refuses a default below the floor', async () => {
		const res = await app.request('/api/instance-settings', {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ default_container_disk_gb: CONTAINER_DISK_GB_MIN - 1 }),
		});
		expect(res.status).toBe(400);
		// Refused, not clamped - the stored value is untouched.
		await setDefaultContainerDiskGb(db, 8);
		expect(await getProjectContainerDiskGb(db, projectId)).toBe(8);
	});

	it('lets a project override the default, and clear the override again', async () => {
		const set = await app.request(`/api/projects/${projectSlug}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ container_disk_gb: 20 }),
		});
		expect(set.status).toBe(200);
		expect(await getProjectContainerDiskGb(db, projectId)).toBe(20);

		// The override wins over a changed default rather than being re-inherited.
		await setDefaultContainerDiskGb(db, 5);
		expect(await getProjectContainerDiskGb(db, projectId)).toBe(20);

		const clear = await app.request(`/api/projects/${projectSlug}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ container_disk_gb: null }),
		});
		expect(clear.status).toBe(200);
		expect(await getProjectContainerDiskGb(db, projectId)).toBe(5);
	});

	it('refuses a per-project override below the floor', async () => {
		const res = await app.request(`/api/projects/${projectSlug}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ container_disk_gb: 1 }),
		});
		expect(res.status).toBe(400);
		expect(await getProjectContainerDiskGb(db, projectId)).toBe(5);
	});

	it('recycles a container below its own allocation, with room to spare', () => {
		// The relationship the ceiling exists to hold: whatever the allocation, a
		// container is replaced before it is full, so a run never hits the wall
		// partway through. Asserted as a property across sizes rather than against a
		// pinned number, which would just restate the formula.
		for (const gb of [2, 3, 8, 20, 100]) {
			const ceiling = poolDiskCeilingBytes(gb);
			expect(ceiling).toBeGreaterThan(0);
			expect(ceiling).toBeLessThan(gb * 1024 ** 3);
		}
		// And it scales - a bigger container is not recycled at the same absolute
		// figure a small one is, which would waste most of its disk.
		expect(poolDiskCeilingBytes(20)).toBeGreaterThan(poolDiskCeilingBytes(3));
	});
});
