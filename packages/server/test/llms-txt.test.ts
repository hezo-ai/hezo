import { HEZO_DOCS_URL } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: Db;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
});

afterAll(async () => {
	await safeClose(db);
});

describe('GET /llms.txt', () => {
	it('serves markdown that points to the MCP API and SKILL.md', async () => {
		const res = await app.request('/llms.txt');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('text/markdown');
		const text = await res.text();
		// Not swallowed by the SPA catch-all.
		expect(text.startsWith('# Hezo')).toBe(true);
		expect(text).toContain('> '); // blockquote summary
		expect(text).toContain('/mcp');
		expect(text).toContain('/SKILL.md');
		// Docs section points at the live documentation site.
		expect(text).toContain(HEZO_DOCS_URL);
	});

	it('uses the configured instance base URL when set', async () => {
		await db.query(
			`INSERT INTO system_meta (key, value) VALUES ('instance_base_url', 'https://hezo.example.com')
			 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
		);
		const res = await app.request('/llms.txt');
		const text = await res.text();
		expect(text).toContain('https://hezo.example.com/mcp');
		expect(text).toContain('https://hezo.example.com/SKILL.md');
	});
});

describe('GET /SKILL.md', () => {
	it('documents the connect/register flow and the tool list', async () => {
		const res = await app.request('/SKILL.md');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('text/markdown');
		const text = await res.text();
		expect(text).toContain('# Hezo Skill File');
		// Onboarding tools + registration flow.
		expect(text).toContain('register');
		expect(text).toContain('connection_status');
		expect(text).toContain('/api/api-keys/register');
		// Regular MCP tools still listed.
		expect(text).toContain('list_teams');
		expect(text).toContain('create_task');
		// Points to the live docs site rather than inlining the docs.
		expect(text).toContain(HEZO_DOCS_URL);
		// The full docs are not embedded — SKILL.md stays the lean MCP manifest.
		expect(text).not.toContain('# Hezo documentation');
	});
});
