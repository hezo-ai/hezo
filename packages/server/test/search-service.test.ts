import { HIGHLIGHT_SENTINEL } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { buildSearchTsQuery, fullTextSearch } from '../src/services/search';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

let db: Db;
let teamId: string;
let projectId: string;

async function seedTask(title: string, description: string): Promise<string> {
	const numRes = await db.query<{ number: number }>(
		'SELECT next_project_task_number($1) AS number',
		[projectId],
	);
	const num = numRes.rows[0].number;
	const res = await db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, number, identifier, title, description)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		[teamId, projectId, num, `EP-${num}`, title, description],
	);
	return res.rows[0].id;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;

	const teamResult = await db.query<{ id: string }>(
		"INSERT INTO teams (name, slug) VALUES ('Search Co', 'search-co') RETURNING id",
	);
	teamId = teamResult.rows[0].id;

	const projectResult = await db.query<{ id: string }>(
		"INSERT INTO projects (team_id, name, slug, task_prefix) VALUES ($1, 'Search Project', 'search-project', 'EP') RETURNING id",
		[teamId],
	);
	projectId = projectResult.rows[0].id;
	await db.query('INSERT INTO project_task_counters (project_id, next_number) VALUES ($1, 1)', [
		projectId,
	]);

	// Title-keyword match (weight A) vs body-only match (weight B) for the same term.
	await seedTask('Fix login bug', 'Users cannot authenticate with SSO');
	await seedTask('Deploy pipeline', 'A task whose body mentions login exactly once');

	await db.query(
		`INSERT INTO documents (team_id, project_id, type, slug, title, content)
		 VALUES ($1, $2, 'project_doc', 'spec.md', 'Product spec', 'Covers the checkout and payment flow')`,
		[teamId, projectId],
	);

	// One active + one inactive skill (inactive must never surface).
	await db.query(
		`INSERT INTO skills (name, slug, content, is_active)
		 VALUES ('Deploy Skill', 'deploy-skill', 'How to deploy to production', true),
		        ('Retired Skill', 'retired-skill', 'Old deployment notes', false)`,
	);

	// A text comment (searchable) plus a system comment (must be excluded).
	const commentTask = await seedTask('Payment flow', 'Stripe checkout');
	await db.query(
		`INSERT INTO task_comments (task_id, content_type, content)
		 VALUES ($1, 'text', $2::jsonb), ($1, 'system', $3::jsonb)`,
		[
			commentTask,
			JSON.stringify({ text: 'We should retry failed Stripe webhooks' }),
			JSON.stringify({ kind: 'status_change' }),
		],
	);
});

afterAll(async () => {
	await safeClose(db);
});

describe('buildSearchTsQuery', () => {
	it('ANDs terms and makes the final term a prefix', () => {
		expect(buildSearchTsQuery('fix login')).toBe('fix & login:*');
	});

	it('makes a single term a prefix', () => {
		expect(buildSearchTsQuery('log')).toBe('log:*');
	});

	it('strips punctuation and tsquery metacharacters', () => {
		expect(buildSearchTsQuery('login & (bug)!')).toBe('login & bug:*');
	});

	it('returns an empty string for blank or symbol-only input', () => {
		expect(buildSearchTsQuery('   ')).toBe('');
		expect(buildSearchTsQuery('!@#')).toBe('');
	});
});

describe('fullTextSearch', () => {
	it('returns no results for a blank query', async () => {
		expect(await fullTextSearch(db, [teamId], '   ')).toEqual([]);
	});

	it('finds a task by a title keyword', async () => {
		const results = await fullTextSearch(db, [teamId], 'login', { scope: 'tasks' });
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results[0].type).toBe('task');
		expect(results[0].title).toContain('Fix login bug');
	});

	it('matches a stemmed variant (logins → login)', async () => {
		const results = await fullTextSearch(db, [teamId], 'logins', { scope: 'tasks' });
		expect(results.some((r) => r.title.includes('Fix login bug'))).toBe(true);
	});

	it('matches a prefix as you type (log → login)', async () => {
		const results = await fullTextSearch(db, [teamId], 'log', { scope: 'tasks' });
		expect(results.some((r) => r.title.includes('Fix login bug'))).toBe(true);
	});

	it('ranks a title match above a body-only match', async () => {
		const results = await fullTextSearch(db, [teamId], 'login', { scope: 'tasks' });
		// "Fix login bug" (title, weight A) must outrank "Deploy pipeline" (body, weight B).
		expect(results[0].title).toContain('Fix login bug');
		expect(results.some((r) => r.title.includes('Deploy pipeline'))).toBe(true);
	});

	it('finds an active skill and excludes inactive ones', async () => {
		const results = await fullTextSearch(db, [teamId], 'deploy', { scope: 'skills' });
		const names = results.map((r) => r.title);
		expect(names).toContain('Deploy Skill');
		expect(names).not.toContain('Retired Skill');
	});

	it('finds a project doc by its body', async () => {
		const results = await fullTextSearch(db, [teamId], 'checkout', { scope: 'project_docs' });
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results[0].type).toBe('project_doc');
		expect(results[0].docSlug).toBe('spec.md');
	});

	it('finds a text comment joined to its task + project, excluding system comments', async () => {
		const results = await fullTextSearch(db, [teamId], 'stripe', { scope: 'comments' });
		expect(results.length).toBe(1);
		expect(results[0].type).toBe('comment');
		expect(results[0].projectSlug).toBe('search-project');
		expect(results[0].snippet).toContain(`${HIGHLIGHT_SENTINEL}Stripe${HIGHLIGHT_SENTINEL}`);
	});

	it('scopes team-owned content to the given teams', async () => {
		const other = await db.query<{ id: string }>(
			"INSERT INTO teams (name, slug) VALUES ('Other Co', 'other-co') RETURNING id",
		);
		// No tasks/docs/comments for the other team, and "login" matches no skill.
		const results = await fullTextSearch(db, [other.rows[0].id], 'login');
		expect(results).toEqual([]);
	});

	it('returns skills regardless of team (instance-global)', async () => {
		const other = await db.query<{ id: string }>(
			"INSERT INTO teams (name, slug) VALUES ('Skill Other Co', 'skill-other-co') RETURNING id",
		);
		const results = await fullTextSearch(db, [other.rows[0].id], 'deploy', { scope: 'skills' });
		expect(results.map((r) => r.title)).toContain('Deploy Skill');
	});

	it("scope 'all' merges types sorted by descending score", async () => {
		const results = await fullTextSearch(db, [teamId], 'deploy');
		const types = new Set(results.map((r) => r.type));
		expect(types.has('skill')).toBe(true); // "Deploy Skill"
		expect(types.has('task')).toBe(true); // "Deploy pipeline"
		for (let i = 1; i < results.length; i++) {
			expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
		}
	});
});
