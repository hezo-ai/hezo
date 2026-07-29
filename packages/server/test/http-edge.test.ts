import { API_BODY_MAX_BYTES, ATTACHMENT_MAX_BYTES } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { asBodyBytes } from '../src/lib/bytes';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: Db;
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

describe('global /api body limit', () => {
	// Before this, only the handful of upload routes were capped: a JSON body had
	// no bound at all, so one request could ask the process to buffer arbitrarily
	// much before any handler saw it.
	it('rejects a body over the ceiling with 413 rather than buffering it', async () => {
		const res = await app.request('/api/projects', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: 'x'.repeat(API_BODY_MAX_BYTES + 1024),
		});
		expect(res.status).toBe(413);
		const body = await res.json();
		expect(body.error.code).toBe('TOO_LARGE');
	});

	it('leaves an ordinary request untouched', async () => {
		// The ceiling is a backstop, not the binding constraint - a normal request
		// must reach its handler and get its handler's own answer.
		const res = await app.request('/api/projects', { headers: authHeader(token) });
		expect(res.status).toBe(200);
	});

	it('does not pre-empt a route that polices its own size', async () => {
		// A body between the largest per-route cap and the global ceiling must
		// still reach its handler, so the route can answer with its own specific
		// error rather than an opaque 413. This is the regression that setting the
		// ceiling to ATTACHMENT_MAX_BYTES introduced: it also meant a *valid*
		// maximum-size attachment was rejected for its multipart envelope.
		expect(API_BODY_MAX_BYTES).toBeGreaterThan(ATTACHMENT_MAX_BYTES);
		const res = await app.request('/api/projects', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'x'.repeat(ATTACHMENT_MAX_BYTES + 1) }),
		});
		// The handler's own answer, whatever it is - just not the middleware's.
		expect(res.status).not.toBe(413);
	});

	it('does not cap non-API routes', async () => {
		// `/api/*` only: the MCP surface carries its own limits, and the static
		// handler serves the SPA.
		const res = await app.request('/api/does-not-exist', { headers: authHeader(token) });
		expect(res.status).toBe(404);
	});
});

describe('asBodyBytes', () => {
	it('views the buffer without copying it', () => {
		const buf = Buffer.from('hello world');
		const view = asBodyBytes(buf);
		expect(view.buffer).toBe(buf.buffer);
		expect(Buffer.from(view).toString()).toBe('hello world');
	});

	it('respects a pooled buffer offset rather than exposing the whole pool', () => {
		// A Node Buffer is a window into a shared allocation pool, so viewing
		// `buf.buffer` whole would hand out unrelated memory - the trap that makes
		// the naive zero-copy version worse than the copy it replaces.
		const pool = Buffer.alloc(64, 0);
		const slice = pool.subarray(8, 16);
		slice.write('12345678');
		const view = asBodyBytes(slice);
		expect(view.byteOffset).toBe(slice.byteOffset);
		expect(view.byteLength).toBe(8);
		expect(Buffer.from(view).toString()).toBe('12345678');
	});

	it('round-trips through a Response body unchanged', async () => {
		const bytes = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80]);
		const res = new Response(asBodyBytes(bytes));
		expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
	});
});
