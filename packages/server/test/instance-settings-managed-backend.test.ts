import { DEFAULT_MAX_CONTAINER_MEMORY_GB, SandboxBackend } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { setHostMemoryForTest } from '../src/lib/host-memory';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createStubDocker, createTestApp } from './helpers/app';

/**
 * The capacity model asks the engine where its containers' memory comes from,
 * rather than probing this host - so an instance driving a managed backend is
 * not sized by the machine Hezo happens to be installed on.
 *
 * The host is given an absurd amount of memory here on purpose: if any of this
 * still derived from `os.totalmem()`, these numbers would be enormous rather
 * than the flat default, and the assertions would say so.
 */
describe('instance settings on a backend whose containers run elsewhere', () => {
	let app: Hono<Env>;
	let db: Db;
	let token: string;

	beforeAll(async () => {
		setHostMemoryForTest({ totalRamBytes: 512 * 1024 ** 3, totalSwapBytes: 0 });
		const ctx = await createTestApp({
			docker: createStubDocker({ containerHostMemory: () => null }),
			sandboxBackendInfo: {
				backend: SandboxBackend.Daytona,
				display: 'https://app.daytona.io/api',
			},
		});
		app = ctx.app;
		db = ctx.db;
		token = ctx.token;
	});

	afterAll(async () => {
		setHostMemoryForTest(null);
		await safeClose(db);
	});

	async function settings() {
		const res = await app.request('/api/instance-settings', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		return (await res.json()).data;
	}

	it('reports no host memory, so the settings page cannot render a formula out of it', async () => {
		const data = await settings();
		// Null rather than 0: the figures are not "none", they are "not from here",
		// and a page showing "0 GB RAM" would read as a broken host.
		expect(data.host_total_ram_bytes).toBeNull();
		expect(data.host_total_swap_bytes).toBeNull();
	});

	it('budgets from the flat default rather than 512 GB of the wrong computer', async () => {
		const data = await settings();
		expect(data.max_container_memory_gb).toBe(DEFAULT_MAX_CONTAINER_MEMORY_GB);
		expect(data.max_container_memory_gb_computed_default).toBe(DEFAULT_MAX_CONTAINER_MEMORY_GB);
		expect(data.max_container_memory_gb_is_set).toBe(false);
	});

	it('still takes an explicit budget from the operator', async () => {
		// The backend decides the *default*, never the ceiling on what may be set:
		// scaling a managed fleet up is exactly the thing an operator does here.
		const res = await app.request('/api/instance-settings', {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ max_container_memory_gb: 64 }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.max_container_memory_gb).toBe(64);

		const data = await settings();
		expect(data.max_container_memory_gb).toBe(64);
		expect(data.max_container_memory_gb_is_set).toBe(true);
		// The automatic value is still reported alongside so the page can offer a
		// reset that names what it would go back to.
		expect(data.max_container_memory_gb_computed_default).toBe(DEFAULT_MAX_CONTAINER_MEMORY_GB);
	});

	it('reports the backend as managed, with the endpoint pre-redacted by the server', async () => {
		const res = await app.request('/api/sandbox-backend-info', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const info = (await res.json()).data;
		expect(info.backend).toBe(SandboxBackend.Daytona);
		expect(info.display).toBe('https://app.daytona.io/api');
	});
});
