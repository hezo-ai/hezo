/**
 * Operator-pinned settings: what a deployment fixes, and what happens when the
 * person running the instance tries to change it anyway.
 *
 * The pinning itself is the interesting half. On a managed deployment the tenant
 * is still superuser on their own instance, so a UI lock proves nothing - what
 * has to hold is that the API refuses, that the run path reads the pinned value
 * rather than the stored one, and that the stored one survives to be restored on
 * unpin.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readPolicyFile } from '../src/config/policy';
import { resetRuntimeConfig, runtimeConfig, setPolicy } from '../src/config/runtime';
import { policySchema } from '../src/config/schema';
import type { Db } from '../src/db/database';
import {
	getDefaultContainerDiskGb,
	getDefaultRamCapPerContainerGb,
	getMaxContainerMemoryGbSetting,
	getMonthlyContainerHours,
	isPinned,
	MAX_CONTAINER_MEMORY_GB_KEY,
	setMonthlyContainerHours,
	setSystemMeta,
} from '../src/lib/system-meta';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let tmp: string;

/** Pin a set of settings for the duration of one case. */
function pin(pinned: Record<string, number>, managedBy = 'Acme Cloud', manageUrl?: string): void {
	setPolicy({ managedBy, manageUrl, pinned });
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	tmp = mkdtempSync(join(tmpdir(), 'hezo-policy-'));
});

afterEach(() => {
	// The policy lives in process-wide runtime config, so a case that leaves one
	// set would pin every case after it.
	resetRuntimeConfig();
});

afterAll(async () => {
	rmSync(tmp, { recursive: true, force: true });
	await safeClose(db);
});

describe('resolution', () => {
	it('reads the pinned value in place of the stored one', async () => {
		await setSystemMeta(db, MAX_CONTAINER_MEMORY_GB_KEY, '12');
		expect(await getMaxContainerMemoryGbSetting(db)).toBe(12);

		pin({ maxContainerMemoryGb: 64 });
		expect(await getMaxContainerMemoryGbSetting(db)).toBe(64);
		expect(isPinned('maxContainerMemoryGb')).toBe(true);
	});

	it('restores the stored value when the pin is lifted', async () => {
		// The honest story for an instance adopted into a managed fleet and later
		// released: pinning must never destroy what the operator chose.
		await setSystemMeta(db, MAX_CONTAINER_MEMORY_GB_KEY, '12');
		pin({ maxContainerMemoryGb: 64 });
		expect(await getMaxContainerMemoryGbSetting(db)).toBe(64);

		resetRuntimeConfig();
		expect(await getMaxContainerMemoryGbSetting(db)).toBe(12);
	});

	it('pins per key, leaving the rest to the operator', async () => {
		pin({ maxContainerMemoryGb: 64 });
		expect(isPinned('maxContainerMemoryGb')).toBe(true);
		// A deployment fixes what it bills for; disk and the RAM cap stay editable,
		// which a single "managed: true" flag could not express.
		expect(isPinned('defaultContainerDiskGb')).toBe(false);
		expect(await getDefaultContainerDiskGb(db)).toBe(5);
		expect(await getDefaultRamCapPerContainerGb(db)).toBe(2);
	});

	it('pins an hours allowance of zero as deliberately as a number', async () => {
		await setMonthlyContainerHours(db, 250);
		expect(await getMonthlyContainerHours(db)).toBe(250);
		// Zero means unlimited everywhere else a budget appears, so a deployment
		// must be able to pin "no limit" rather than only ever pinning a ceiling.
		pin({ monthlyContainerHours: 0 });
		expect(await getMonthlyContainerHours(db)).toBe(0);
	});
});

describe('PATCH /instance-settings', () => {
	async function patch(body: Record<string, unknown>) {
		return app.request('/api/instance-settings', {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	it('refuses a pinned key with 409, naming who set it', async () => {
		pin({ maxContainerMemoryGb: 64 }, 'Acme Cloud');
		const res = await patch({ max_container_memory_gb: 32 });
		expect(res.status).toBe(409);
		const message = (await res.json()).error.message as string;
		// Named, not merely refused: the operator has to know where to go.
		expect(message).toContain('Acme Cloud');
		expect(message).toContain('max_container_memory_gb');
	});

	it('never silently ignores the write - the stored row is untouched', async () => {
		await setSystemMeta(db, MAX_CONTAINER_MEMORY_GB_KEY, '12');
		pin({ maxContainerMemoryGb: 64 });
		await patch({ max_container_memory_gb: 32 });

		resetRuntimeConfig();
		// A write that appeared to succeed and changed nothing would be the worst of
		// both, so the refusal must also leave no trace.
		expect(await getMaxContainerMemoryGbSetting(db)).toBe(12);
	});

	it('still accepts an unpinned sibling', async () => {
		pin({ maxContainerMemoryGb: 64 });
		const res = await patch({ default_container_disk_gb: 10 });
		expect(res.status).toBe(200);
		expect(await getDefaultContainerDiskGb(db)).toBe(10);
	});
});

describe('PATCH /container-hours', () => {
	it('refuses a pinned allowance, like every other pinned key', async () => {
		// The allowance is the setting a compute-metered deployment is most likely
		// to fix, and it has its own route - so it needs its own guard rather than
		// inheriting the instance-settings one.
		pin({ monthlyContainerHours: 100 }, 'Acme Cloud');
		const res = await app.request('/api/container-hours', {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ monthly_hours: 500 }),
		});
		expect(res.status).toBe(409);
		expect((await res.json()).error.message).toContain('Acme Cloud');
	});

	it('reports the pin on the read, so the control renders locked', async () => {
		pin({ monthlyContainerHours: 100 }, 'Acme Cloud', 'https://example.com/plan');
		const res = await app.request('/api/container-hours', { headers: authHeader(token) });
		const data = (await res.json()).data as Record<string, unknown>;
		expect(data.monthly_hours).toBe(100);
		expect(data.monthly_hours_pinned).toBe(true);
		expect(data.policy).toEqual({
			managed_by: 'Acme Cloud',
			manage_url: 'https://example.com/plan',
		});
	});
});

describe('GET /instance-settings', () => {
	async function payload() {
		const res = await app.request('/api/instance-settings', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		return (await res.json()).data as Record<string, unknown>;
	}

	it('carries no policy on an ordinary instance', async () => {
		const data = await payload();
		expect(data.policy).toBeNull();
		expect(data.max_container_memory_gb_pinned).toBe(false);
	});

	it('reports which keys are pinned, and who to ask', async () => {
		pin({ maxContainerMemoryGb: 64 }, 'Acme Cloud', 'https://example.com/plan');
		const data = await payload();
		expect(data.max_container_memory_gb_pinned).toBe(true);
		expect(data.default_container_disk_gb_pinned).toBe(false);
		expect(data.policy).toEqual({
			managed_by: 'Acme Cloud',
			manage_url: 'https://example.com/plan',
		});
	});
});

describe('the policy file', () => {
	function write(name: string, contents: string): string {
		const path = join(tmp, name);
		writeFileSync(path, contents);
		return path;
	}

	it('reads a valid file', () => {
		const path = write(
			'good.json',
			JSON.stringify({ managedBy: 'Acme Cloud', pinned: { maxContainerMemoryGb: 64 } }),
		);
		expect(readPolicyFile(path)).toEqual({
			managedBy: 'Acme Cloud',
			pinned: { maxContainerMemoryGb: 64 },
		});
	});

	it('returns null for a malformed file rather than an empty policy', () => {
		// The distinction the reload path depends on: a deployment mid-write must
		// leave the previous pins standing, not silently unpin what it bills for.
		expect(readPolicyFile(write('broken.json', '{ not json'))).toBeNull();
		expect(readPolicyFile(join(tmp, 'absent.json'))).toBeNull();
		expect(readPolicyFile(write('wrong.json', JSON.stringify({ pinned: {} })))).toBeNull();
	});

	it('rejects a manageUrl that is not https', () => {
		// Operator-authored, so a typo should be loud at parse rather than a dead
		// link discovered by whoever clicks it - and `javascript:` must never reach
		// an href at all.
		for (const manageUrl of ['http://example.com/plan', 'javascript:alert(1)']) {
			expect(() => policySchema.parse({ managedBy: 'Acme', manageUrl, pinned: {} })).toThrow();
		}
		expect(() =>
			policySchema.parse({ managedBy: 'Acme', manageUrl: 'https://example.com/plan', pinned: {} }),
		).not.toThrow();
	});

	it('rejects an unknown pinnable key rather than ignoring it', () => {
		// `.strict()` throughout: a deployment that misspells a key must find out,
		// not discover later that the setting was never pinned.
		expect(() =>
			policySchema.parse({ managedBy: 'Acme', pinned: { maxContainerMemoryGB: 64 } }),
		).toThrow();
	});
});

describe('hot reload', () => {
	it('swaps the policy slice and leaves the rest of the config alone', () => {
		const before = runtimeConfig();
		pin({ maxContainerMemoryGb: 64 });
		const after = runtimeConfig();

		// The point of a narrow setter: a plan change must not restart the server,
		// and must not imply that the data dir or the port could change with it.
		expect(after.policy?.pinned.maxContainerMemoryGb).toBe(64);
		expect(after.dataDir).toBe(before.dataDir);
		expect(after.port).toBe(before.port);
	});
});
