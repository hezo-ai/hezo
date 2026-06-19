import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateUnlockKey, MasterKeyManager } from '../src/crypto/master-key';
import { loadAgentRoles } from '../src/db/agent-roles';
import { seedBuiltins } from '../src/db/seed';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { parseGitHubRawUrl, SkillDownloadError } from '../src/services/skill-downloader';
import { resolveSystemPrompt } from '../src/services/template-resolver';
import { buildApp } from '../src/startup';
import { safeClose } from './helpers';
import { authHeader, createStubDocker } from './helpers/app';
import { createTestDbWithMigrations } from './helpers/db';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;
let tempDataDir: string;

beforeAll(async () => {
	tempDataDir = join(
		tmpdir(),
		`hezo-test-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(tempDataDir, { recursive: true });

	db = await createTestDbWithMigrations();
	const masterKeyManager = new MasterKeyManager();
	await masterKeyManager.initialize(db, generateUnlockKey());
	await seedBuiltins(db, await loadAgentRoles());
	app = buildApp(db, masterKeyManager, { dataDir: tempDataDir, webUrl: '' }, createStubDocker());
	const userResult = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Skills Admin', true) RETURNING id",
	);
	token = await signAdminJwt(masterKeyManager, userResult.rows[0].id);

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Skills Co' }),
	});
	teamId = (await teamRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
	rmSync(tempDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
	await db.query('DELETE FROM skills');
});

describe('parseGitHubRawUrl', () => {
	it('converts GitHub blob URL to raw URL', () => {
		expect(parseGitHubRawUrl('https://github.com/owner/repo/blob/main/path/to/skill.md')).toBe(
			'https://raw.githubusercontent.com/owner/repo/main/path/to/skill.md',
		);
	});

	it('passes raw GitHub URLs through unchanged', () => {
		const raw = 'https://raw.githubusercontent.com/owner/repo/main/skill.md';
		expect(parseGitHubRawUrl(raw)).toBe(raw);
	});

	it('rejects invalid URLs', () => {
		expect(() => parseGitHubRawUrl('not a url')).toThrow(SkillDownloadError);
	});
});

describe('global skills CRUD (/api/skills)', () => {
	async function create(body: Record<string, unknown>): Promise<Response> {
		return app.request('/api/skills', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	it('creates, lists, reads, updates, and deletes a global skill', async () => {
		const created = await create({
			name: 'Code Review',
			content: '# Code Review\nReview the diff carefully.',
			tags: ['quality'],
		});
		expect(created.status).toBe(201);
		const skill = (await created.json()).data as { id: string; slug: string };
		expect(skill.slug).toBe('code-review');

		const list = await app.request('/api/skills', { headers: authHeader(token) });
		expect((await list.json()).data.some((s: { slug: string }) => s.slug === 'code-review')).toBe(
			true,
		);

		const read = await app.request('/api/skills/code-review', { headers: authHeader(token) });
		expect((await read.json()).data.content).toContain('Review the diff');

		const patched = await app.request('/api/skills/code-review', {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: '# Code Review\nUpdated body.' }),
		});
		expect(patched.status).toBe(200);

		const del = await app.request('/api/skills/code-review', {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(del.status).toBe(200);
		const gone = await app.request('/api/skills/code-review', { headers: authHeader(token) });
		expect(gone.status).toBe(404);
	});

	it('re-POST with the same slug upserts (unique on slug instance-wide)', async () => {
		await create({ name: 'Dup', slug: 'dup', content: 'v1' });
		const second = await create({ name: 'Dup', slug: 'dup', content: 'v2' });
		expect(second.status).toBe(201);
		const read = await app.request('/api/skills/dup', { headers: authHeader(token) });
		expect((await read.json()).data.content).toBe('v2');
	});
});

describe('template resolver {{skills_context}} (global)', () => {
	it('injects the skill manifest (name + slug) from the global skills table', async () => {
		await db.query(
			`INSERT INTO skills (name, slug, content, content_hash, is_active)
			 VALUES ('Direct Skill', 'direct-skill', '# Direct Skill\nDo the thing.', 'hash', true)`,
		);

		const resolved = await resolveSystemPrompt(db, 'Agent prompt.\n\n{{skills_context}}\n\nEnd.', {
			teamId,
			dataDir: tempDataDir,
		});

		// Manifest lists name + slug, not the full body.
		expect(resolved).toContain('- Direct Skill (slug: direct-skill)');
		expect(resolved).not.toContain('Do the thing.');
	});

	it('falls back to a placeholder when there are no skills', async () => {
		const resolved = await resolveSystemPrompt(db, '{{skills_context}}', {
			teamId,
			dataDir: tempDataDir,
		});
		expect(resolved).toContain('No skills');
	});

	it('lists every active skill in the manifest', async () => {
		await db.query(
			`INSERT INTO skills (name, slug, content, content_hash, is_active)
			 VALUES ('Deploy', 'deploy', '# Deploy', 'h', true),
			        ('React', 'react', '# React', 'h', true)`,
		);
		const resolved = await resolveSystemPrompt(db, '{{skills_context}}', {
			teamId,
			dataDir: tempDataDir,
		});
		expect(resolved).toContain('- Deploy (slug: deploy)');
		expect(resolved).toContain('- React (slug: react)');
	});
});
