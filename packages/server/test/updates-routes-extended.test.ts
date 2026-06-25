import { UpdateState } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/lib/types';
import * as updater from '../src/services/updater';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: Awaited<ReturnType<typeof createTestApp>>['db'];
let token: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
});

afterAll(async () => {
	await safeClose(db);
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** Make the latest-release check return an available update deterministically. */
function mockAvailableUpdate() {
	return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
		new Response(
			JSON.stringify({
				tag_name: '99.9.9',
				html_url: 'https://github.com/hezo-ai/hezo/releases/99.9.9',
			}),
			{ status: 200, headers: { 'Content-Type': 'application/json' } },
		),
	);
}

describe('GET /updates/status (supervised auto-stage)', () => {
	it('triggers a background stage and reports canApply=true when supervised', async () => {
		mockAvailableUpdate();
		vi.spyOn(updater, 'isSupervisedWorker').mockReturnValue(true);
		const stageSpy = vi
			.spyOn(updater, 'ensureUpdateStaged')
			.mockResolvedValue(
				undefined as unknown as Awaited<ReturnType<typeof updater.ensureUpdateStaged>>,
			);
		vi.spyOn(updater, 'readUpdateState').mockResolvedValue({ state: UpdateState.Idle });

		const res = await app.request('/api/updates/status', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.canApply).toBe(true);
		// The auto-stage trigger fired (idempotent in production; here it's stubbed).
		expect(stageSpy).toHaveBeenCalled();
	});
});

describe('POST /updates/download (supervised)', () => {
	it('kicks off a background download+stage and returns 202 Downloading', async () => {
		mockAvailableUpdate();
		vi.spyOn(updater, 'isSupervisedWorker').mockReturnValue(true);
		const dlSpy = vi.spyOn(updater, 'downloadAndStage').mockResolvedValue(undefined);

		const res = await app.request('/api/updates/download', {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(202);
		const body = (await res.json()) as { data: { state: string; targetVersion: string } };
		expect(body.data.state).toBe(UpdateState.Downloading);
		expect(body.data.targetVersion).toBe('99.9.9');
		expect(dlSpy).toHaveBeenCalledWith('99.9.9', expect.any(String));
	});
});

describe('POST /updates/apply (supervised, no exit triggered)', () => {
	it('returns 409 NO_STAGED_UPDATE when there is no staged update', async () => {
		vi.spyOn(updater, 'isSupervisedWorker').mockReturnValue(true);
		vi.spyOn(updater, 'readUpdateState').mockResolvedValue({ state: UpdateState.Idle });

		const res = await app.request('/api/updates/apply', {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NO_STAGED_UPDATE');
	});
});
