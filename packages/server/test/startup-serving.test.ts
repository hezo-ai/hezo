import { describe, expect, it } from 'vitest';
import type { StartupProgress } from '../src/startup-progress';
import { serveStartupRequest } from '../src/startup-serving';
import type { StaticAsset } from '../src/static-assets';

// The handler imports `StaticAsset` from static-assets; re-declare the shape here
// for the fake bundle so the test doesn't depend on Blob internals beyond {type,body}.
type FakeAsset = { type: string; body: Blob };

const PROGRESS: StartupProgress = {
	phase: 'migrations',
	message: 'Running database migrations…',
};

function req(path: string): Request {
	return new Request(`http://localhost:3100${path}`);
}

function bundle(entries: Record<string, FakeAsset>): Map<string, FakeAsset> {
	return new Map(Object.entries(entries));
}

const html: FakeAsset = {
	type: 'text/html; charset=utf-8',
	body: new Blob(['<!doctype html><title>Hezo</title>'], { type: 'text/html; charset=utf-8' }),
};
const js: FakeAsset = {
	type: 'application/javascript; charset=utf-8',
	body: new Blob(['console.log(1)'], { type: 'application/javascript; charset=utf-8' }),
};

const withBundle = (b: Map<string, FakeAsset> | null) => ({
	progress: PROGRESS,
	loadBundle: async () => b as unknown as Map<string, StaticAsset> | null,
});

describe('serveStartupRequest (pre-ready handler)', () => {
	it('answers /api/status with 200 and the live boot phase', async () => {
		const res = await serveStartupRequest(req('/api/status'), withBundle(null));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			starting: boolean;
			phase: string;
			message: string;
			version: string;
		};
		expect(body.starting).toBe(true);
		expect(body.phase).toBe('migrations');
		expect(body.message).toBe('Running database migrations…');
		expect(typeof body.version).toBe('string');
	});

	it('keeps /health answering 200 during boot', async () => {
		const res = await serveStartupRequest(req('/health'), withBundle(null));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it('returns a JSON 503 STARTING for other API surfaces so clients retry', async () => {
		for (const path of ['/api/projects', '/mcp', '/mcp/assets', '/ws', '/SKILL.md', '/llms.txt']) {
			const res = await serveStartupRequest(req(path), withBundle(null));
			expect(res.status, path).toBe(503);
			const body = (await res.json()) as { error?: { code?: string } };
			expect(body.error?.code, path).toBe('STARTING');
		}
	});

	it('serves the SPA shell (index.html) for a browser navigation when the bundle exists', async () => {
		const res = await serveStartupRequest(
			req('/'),
			withBundle(bundle({ '/index.html': html, '/assets/app.js': js })),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('text/html');
		expect(await res.text()).toContain('<title>Hezo</title>');
	});

	it('serves a real static asset by path', async () => {
		const res = await serveStartupRequest(
			req('/assets/app.js'),
			withBundle(bundle({ '/index.html': html, '/assets/app.js': js })),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('javascript');
		expect(await res.text()).toBe('console.log(1)');
	});

	it('falls back to index.html for unknown SPA routes (client-side routing)', async () => {
		const res = await serveStartupRequest(
			req('/projects/demo/tasks'),
			withBundle(bundle({ '/index.html': html })),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('text/html');
	});

	it('falls back to JSON 503 for navigations when no bundle is embedded (dev)', async () => {
		const res = await serveStartupRequest(req('/'), withBundle(null));
		expect(res.status).toBe(503);
		const body = (await res.json()) as { error?: { code?: string } };
		expect(body.error?.code).toBe('STARTING');
	});
});
