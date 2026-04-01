import { mkdirSync, rmSync } from 'node:fs';
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
import { authHeader } from '../helpers/app';
import { createTestDbWithMigrations } from '../helpers/db';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let companyId: string;
let projectId: string;
let tempDataDir: string;

beforeAll(async () => {
	// Create a temp data dir for file operations
	tempDataDir = join(tmpdir(), `hezo-test-docs-${Date.now()}`);
	mkdirSync(tempDataDir, { recursive: true });

	// Build app with dataDir set
	db = await createTestDbWithMigrations();
	const masterKeyManager = new MasterKeyManager();
	const masterKeyHex = generateMasterKey();
	await masterKeyManager.initialize(db, masterKeyHex);
	await seedBuiltins(db);
	app = buildApp(db, masterKeyManager, {
		dataDir: tempDataDir,
		connectUrl: '',
		connectPublicKey: '',
	});
	const userResult = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Test Admin', true) RETURNING id",
	);
	token = await signBoardJwt(masterKeyManager, userResult.rows[0].id);

	// Create company
	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Doc Test Co', issue_prefix: 'DTC' }),
	});
	companyId = (await companyRes.json()).data.id;

	// Create project
	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Main Project' }),
	});
	projectId = (await projectRes.json()).data.id;

	// Create a repo record and set it as designated repo
	const repoResult = await db.query(
		`INSERT INTO repos (project_id, short_name, repo_identifier, host_type)
		 VALUES ($1, 'main-app', 'org/main-app', 'github')
		 RETURNING id`,
		[projectId],
	);
	const repoId = (repoResult.rows[0] as any).id;

	await db.query('UPDATE projects SET designated_repo_id = $1 WHERE id = $2', [repoId, projectId]);

	// Create the directory structure on disk
	// We need to figure out the company slug and project slug
	// Company slug is derived from issue_prefix (lowercased)
	// Project slug is derived from project name (lowercased, hyphenated)
	const repoDir = join(tempDataDir, 'companies', 'dtc', 'projects', 'main-project', 'main-app');
	mkdirSync(join(repoDir, '.dev'), { recursive: true });
});

afterAll(async () => {
	await safeClose(db);
	rmSync(tempDataDir, { recursive: true, force: true });
});

describe('Project docs (file-based)', () => {
	it('lists docs from empty .dev/ folder', async () => {
		const res = await app.request(`/api/companies/${companyId}/projects/${projectId}/docs`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toEqual([]);
	});

	it('creates a doc via PUT', async () => {
		const res = await app.request(
			`/api/companies/${companyId}/projects/${projectId}/docs/spec.md`,
			{
				method: 'PUT',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ content: '# Tech Spec\n\nThis is the spec.' }),
			},
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.filename).toBe('spec.md');
		expect(body.data.content).toContain('Tech Spec');
	});

	it('reads the doc back', async () => {
		const res = await app.request(
			`/api/companies/${companyId}/projects/${projectId}/docs/spec.md`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.content).toContain('Tech Spec');
	});

	it('lists docs after creating one', async () => {
		const res = await app.request(`/api/companies/${companyId}/projects/${projectId}/docs`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data.some((d: any) => d.filename === 'spec.md')).toBe(true);
	});

	it('returns 404 for non-existent doc', async () => {
		const res = await app.request(
			`/api/companies/${companyId}/projects/${projectId}/docs/non-existent.md`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('updates a doc via PUT', async () => {
		const res = await app.request(
			`/api/companies/${companyId}/projects/${projectId}/docs/spec.md`,
			{
				method: 'PUT',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ content: '# Tech Spec v2\n\nUpdated spec.' }),
			},
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.content).toContain('v2');
	});

	it('deletes a doc', async () => {
		// Create one to delete
		await app.request(`/api/companies/${companyId}/projects/${projectId}/docs/to-delete.md`, {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: 'temp' }),
		});

		const deleteRes = await app.request(
			`/api/companies/${companyId}/projects/${projectId}/docs/to-delete.md`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(deleteRes.status).toBe(200);

		// Verify it's gone
		const getRes = await app.request(
			`/api/companies/${companyId}/projects/${projectId}/docs/to-delete.md`,
			{ headers: authHeader(token) },
		);
		expect(getRes.status).toBe(404);
	});

	it('reads and writes AGENTS.md', async () => {
		// Write AGENTS.md
		const writeRes = await app.request(
			`/api/companies/${companyId}/projects/${projectId}/agents-md`,
			{
				method: 'PUT',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ content: '# Agent Rules\n\nFollow these rules.' }),
			},
		);
		expect(writeRes.status).toBe(200);
		const writeBody = await writeRes.json();
		expect(writeBody.data.filename).toBe('AGENTS.md');

		// Read AGENTS.md
		const readRes = await app.request(
			`/api/companies/${companyId}/projects/${projectId}/agents-md`,
			{ headers: authHeader(token) },
		);
		expect(readRes.status).toBe(200);
		const readBody = await readRes.json();
		expect(readBody.data.content).toContain('Agent Rules');
	});

	it('returns 404 for project without designated repo', async () => {
		// Create a project without a repo
		const projRes = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'No Repo Project' }),
		});
		const noRepoProjId = (await projRes.json()).data.id;

		const res = await app.request(`/api/companies/${companyId}/projects/${noRepoProjId}/docs`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});
});
