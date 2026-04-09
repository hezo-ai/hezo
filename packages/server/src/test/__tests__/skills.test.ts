import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateMasterKey, MasterKeyManager } from '../../crypto/master-key';
import { loadAgentRoles } from '../../db/agent-roles';
import { seedBuiltins } from '../../db/seed';
import {
	readAllSkillContents,
	readSkillManifest,
	resolveSkillsPath,
	writeSkillFile,
	writeSkillManifest,
} from '../../lib/docs';
import type { Env } from '../../lib/types';
import { signBoardJwt } from '../../middleware/auth';
import { parseGitHubRawUrl, SkillDownloadError } from '../../services/skill-downloader';
import { resolveSystemPrompt } from '../../services/template-resolver';
import { buildApp } from '../../startup';
import { safeClose } from '../helpers';
import { authHeader } from '../helpers/app';
import { createTestDbWithMigrations } from '../helpers/db';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let companyId: string;
let companySlug: string;
let tempDataDir: string;

function makeFetchResponse(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: { 'content-type': 'text/markdown' },
	});
}

function stubFetch(body: string, status = 200) {
	vi.stubGlobal(
		'fetch',
		vi.fn().mockImplementation(() => Promise.resolve(makeFetchResponse(body, status))),
	);
}

beforeAll(async () => {
	tempDataDir = join(
		tmpdir(),
		`hezo-test-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
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
		"INSERT INTO users (display_name, is_superuser) VALUES ('Skills Admin', true) RETURNING id",
	);
	token = await signBoardJwt(masterKeyManager, userResult.rows[0].id);

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Skills Co', issue_prefix: 'SKL' }),
	});
	const companyBody = await companyRes.json();
	companyId = companyBody.data.id;
	companySlug = companyBody.data.slug;
});

afterAll(async () => {
	await safeClose(db);
	rmSync(tempDataDir, { recursive: true, force: true });
	vi.unstubAllGlobals();
});

beforeEach(() => {
	vi.unstubAllGlobals();
});

describe('parseGitHubRawUrl', () => {
	it('converts GitHub blob URL to raw URL', () => {
		const input = 'https://github.com/owner/repo/blob/main/path/to/skill.md';
		expect(parseGitHubRawUrl(input)).toBe(
			'https://raw.githubusercontent.com/owner/repo/main/path/to/skill.md',
		);
	});

	it('passes raw GitHub URLs through unchanged', () => {
		const raw = 'https://raw.githubusercontent.com/owner/repo/main/skill.md';
		expect(parseGitHubRawUrl(raw)).toBe(raw);
	});

	it('passes arbitrary HTTPS URLs through unchanged', () => {
		const url = 'https://example.com/skill.md';
		expect(parseGitHubRawUrl(url)).toBe(url);
	});

	it('rejects invalid URLs', () => {
		expect(() => parseGitHubRawUrl('not a url')).toThrow(SkillDownloadError);
	});
});

describe('Skill filesystem helpers', () => {
	it('reads empty manifest when file does not exist', () => {
		const skillsDir = join(tempDataDir, 'companies', 'nonexistent', 'skills');
		const manifest = readSkillManifest(skillsDir);
		expect(manifest).toEqual({ skills: [] });
	});

	it('writes and reads skill files + manifest', () => {
		const skillsDir = resolveSkillsPath(tempDataDir, 'fs-test');
		writeSkillFile(skillsDir, 'my-skill', '# Hello');
		writeSkillManifest(skillsDir, {
			skills: [
				{
					name: 'My Skill',
					slug: 'my-skill',
					description: 'test',
					source_url: 'https://example.com/skill.md',
					content_hash: 'abc',
					last_synced_at: '2026-01-01T00:00:00.000Z',
				},
			],
		});
		const manifest = readSkillManifest(skillsDir);
		expect(manifest.skills).toHaveLength(1);
		expect(manifest.skills[0].slug).toBe('my-skill');
		const all = readAllSkillContents(skillsDir);
		expect(all).toEqual([{ name: 'My Skill', content: '# Hello' }]);
	});
});

describe('Skills API', () => {
	beforeEach(() => {
		// Reset skills directory between tests
		const skillsDir = resolveSkillsPath(tempDataDir, companySlug);
		if (existsSync(skillsDir)) {
			rmSync(skillsDir, { recursive: true, force: true });
		}
	});

	it('creates a skill by downloading from a URL', async () => {
		stubFetch('# Git Best Practices\n\nDo good things.');

		const res = await app.request(`/api/companies/${companyId}/skills`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Git Best Practices',
				source_url: 'https://example.com/git.md',
				description: 'Git conventions',
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.slug).toBe('git-best-practices');
		expect(body.data.name).toBe('Git Best Practices');
		expect(body.data.content_hash).toBeTruthy();

		const skillsDir = resolveSkillsPath(tempDataDir, companySlug);
		const content = readFileSync(join(skillsDir, 'git-best-practices.md'), 'utf-8');
		expect(content).toBe('# Git Best Practices\n\nDo good things.');
	});

	it('lists skills', async () => {
		stubFetch('# Content');

		await app.request(`/api/companies/${companyId}/skills`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Alpha', source_url: 'https://example.com/a.md' }),
		});
		await app.request(`/api/companies/${companyId}/skills`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Beta', source_url: 'https://example.com/b.md' }),
		});

		const res = await app.request(`/api/companies/${companyId}/skills`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		// At least the 2 we just created (plus any from earlier tests)
		expect(body.data.length).toBeGreaterThanOrEqual(2);
		const slugs = body.data.map((s: any) => s.slug);
		expect(slugs).toContain('alpha');
		expect(slugs).toContain('beta');
	});

	it('gets skill by slug with content', async () => {
		stubFetch('# Code Review');

		await app.request(`/api/companies/${companyId}/skills`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Code Review', source_url: 'https://example.com/cr.md' }),
		});

		const res = await app.request(`/api/companies/${companyId}/skills/code-review`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.content).toBe('# Code Review');
	});

	it('updates skill metadata', async () => {
		stubFetch('# X');

		await app.request(`/api/companies/${companyId}/skills`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Original', source_url: 'https://example.com/x.md' }),
		});

		const res = await app.request(`/api/companies/${companyId}/skills/original`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Updated Name', description: 'New desc' }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.name).toBe('Updated Name');
		expect(body.data.description).toBe('New desc');
	});

	it('syncs a skill by re-downloading', async () => {
		stubFetch('# Version 1');

		await app.request(`/api/companies/${companyId}/skills`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Sync Test', source_url: 'https://example.com/s.md' }),
		});

		stubFetch('# Version 2');
		const res = await app.request(`/api/companies/${companyId}/skills/sync-test/sync`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: '{}',
		});
		expect(res.status).toBe(200);

		const skillsDir = resolveSkillsPath(tempDataDir, companySlug);
		const content = readFileSync(join(skillsDir, 'sync-test.md'), 'utf-8');
		expect(content).toBe('# Version 2');
	});

	it('deletes a skill', async () => {
		stubFetch('# Del');

		await app.request(`/api/companies/${companyId}/skills`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Delete Me', source_url: 'https://example.com/d.md' }),
		});

		const res = await app.request(`/api/companies/${companyId}/skills/delete-me`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);

		const getRes = await app.request(`/api/companies/${companyId}/skills/delete-me`, {
			headers: authHeader(token),
		});
		expect(getRes.status).toBe(404);

		const skillsDir = resolveSkillsPath(tempDataDir, companySlug);
		expect(existsSync(join(skillsDir, 'delete-me.md'))).toBe(false);
	});

	it('returns 404 for nonexistent skill', async () => {
		const res = await app.request(`/api/companies/${companyId}/skills/does-not-exist`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});

	it('rejects download when content is too large', async () => {
		const huge = 'x'.repeat(600 * 1024);
		stubFetch(huge);

		const res = await app.request(`/api/companies/${companyId}/skills`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Too Big', source_url: 'https://example.com/big.md' }),
		});
		expect(res.status).toBe(422);
	});

	it('rejects download when 404', async () => {
		stubFetch('Not found', 404);

		const res = await app.request(`/api/companies/${companyId}/skills`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Missing', source_url: 'https://example.com/missing.md' }),
		});
		expect(res.status).toBe(404);
	});

	it('requires auth', async () => {
		const res = await app.request(`/api/companies/${companyId}/skills`);
		expect(res.status).toBe(401);
	});
});

describe('Template resolver with skills_context', () => {
	it('injects skill contents into the prompt from DB', async () => {
		// Clean DB skills for this test
		await db.query('DELETE FROM skills WHERE company_id = $1', [companyId]);

		// Insert a skill directly into DB
		await db.query(
			`INSERT INTO skills (company_id, name, slug, content, content_hash, is_active)
			 VALUES ($1, 'Direct Skill', 'direct-skill', '# Direct Skill\nDo the thing.', 'hash', true)`,
			[companyId],
		);

		const resolved = await resolveSystemPrompt(db, 'Agent prompt.\n\n{{skills_context}}\n\nEnd.', {
			companyId,
			dataDir: tempDataDir,
		});

		expect(resolved).toContain('## Skill: Direct Skill');
		expect(resolved).toContain('Do the thing.');
	});

	it('falls back to placeholder when no skills', async () => {
		// Clean DB skills and filesystem
		await db.query('DELETE FROM skills WHERE company_id = $1', [companyId]);
		const skillsDir = resolveSkillsPath(tempDataDir, companySlug);
		if (existsSync(skillsDir)) {
			rmSync(skillsDir, { recursive: true, force: true });
		}

		const resolved = await resolveSystemPrompt(db, '{{skills_context}}', {
			companyId,
			dataDir: tempDataDir,
		});
		expect(resolved).toContain('No skills configured.');
	});
});

describe('skills DB operations', () => {
	it('creates a skill via POST and stores in DB', async () => {
		// This test relies on the download mock from the parent describe
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response('# Test skill content', { status: 200, headers: { 'content-length': '22' } }),
		);

		const res = await app.request(`/api/companies/${companyId}/skills`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeader(token) },
			body: JSON.stringify({
				name: 'DB Test Skill',
				source_url: 'https://example.com/skill.md',
				description: 'A test skill',
				tags: ['test', 'db'],
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { data: Record<string, unknown> };
		expect(body.data.name).toBe('DB Test Skill');
		expect(body.data.id).toBeDefined();
		expect(body.data.tags).toEqual(['test', 'db']);
		expect(body.data.content).toBe('# Test skill content');

		// Verify it's in the database
		const dbResult = await db.query('SELECT * FROM skills WHERE company_id = $1 AND slug = $2', [
			companyId,
			'db-test-skill',
		]);
		expect(dbResult.rows.length).toBe(1);
	});

	it('lists skills from DB', async () => {
		const res = await app.request(`/api/companies/${companyId}/skills`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: Array<Record<string, unknown>> };
		expect(Array.isArray(body.data)).toBe(true);
	});
});
