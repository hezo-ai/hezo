import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

// Exercises the SPA-serving catch-all in buildApp() (startup.ts). The compiled
// binary serves from the in-memory bundle, but in source/dev that bundle is the
// empty stub (loadStaticBundle -> null) so the handler falls through to the
// FILESYSTEM fallback reading packages/web/dist. createTestContext builds the
// app via the production buildApp(), so these requests hit the real catch-all —
// no full server boot or container needed.
//
// The populated in-memory-bundle branch only exists in the compiled binary
// (bundle-static.ts fills static-bundle.json) and is covered separately by the
// fake-bundle tests in startup-serving.test.ts; it is unreachable from source,
// so it is intentionally not covered here.

// web/dist resolved the same way startup.ts resolves it, relative to the source.
const webDistDir = resolve(__dirname, '..', 'src', '..', '..', 'web', 'dist');
const hasDist = existsSync(resolve(webDistDir, 'index.html'));

describe('buildApp SPA serving (filesystem fallback)', () => {
	let ctx: ServerTestContext;
	beforeAll(async () => {
		ctx = await createTestContext();
	});
	afterAll(() => destroyTestContext(ctx));

	it('returns 404 for an unknown /api/ path (not SPA fallback)', async () => {
		// Authenticated: an unknown /api route must 404 (not fall through to the SPA
		// index.html). Without a token it would 401 at the auth middleware first.
		const res = await ctx.app.request('/api/this-route-does-not-exist', {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(404);
		expect(await res.text()).toBe('Not found');
	});

	it.runIf(hasDist)('serves index.html for the root path with html content-type', async () => {
		const res = await ctx.app.request('/');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('text/html');
		const body = await res.text();
		expect(body.toLowerCase()).toContain('<!doctype html');
	});

	it.runIf(hasDist)('serves a real static asset with its mapped content-type', async () => {
		// logo.svg ships in web/dist; extname '.svg' -> 'image/svg+xml' in STATIC_MIME.
		const res = await ctx.app.request('/logo.svg');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
	});

	it.runIf(hasDist)('serves a PWA icon bitmap with the png content-type', async () => {
		// The maskable icon is what Android installs to the home screen; extname
		// '.png' -> 'image/png' in STATIC_MIME. Served from the embedded bundle in a
		// compiled binary, so a missing MIME mapping breaks the installed icon only
		// in production.
		const res = await ctx.app.request('/icons/icon-512-maskable.png');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/png');
	});

	it.runIf(hasDist)('serves the PWA manifest with the manifest content-type', async () => {
		// manifest.webmanifest ships in web/dist; extname '.webmanifest' must map to
		// 'application/manifest+json' or Chrome rejects the manifest and the app is
		// not installable.
		const res = await ctx.app.request('/manifest.webmanifest');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('application/manifest+json');
		const body = (await res.json()) as { display?: string };
		expect(body.display).toBe('standalone');
	});

	it.runIf(hasDist)(
		'falls back to index.html for an unknown SPA route (client-side routing)',
		async () => {
			const res = await ctx.app.request('/some/deep/client/route');
			expect(res.status).toBe(200);
			expect(res.headers.get('Content-Type')).toContain('text/html');
		},
	);

	it.skipIf(hasDist)('returns 404 when no bundle and no dist directory exist', async () => {
		// Only reachable when web/dist is absent (CI before web build). Asserts the
		// terminal 404 branch of the catch-all.
		const res = await ctx.app.request('/some/deep/client/route');
		expect(res.status).toBe(404);
	});
});
