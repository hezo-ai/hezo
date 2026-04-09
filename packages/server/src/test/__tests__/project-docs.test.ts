import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateMasterKey, MasterKeyManager } from '../../crypto/master-key';
import { loadAgentRoles } from '../../db/agent-roles';
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
	tempDataDir = join(tmpdir(), `hezo-test-docs-${Date.now()}`);
	mkdirSync(tempDataDir, { recursive: true });

	db = await createTestDbWithMigrations();
	const masterKeyManager = new MasterKeyManager();
	const masterKeyHex = generateMasterKey();
	await masterKeyManager.initialize(db, masterKeyHex);
	await seedBuiltins(db, await loadAgentRoles());
	app = buildApp(db, masterKeyManager, {
		dataDir: tempDataDir,
		connectUrl: '',
		connectPublicKey: '',
	});
	const userResult = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Test Admin', true) RETURNING id",
	);
	token = await signBoardJwt(masterKeyManager, userResult.rows[0].id);

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Doc Test Co', issue_prefix: 'DTC' }),
	});
	companyId = (await companyRes.json()).data.id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Main Project' }),
	});
	projectId = (await projectRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
	rmSync(tempDataDir, { recursive: true, force: true });
});

describe('Project docs (DB-backed)', () => {
	it('lists docs (empty initially)', async () => {
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
		expect(body.data.id).toBeDefined();
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

	it('updates a doc via PUT (upsert)', async () => {
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

		const getRes = await app.request(
			`/api/companies/${companyId}/projects/${projectId}/docs/to-delete.md`,
			{ headers: authHeader(token) },
		);
		expect(getRes.status).toBe(404);
	});

	it('works for projects without a designated repo', async () => {
		// Project docs are DB-backed, so no repo is needed
		const res = await app.request(`/api/companies/${companyId}/projects/${projectId}/docs`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
	});

	it('stores docs in the database', async () => {
		const result = await db.query(
			'SELECT * FROM project_docs WHERE project_id = $1 AND filename = $2',
			[projectId, 'spec.md'],
		);
		expect(result.rows.length).toBe(1);
		expect((result.rows[0] as any).content).toContain('Tech Spec v2');
	});

	it('creates multiple docs for same project', async () => {
		await app.request(`/api/companies/${companyId}/projects/${projectId}/docs/prd.md`, {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: '# PRD\n\nProduct requirements.' }),
		});
		await app.request(
			`/api/companies/${companyId}/projects/${projectId}/docs/implementation-plan.md`,
			{
				method: 'PUT',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ content: '# Implementation Plan\n\nPhase 1...' }),
			},
		);

		const res = await app.request(`/api/companies/${companyId}/projects/${projectId}/docs`, {
			headers: authHeader(token),
		});
		const body = await res.json();
		const filenames = body.data.map((d: any) => d.filename);
		expect(filenames).toContain('prd.md');
		expect(filenames).toContain('implementation-plan.md');
		expect(filenames).toContain('spec.md');
	});
});

describe('AGENTS.md (filesystem-based)', () => {
	let repoProjectId: string;

	beforeAll(async () => {
		// Create a project with a designated repo for AGENTS.md tests
		const projRes = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Repo Project' }),
		});
		repoProjectId = (await projRes.json()).data.id;

		const repoResult = await db.query(
			`INSERT INTO repos (project_id, short_name, repo_identifier, host_type)
			 VALUES ($1, 'main-app', 'org/main-app', 'github') RETURNING id`,
			[repoProjectId],
		);
		const repoId = (repoResult.rows[0] as any).id;
		await db.query('UPDATE projects SET designated_repo_id = $1, slug = $2 WHERE id = $3', [
			repoId,
			'repo-project',
			repoProjectId,
		]);

		// Get company slug
		const company = await db.query<{ slug: string }>('SELECT slug FROM companies WHERE id = $1', [
			companyId,
		]);
		const companySlug = company.rows[0].slug;
		const repoDir = join(
			tempDataDir,
			'companies',
			companySlug,
			'projects',
			'repo-project',
			'main-app',
		);
		mkdirSync(repoDir, { recursive: true });
	});

	it('writes and reads AGENTS.md', async () => {
		const writeRes = await app.request(
			`/api/companies/${companyId}/projects/${repoProjectId}/agents-md`,
			{
				method: 'PUT',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ content: '# Agent Rules\n\nFollow these rules.' }),
			},
		);
		expect(writeRes.status).toBe(200);

		const readRes = await app.request(
			`/api/companies/${companyId}/projects/${repoProjectId}/agents-md`,
			{ headers: authHeader(token) },
		);
		expect(readRes.status).toBe(200);
		const body = await readRes.json();
		expect(body.data.content).toContain('Agent Rules');
	});

	it('returns 404 for AGENTS.md on project without repo', async () => {
		const projRes = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'No Repo' }),
		});
		const noRepoProjId = (await projRes.json()).data.id;

		const res = await app.request(
			`/api/companies/${companyId}/projects/${noRepoProjId}/agents-md`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});
});
