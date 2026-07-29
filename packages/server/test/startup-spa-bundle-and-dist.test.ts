import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MasterKeyManager } from '../src/crypto/master-key';
import { createMemoryDb } from '../src/db/client';
import type { PgliteDb } from '../src/db/drivers/pglite';
import type { Env } from '../src/lib/types';
import { buildApp } from '../src/startup';
import { safeClose } from './helpers';

// Covers buildApp's SPA catch-all branches that are unreachable from a plain
// source checkout: the in-memory static bundle (only populated in the compiled
// binary) and the packages/web/dist filesystem fallback (only present after a
// web build). The bundle loader and the two fs calls the handler makes are
// mocked; the handler itself runs real.

const state = vi.hoisted(() => ({
	bundle: null as null | Map<string, { type: string; body: Blob }>,
	// Fake packages/web/dist content, keyed by path relative to the dist dir
	// ('/index.html', '/app.css', ...). null → dist dir absent.
	dist: null as null | Record<string, string>,
}));

vi.mock('../src/static-assets', () => ({
	loadStaticBundle: async () => state.bundle,
}));

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>();
	const MARKER = '/web/dist';
	const rel = (p: unknown): string | null => {
		if (typeof p !== 'string') return null;
		const i = p.indexOf(MARKER);
		if (i === -1) return null;
		const r = p.slice(i + MARKER.length);
		return r === '' ? '/' : r;
	};
	return {
		...actual,
		existsSync: ((p: Parameters<typeof actual.existsSync>[0]) => {
			const r = rel(p);
			if (r !== null) {
				if (!state.dist) return false;
				return r === '/' || r in state.dist;
			}
			return actual.existsSync(p);
		}) as typeof actual.existsSync,
		readFileSync: ((p: Parameters<typeof actual.readFileSync>[0], o?: unknown) => {
			const r = rel(p);
			if (r !== null) {
				if (state.dist && r in state.dist) return Buffer.from(state.dist[r]);
				// Any other path under the fake dist must read as absent. The handler
				// probes with the read itself rather than stat-then-read, so falling
				// through to the real fs here would serve this repo's actual
				// packages/web/dist whenever it happens to have been built.
				const e = new Error(`ENOENT: no such file or directory, open '${String(p)}'`);
				(e as NodeJS.ErrnoException).code = 'ENOENT';
				throw e;
			}
			return actual.readFileSync(p, o as never);
		}) as typeof actual.readFileSync,
	};
});

function asset(type: string, body: string): { type: string; body: Blob } {
	return { type, body: new Blob([body], { type }) };
}

describe('buildApp SPA serving (embedded bundle + dist fallback branches)', () => {
	let db: PgliteDb;
	let app: Hono<Env>;
	let dataDir: string;

	beforeAll(async () => {
		dataDir = mkdtempSync(join(tmpdir(), 'hezo-spa-branches-'));
		db = await createMemoryDb();
		app = buildApp(db, new MasterKeyManager(), { dataDir, webUrl: '' });
	});

	afterAll(async () => {
		await safeClose(db);
		rmSync(dataDir, { recursive: true, force: true });
	});

	it('serves the SPA shell and assets from the in-memory bundle', async () => {
		state.bundle = new Map([
			['/index.html', asset('text/html; charset=utf-8', '<!doctype html><title>Bundle</title>')],
			['/assets/app.js', asset('application/javascript; charset=utf-8', 'console.log(1)')],
		]);
		state.dist = null;

		const root = await app.request('/');
		expect(root.status).toBe(200);
		expect(root.headers.get('Content-Type')).toContain('text/html');
		expect(await root.text()).toContain('<title>Bundle</title>');

		const js = await app.request('/assets/app.js');
		expect(js.status).toBe(200);
		expect(js.headers.get('Content-Type')).toContain('javascript');
		expect(await js.text()).toBe('console.log(1)');

		// Unknown SPA route falls back to index.html (client-side routing).
		const deep = await app.request('/projects/demo/tasks');
		expect(deep.status).toBe(200);
		expect(await deep.text()).toContain('<title>Bundle</title>');
	});

	it('404s when the bundle exists but carries neither the asset nor index.html', async () => {
		state.bundle = new Map([['/only.css', asset('text/css; charset=utf-8', 'body{}')]]);
		state.dist = null;

		const res = await app.request('/missing.js');
		expect(res.status).toBe(404);
		expect(await res.text()).toBe('Not found');
	});

	it('falls back to packages/web/dist on disk when no bundle is embedded', async () => {
		state.bundle = null;
		state.dist = {
			'/index.html': '<!doctype html><title>Dist</title>',
			'/app.css': 'body { color: red }',
			'/blob.weird': 'binary-ish',
		};

		// '/' maps to /index.html with the html content type.
		const root = await app.request('/');
		expect(root.status).toBe(200);
		expect(root.headers.get('Content-Type')).toContain('text/html');
		expect(await root.text()).toContain('<title>Dist</title>');

		// A real file is served with its mapped MIME type.
		const css = await app.request('/app.css');
		expect(css.status).toBe(200);
		expect(css.headers.get('Content-Type')).toContain('text/css');
		expect(await css.text()).toBe('body { color: red }');

		// Unmapped extensions default to octet-stream.
		const weird = await app.request('/blob.weird');
		expect(weird.status).toBe(200);
		expect(weird.headers.get('Content-Type')).toBe('application/octet-stream');

		// Unknown SPA route falls back to dist/index.html.
		const deep = await app.request('/some/deep/route');
		expect(deep.status).toBe(200);
		expect(deep.headers.get('Content-Type')).toContain('text/html');
		expect(await deep.text()).toContain('<title>Dist</title>');
	});

	it('404s when the dist dir exists without an index.html', async () => {
		state.bundle = null;
		state.dist = { '/app.css': 'body{}' };

		const res = await app.request('/nope');
		expect(res.status).toBe(404);
	});

	it('404s when neither a bundle nor a dist dir exists', async () => {
		state.bundle = null;
		state.dist = null;

		const res = await app.request('/anything');
		expect(res.status).toBe(404);
		expect(await res.text()).toBe('Not found');
	});
});
