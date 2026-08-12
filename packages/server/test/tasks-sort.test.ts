import { TaskPriority, TaskStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { buildSearchRelevanceOrderSql } from '../src/lib/task-sort';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'Task Sort Co' });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Sort Project',
		description: 'Test project.',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Worker' }),
	});
	agentId = (await agentRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function insertTask(
	title: string,
	opts: { priority?: string; status?: string } = {},
): Promise<{ id: string; identifier: string; number: number }> {
	const meta = await db.query<{ task_prefix: string; number: number }>(
		`SELECT p.task_prefix, next_project_task_number(p.id) AS number
		 FROM projects p WHERE p.id = $1`,
		[projectId],
	);
	const n = meta.rows[0].number;
	const priority = opts.priority ?? TaskPriority.Medium;
	const status = opts.status ?? TaskStatus.Backlog;
	const res = await db.query<{ id: string; identifier: string; number: number }>(
		`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::task_status, $8::task_priority, '[]'::jsonb)
		 RETURNING id, identifier, number`,
		[teamId, projectId, agentId, n, `${meta.rows[0].task_prefix}-${n}`, title, status, priority],
	);
	return res.rows[0];
}

interface ListedTask {
	id: string;
	title: string;
	has_active_run: boolean;
	admin_action_pending: boolean;
}

async function listRows(sort?: string): Promise<ListedTask[]> {
	const qs = sort ? `?sort=${encodeURIComponent(sort)}&per_page=100` : '?per_page=100';
	const res = await app.request(`/api/projects/${projectSlug}/tasks${qs}`, {
		headers: authHeader(token),
	});
	expect(res.status).toBe(200);
	return (await res.json()).data as ListedTask[];
}

async function listIds(sort?: string): Promise<string[]> {
	return (await listRows(sort)).map((r) => r.id);
}

describe('GET /projects/:projectId/tasks sort=work_order', () => {
	it('defaults to work order when sort is omitted', async () => {
		const first = await insertTask('First task');
		const second = await insertTask('Second task');
		const ids = await listIds();
		const firstIdx = ids.indexOf(first.id);
		const secondIdx = ids.indexOf(second.id);
		expect(firstIdx).toBeGreaterThanOrEqual(0);
		expect(secondIdx).toBeGreaterThan(firstIdx);
	});

	it('lists ready tasks before dependency-gated tasks', async () => {
		const blocker = await insertTask('Blocker');
		const gated = await insertTask('Gated');
		await db.query(`INSERT INTO task_dependencies (task_id, blocked_by_task_id) VALUES ($1, $2)`, [
			gated.id,
			blocker.id,
		]);

		const ids = await listIds('work_order:asc');
		expect(ids.indexOf(blocker.id)).toBeLessThan(ids.indexOf(gated.id));
	});

	it('ranks urgent ahead of medium among ready tasks', async () => {
		const medium = await insertTask('Medium task', { priority: TaskPriority.Medium });
		const urgent = await insertTask('Urgent task', { priority: TaskPriority.Urgent });

		const ids = await listIds('work_order:asc');
		expect(ids.indexOf(urgent.id)).toBeLessThan(ids.indexOf(medium.id));
	});
});

/**
 * The three ordering tiers, seeded oldest-first so the *idle* task is always the
 * most recently created and updated - under any recency sort it would lead if the
 * tiers were not applied.
 */
async function seedTieredTrio(idlePriority: string = TaskPriority.Medium): Promise<{
	running: string;
	pending: string;
	idle: string;
}> {
	const running = await insertTask('Tier: agent running', { priority: TaskPriority.Low });
	await db.query(
		`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status)
		 VALUES ($1, $2, $3, 'running')`,
		[teamId, agentId, running.id],
	);
	await new Promise((r) => setTimeout(r, 10));

	const pending = await insertTask('Tier: waiting on admin', { priority: TaskPriority.Low });
	await insertUnansweredAsk(pending.id);
	await new Promise((r) => setTimeout(r, 10));

	const idle = await insertTask('Tier: idle', { priority: idlePriority });
	return { running: running.id, pending: pending.id, idle: idle.id };
}

/** An ask comment nobody has answered yet - `chosen_option IS NULL`. */
async function insertUnansweredAsk(
	taskId: string,
	contentType = 'credential_request',
): Promise<string> {
	const res = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb) RETURNING id`,
		[taskId, agentId, contentType, JSON.stringify({ name: 'SOME_KEY', kind: 'api_key' })],
	);
	return res.rows[0].id;
}

/** An unread inbox row for the admin whose JWT the list requests carry. */
async function insertAdminMention(taskId: string): Promise<void> {
	const comment = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb) RETURNING id`,
		[taskId, agentId, JSON.stringify({ text: '@admin your call please' })],
	);
	const admin = await db.query<{ id: string }>(
		'SELECT id FROM users WHERE is_superuser = true LIMIT 1',
	);
	await db.query(
		`INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id)
		 VALUES ($1, $2, $3, $4)`,
		[teamId, taskId, comment.rows[0].id, admin.rows[0].id],
	);
}

/** Reset every tier signal so one case cannot tier another case's tasks. */
async function clearTierSignals(): Promise<void> {
	await db.query('DELETE FROM heartbeat_runs');
	await db.query('DELETE FROM admin_mentions');
	await db.query(
		`DELETE FROM task_comments
		  WHERE content_type IN ('credential_request'::comment_content_type, 'action'::comment_content_type)`,
	);
}

describe('GET /projects/:projectId/tasks ordering tiers', () => {
	afterEach(clearTierSignals);

	it('orders running, then waiting-on-admin, then the rest under work_order', async () => {
		// The idle task is urgent and newest, so every work_order key below the tiers
		// (ready → priority → number) would put it first.
		const { running, pending, idle } = await seedTieredTrio(TaskPriority.Urgent);

		const ids = await listIds('work_order:asc');
		expect(ids.indexOf(running)).toBeLessThan(ids.indexOf(pending));
		expect(ids.indexOf(pending)).toBeLessThan(ids.indexOf(idle));
	});

	it('applies the same tiers under a recency sort', async () => {
		const { running, pending, idle } = await seedTieredTrio();

		const ids = await listIds('updated_at:desc');
		expect(ids.indexOf(running)).toBeLessThan(ids.indexOf(pending));
		expect(ids.indexOf(pending)).toBeLessThan(ids.indexOf(idle));
	});

	it('lifts a task on an unanswered ask alone, and drops it once answered', async () => {
		const asked = await insertTask('Ask: unanswered hire card', { priority: TaskPriority.Low });
		const commentId = await insertUnansweredAsk(asked.id, 'action');
		await new Promise((r) => setTimeout(r, 10));
		const idle = await insertTask('Ask: idle neighbour', { priority: TaskPriority.Urgent });

		const before = await listRows('updated_at:desc');
		expect(before.find((r) => r.id === asked.id)?.admin_action_pending).toBe(true);
		expect(before.findIndex((r) => r.id === asked.id)).toBeLessThan(
			before.findIndex((r) => r.id === idle.id),
		);

		// Answering the card resolves the ask; the task falls back into the last tier
		// and the newer idle task reclaims the top under updated_at:desc.
		await db.query(`UPDATE task_comments SET chosen_option = $1::jsonb WHERE id = $2`, [
			JSON.stringify({ status: 'approved' }),
			commentId,
		]);

		const after = await listRows('updated_at:desc');
		expect(after.find((r) => r.id === asked.id)?.admin_action_pending).toBe(false);
		expect(after.findIndex((r) => r.id === idle.id)).toBeLessThan(
			after.findIndex((r) => r.id === asked.id),
		);
	});

	it('lifts a task on an unread admin mention alone', async () => {
		const mentioned = await insertTask('Mention: needs the admin', { priority: TaskPriority.Low });
		await insertAdminMention(mentioned.id);
		await new Promise((r) => setTimeout(r, 10));
		const idle = await insertTask('Mention: idle neighbour', { priority: TaskPriority.Urgent });

		const rows = await listRows('updated_at:desc');
		expect(rows.find((r) => r.id === mentioned.id)?.admin_action_pending).toBe(true);
		expect(rows.find((r) => r.id === idle.id)?.admin_action_pending).toBe(false);
		expect(rows.findIndex((r) => r.id === mentioned.id)).toBeLessThan(
			rows.findIndex((r) => r.id === idle.id),
		);
	});

	it('keeps a running task above a waiting-on-admin task that also has a run queued', async () => {
		// has_active_run covers queued runs too, so a task with both signals belongs in
		// the first tier - the second must not pull it down.
		const both = await insertTask('Both signals', { priority: TaskPriority.Low });
		await insertUnansweredAsk(both.id);
		await db.query(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status)
			 VALUES ($1, $2, $3, 'queued')`,
			[teamId, agentId, both.id],
		);
		await new Promise((r) => setTimeout(r, 10));
		const pendingOnly = await insertTask('Ask only', { priority: TaskPriority.Urgent });
		await insertUnansweredAsk(pendingOnly.id);

		const rows = await listRows('updated_at:desc');
		expect(rows.find((r) => r.id === both.id)?.has_active_run).toBe(true);
		expect(rows.findIndex((r) => r.id === both.id)).toBeLessThan(
			rows.findIndex((r) => r.id === pendingOnly.id),
		);
	});
});

async function searchIds(term: string, sort?: string): Promise<string[]> {
	const qs = new URLSearchParams({ search: term, per_page: '50' });
	if (sort) qs.set('sort', sort);
	const res = await app.request(`/api/projects/${projectSlug}/tasks?${qs.toString()}`, {
		headers: authHeader(token),
	});
	expect(res.status).toBe(200);
	const rows = (await res.json()).data as Array<{ id: string }>;
	return rows.map((r) => r.id);
}

describe('GET /projects/:projectId/tasks search relevance', () => {
	it('ranks an exact task-number match ahead of a more-recent title-only match', async () => {
		// `target` owns the number; `decoy` only mentions it in its title and is
		// created afterwards, so under the default updated_at ordering it would
		// otherwise come first. The number match must win regardless of the sort.
		const target = await insertTask('Draft community platform posts');
		const decoy = await insertTask(`References ${target.number} in the title`);

		const ids = await searchIds(String(target.number), 'updated_at:desc');
		expect(ids[0]).toBe(target.id);
		expect(ids.indexOf(target.id)).toBeLessThan(ids.indexOf(decoy.id));
	});

	it('ranks a whole-identifier match first even when the body of another task cites it', async () => {
		const target = await insertTask('Ship the release notes');
		const decoy = await insertTask(`Blocked on ${target.identifier}, see thread`);

		// Searching the full identifier (e.g. "SORT-42") — the exact-identifier tier
		// must outrank the task whose title merely references it.
		const ids = await searchIds(target.identifier, 'updated_at:desc');
		expect(ids[0]).toBe(target.id);
		expect(ids.indexOf(target.id)).toBeLessThan(ids.indexOf(decoy.id));
	});
});

describe('buildSearchRelevanceOrderSql', () => {
	it('pushes the raw term and its ILIKE pattern, and tiers identifier > title > body', () => {
		const params: unknown[] = ['existing'];
		const { sql, nextIdx } = buildSearchRelevanceOrderSql('169', params, 2);

		expect(params).toEqual(['existing', '169', '%169%']);
		expect(nextIdx).toBe(4);
		// Whole-identifier (0) beats number (1) beats identifier-substring (2) beats
		// title (3) beats description-only (4); exact tiers read the raw term ($2),
		// the substring tiers read the ILIKE pattern ($3).
		expect(sql).toContain('LOWER(i.identifier) = LOWER($2) THEN 0');
		expect(sql).toContain('i.number::text = $2 THEN 1');
		expect(sql).toContain('i.identifier ILIKE $3 THEN 2');
		expect(sql).toContain('i.title ILIKE $3 THEN 3');
		expect(sql).toContain('ELSE 4');
	});
});
