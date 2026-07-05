import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateUnlockKey, MasterKeyManager } from '../src/crypto/master-key';
import { loadAgentRoles } from '../src/db/agent-roles';
import type { Db } from '../src/db/database';
import { seedBuiltins } from '../src/db/seed';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { buildApp } from '../src/startup';
import { safeClose } from './helpers';
import { createStubDocker, createTestProject, createTestTeam } from './helpers/app';
import { createTestDbWithMigrations } from './helpers/db';

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let projectId: string;
let dataDir: string;

beforeAll(async () => {
	dataDir = join(tmpdir(), `hezo-preview-test-${Date.now()}`);
	mkdirSync(dataDir, { recursive: true });

	db = await createTestDbWithMigrations();
	const masterKeyManager = new MasterKeyManager();
	const masterKeyHex = generateUnlockKey();
	await masterKeyManager.initialize(db, masterKeyHex);
	await seedBuiltins(db, await loadAgentRoles());
	app = buildApp(db, masterKeyManager, { dataDir, webUrl: '' }, createStubDocker());
	const userResult = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Test Admin', true) RETURNING id",
	);
	token = await signAdminJwt(masterKeyManager, userResult.rows[0].id);

	const teamRes = await createTestTeam(db, { name: 'Preview Co' });
	const team = (await teamRes.json()).data;
	teamId = team.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Preview Project',
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;
	projectId = project.id;

	// Create workspace directory with test files matching getWorkspacePath layout
	const workspacePath = join(dataDir, 'teams', teamId, 'projects', projectId, 'workspace');
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
		const res = await app.request(`/api/projects/${projectId}/preview/index.html`, {
			headers: authHeader(),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('text/html');
		const text = await res.text();
		expect(text).toContain('<html>');
	});

	it('serves CSS with correct MIME type', async () => {
		const res = await app.request(`/api/projects/${projectId}/preview/style.css`, {
			headers: authHeader(),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('text/css');
	});

	it('serves JS with correct MIME type', async () => {
		const res = await app.request(`/api/projects/${projectId}/preview/app.js`, {
			headers: authHeader(),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('application/javascript');
	});

	it('returns 404 for non-existent file', async () => {
		const res = await app.request(`/api/projects/${projectId}/preview/missing.html`, {
			headers: authHeader(),
		});
		expect(res.status).toBe(404);
	});

	it('returns 404 for non-existent project', async () => {
		const fakeId = '00000000-0000-0000-0000-000000000000';
		const res = await app.request(`/api/projects/${fakeId}/preview/index.html`, {
			headers: authHeader(),
		});
		expect(res.status).toBe(404);
	});

	it('blocks directory traversal attempts', async () => {
		const res = await app.request(`/api/projects/${projectId}/preview/../../../etc/passwd`, {
			headers: authHeader(),
		});
		// Should be 403 or 404 — never serve files outside workspace
		expect([403, 404]).toContain(res.status);
	});
});
