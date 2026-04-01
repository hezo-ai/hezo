import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateMasterKey, MasterKeyManager } from '../../crypto/master-key';
import { seedBuiltins } from '../../db/seed';
import type { Env } from '../../lib/types';
import { signBoardJwt } from '../../middleware/auth';
import { buildApp } from '../../startup';
import { safeClose } from '../helpers';
import { createTestDbWithMigrations } from '../helpers/db';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let companyId: string;
let projectId: string;
let dataDir: string;

beforeAll(async () => {
	dataDir = join(tmpdir(), `hezo-preview-test-${Date.now()}`);
	mkdirSync(dataDir, { recursive: true });

	db = await createTestDbWithMigrations();
	const masterKeyManager = new MasterKeyManager();
	const masterKeyHex = generateMasterKey();
	await masterKeyManager.initialize(db, masterKeyHex);
	await seedBuiltins(db);
	app = buildApp(db, masterKeyManager, {
		dataDir,
		connectUrl: 'http://localhost:4100',
		connectPublicKey: '',
	});
	token = await signBoardJwt(masterKeyManager, 'test-user');

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Preview Co', issue_prefix: 'PVW' }),
	});
	const company = (await companyRes.json()).data;
	companyId = company.id;
	const companySlug = company.slug;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Preview Project' }),
	});
	const project = (await projectRes.json()).data;
	projectId = project.id;
	const projectSlug = project.slug;

	// Create workspace directory with test files matching getWorkspacePath layout
	const workspacePath = join(
		dataDir,
		'companies',
		companySlug,
		'projects',
		projectSlug,
		'workspace',
	);
	mkdirSync(workspacePath, { recursive: true });
	writeFileSync(join(workspacePath, 'index.html'), '<html><body>Hello</body></html>');
	writeFileSync(join(workspacePath, 'style.css'), 'body { color: red; }');
	writeFileSync(join(workspacePath, 'app.js'), 'console.log("hi");');
});

afterAll(async () => {
	await safeClose(db);
});

function authHeader() {
	return { Authorization: `Bearer ${token}` };
}

describe('preview route', () => {
	it('serves an HTML file from workspace', async () => {
		const res = await app.request(
			`/api/companies/${companyId}/projects/${projectId}/preview/index.html`,
			{ headers: authHeader() },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('text/html');
		const text = await res.text();
		expect(text).toContain('<html>');
	});

	it('serves CSS with correct MIME type', async () => {
		const res = await app.request(
			`/api/companies/${companyId}/projects/${projectId}/preview/style.css`,
			{ headers: authHeader() },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('text/css');
	});

	it('serves JS with correct MIME type', async () => {
		const res = await app.request(
			`/api/companies/${companyId}/projects/${projectId}/preview/app.js`,
			{ headers: authHeader() },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('application/javascript');
	});

	it('returns 404 for non-existent file', async () => {
		const res = await app.request(
			`/api/companies/${companyId}/projects/${projectId}/preview/missing.html`,
			{ headers: authHeader() },
		);
		expect(res.status).toBe(404);
	});

	it('returns 404 for non-existent project', async () => {
		const fakeId = '00000000-0000-0000-0000-000000000000';
		const res = await app.request(
			`/api/companies/${companyId}/projects/${fakeId}/preview/index.html`,
			{ headers: authHeader() },
		);
		expect(res.status).toBe(404);
	});

	it('blocks directory traversal attempts', async () => {
		const res = await app.request(
			`/api/companies/${companyId}/projects/${projectId}/preview/../../../etc/passwd`,
			{ headers: authHeader() },
		);
		// Should be 403 or 404 — never serve files outside workspace
		expect([403, 404]).toContain(res.status);
	});
});
