import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let otherProjectId: string;
let otherProjectSlug: string;
let memberId: string;

// Task IDs created in setup so individual tests can reference them
let taskBacklogLow: string;
let taskBacklogHigh: string;
let taskReviewMedium: string;
let taskInProgressUrgent: string;
let taskDoneHigh: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const makeTeam = async (name: string) => {
		const r = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name }),
		});
		return (await r.json()).data.id as string;
	};

	// Create team
	teamId = await makeTeam('Filter Test Co');

	// Create primary project
	const projectRes = await createTestProject(db, teamId, {
		name: 'Alpha Project',
		description: 'Test project.',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	// Under the 1:1 teams↔projects model a distinct second project needs its own
	// team. The project_id-filter assertions are now cross-team by construction.
	const otherTeamId = await makeTeam('Filter Test Co (Beta)');
	const otherProjectRes = await createTestProject(db, otherTeamId, {
		name: 'Beta Project',
		description: 'Test project.',
	});
	const otherProjectData = (await otherProjectRes.json()).data;
	otherProjectId = otherProjectData.id;
	otherProjectSlug = otherProjectData.slug;

	// Create a member to use as assignee
	const memberRes = await db.query<{ id: string }>(
		`INSERT INTO members (team_id, display_name, member_type)
         VALUES ($1, 'Dev One', 'agent') RETURNING id`,
		[teamId],
	);
	memberId = memberRes.rows[0].id;

	// Helper to create an task
	const createTask = async (
		title: string,
		priority: string,
		status: string,
		proj: string,
		description = '',
		assigneeId: string | null = memberId,
	) => {
		// Route creation through the slug of the project the task belongs to so the
		// task's team_id matches that project's team (each project is its own team now).
		const projSlug = proj === projectId ? projectSlug : otherProjectSlug;
		const createRes = await app.request(`/api/projects/${projSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: proj,
				title,
				description,
				priority,
				assignee_id: assigneeId ?? undefined,
			}),
		});
		const created = (await createRes.json()).data;
		// If status needs to differ from default backlog, patch it
		if (status !== 'backlog') {
			await app.request(`/api/projects/${projSlug}/tasks/${created.id}`, {
				method: 'PATCH',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ status }),
			});
		}
		return created.id as string;
	};

	// Create 5 tasks with varied statuses, priorities, projects, and titles
	taskBacklogLow = await createTask(
		'Fix login bug',
		'low',
		'backlog',
		projectId,
		'Login page crashes on submit',
	);
	taskBacklogHigh = await createTask(
		'Refactor auth module',
		'high',
		'backlog',
		projectId,
		'Authentication needs cleanup',
	);
	taskReviewMedium = await createTask(
		'Add dark mode support',
		'medium',
		'review',
		otherProjectId,
		'Users requested dark theme',
	);
	taskInProgressUrgent = await createTask(
		'Critical database failure',
		'urgent',
		'in_progress',
		otherProjectId,
		'Database connection dropping',
		memberId,
	);
	taskDoneHigh = await createTask(
		'Deploy CI pipeline',
		'high',
		'done',
		projectId,
		'Automated deployments',
	);
});

afterAll(async () => {
	await safeClose(db);
});

// Task listing is project-scoped (one project per request). The team-wide view
// is reconstructed by listing every project of the team and merging the rows
// and totals — preserving the cross-project assertions the team-level list used
// to satisfy in a single call.
async function listTeamTasks(query = ''): Promise<{ data: any[]; meta: { total: number } }> {
	const slugs = [projectSlug, otherProjectSlug];
	const merged: any[] = [];
	let total = 0;
	for (const slug of slugs) {
		const sep = query ? `?${query}` : '';
		const res = await app.request(`/api/projects/${slug}/tasks${sep}`, {
			headers: authHeader(token),
		});
		const body = await res.json();
		merged.push(...body.data);
		total += body.meta.total;
	}
	return { data: merged, meta: { total } };
}

describe('tasks list — pagination', () => {
	it('returns first page with per_page limit', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks?per_page=2&page=1`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toHaveLength(2);
		expect(body.meta.page).toBe(1);
		expect(body.meta.per_page).toBe(2);
		expect(body.meta.total).toBeGreaterThanOrEqual(3);
	});

	it('returns second page correctly', async () => {
		const page1Res = await app.request(`/api/projects/${projectSlug}/tasks?per_page=2&page=1`, {
			headers: authHeader(token),
		});
		const page2Res = await app.request(`/api/projects/${projectSlug}/tasks?per_page=2&page=2`, {
			headers: authHeader(token),
		});
		expect(page1Res.status).toBe(200);
		expect(page2Res.status).toBe(200);
		const p1 = await page1Res.json();
		const p2 = await page2Res.json();
		// Pages must be disjoint — no shared IDs
		const p1ids = new Set(p1.data.map((i: any) => i.id));
		for (const task of p2.data) {
			expect(p1ids.has(task.id)).toBe(false);
		}
	});

	it('returns empty data on out-of-range page', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks?per_page=50&page=999`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toHaveLength(0);
		expect(body.meta.total).toBeGreaterThanOrEqual(3);
	});

	it('meta reflects correct total even when page is limited', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks?per_page=1`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toHaveLength(1);
		expect(body.meta.total).toBeGreaterThanOrEqual(3);
		expect(body.meta.per_page).toBe(1);
	});
});

describe('tasks list — search filter', () => {
	it('returns tasks whose title matches the search term', async () => {
		const body = await listTeamTasks('search=login');
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data.some((i: any) => i.id === taskBacklogLow)).toBe(true);
		// Should not include unrelated tasks
		expect(
			body.data.every((i: any) => {
				const title: string = i.title.toLowerCase();
				return title.includes('login');
			}),
		).toBe(true);
	});

	it('search is case-insensitive', async () => {
		const body = await listTeamTasks('search=REFACTOR');
		expect(body.data.some((i: any) => i.id === taskBacklogHigh)).toBe(true);
	});

	it('returns empty when search matches nothing', async () => {
		const body = await listTeamTasks('search=zzz_no_match_zzz');
		expect(body.data).toHaveLength(0);
		expect(body.meta.total).toBe(0);
	});
});

describe('tasks list — status filter', () => {
	it('filters to a single status', async () => {
		const body = await listTeamTasks('status=in_progress');
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data.every((i: any) => i.status === 'in_progress')).toBe(true);
		expect(body.data.some((i: any) => i.id === taskInProgressUrgent)).toBe(true);
	});

	it('filters using comma-separated multiple statuses', async () => {
		const body = await listTeamTasks('status=review,in_progress');
		expect(body.data.length).toBeGreaterThanOrEqual(2);
		expect(body.data.every((i: any) => ['review', 'in_progress'].includes(i.status))).toBe(true);
		expect(body.data.some((i: any) => i.id === taskReviewMedium)).toBe(true);
		expect(body.data.some((i: any) => i.id === taskInProgressUrgent)).toBe(true);
	});

	it('excludes tasks not matching the status filter', async () => {
		const body = await listTeamTasks('status=done');
		expect(body.data.some((i: any) => i.status !== 'done')).toBe(false);
		expect(body.data.some((i: any) => i.id === taskDoneHigh)).toBe(true);
	});
});

describe('tasks list — priority filter', () => {
	it('filters to a single priority', async () => {
		const body = await listTeamTasks('priority=urgent');
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data.every((i: any) => i.priority === 'urgent')).toBe(true);
		expect(body.data.some((i: any) => i.id === taskInProgressUrgent)).toBe(true);
	});

	it('filters using comma-separated multiple priorities', async () => {
		const body = await listTeamTasks('priority=high,urgent');
		expect(body.data.length).toBeGreaterThanOrEqual(2);
		expect(body.data.every((i: any) => ['high', 'urgent'].includes(i.priority))).toBe(true);
		expect(body.data.some((i: any) => i.id === taskBacklogHigh)).toBe(true);
		expect(body.data.some((i: any) => i.id === taskInProgressUrgent)).toBe(true);
	});

	it('excludes tasks not matching the priority filter', async () => {
		const body = await listTeamTasks('priority=low');
		expect(body.data.every((i: any) => i.priority === 'low')).toBe(true);
		expect(body.data.some((i: any) => i.id === taskBacklogLow)).toBe(true);
	});
});

describe('tasks list — project_id filter', () => {
	it('returns only tasks belonging to the specified project', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks?per_page=50`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data.every((i: any) => i.project_id === projectId)).toBe(true);
		// Tasks from otherProjectId must not appear
		expect(body.data.some((i: any) => i.id === taskReviewMedium)).toBe(false);
		expect(body.data.some((i: any) => i.id === taskInProgressUrgent)).toBe(false);
	});

	it('returns only tasks belonging to the other project', async () => {
		const res = await app.request(`/api/projects/${otherProjectSlug}/tasks?per_page=50`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(2);
		expect(body.data.every((i: any) => i.project_id === otherProjectId)).toBe(true);
		expect(body.data.some((i: any) => i.id === taskReviewMedium)).toBe(true);
		expect(body.data.some((i: any) => i.id === taskInProgressUrgent)).toBe(true);
	});

	it('returns 404 for a non-existent project', async () => {
		const res = await app.request(`/api/projects/00000000-0000-0000-0000-000000000000/tasks`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});
});

describe('tasks list — assignee_id filter', () => {
	it('returns only tasks assigned to the specified member', async () => {
		const body = await listTeamTasks(`assignee_id=${memberId}`);
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data.every((i: any) => i.assignee_id === memberId)).toBe(true);
		expect(body.data.some((i: any) => i.id === taskInProgressUrgent)).toBe(true);
	});

	it('returns empty list when assignee has no tasks', async () => {
		const otherMember = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, display_name, member_type)
             VALUES ($1, 'No Tasks Member', 'agent') RETURNING id`,
			[teamId],
		);
		const body = await listTeamTasks(`assignee_id=${otherMember.rows[0].id}`);
		expect(body.data).toHaveLength(0);
	});
});

describe('tasks list — sort parameter', () => {
	it('sorts by created_at ascending', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks?sort=created_at:asc`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		const dates = body.data.map((i: any) => new Date(i.created_at).getTime());
		for (let i = 1; i < dates.length; i++) {
			expect(dates[i]).toBeGreaterThanOrEqual(dates[i - 1]);
		}
	});

	it('sorts by created_at descending (default)', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks?sort=created_at:desc`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		const dates = body.data.map((i: any) => new Date(i.created_at).getTime());
		for (let i = 1; i < dates.length; i++) {
			expect(dates[i]).toBeLessThanOrEqual(dates[i - 1]);
		}
	});

	it('sorts by number ascending', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks?sort=number:asc`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		const numbers = body.data.map((i: any) => i.number);
		for (let n = 1; n < numbers.length; n++) {
			expect(numbers[n]).toBeGreaterThanOrEqual(numbers[n - 1]);
		}
	});

	it('falls back to created_at desc for an unknown sort field', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks?sort=invalid_field:asc`, {
			headers: authHeader(token),
		});
		// Should not error — falls back to created_at desc
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body.data)).toBe(true);
	});
});

describe('tasks list — combined filters', () => {
	it('combines status and priority filters', async () => {
		const body = await listTeamTasks('status=backlog&priority=high');
		expect(body.data.every((i: any) => i.status === 'backlog' && i.priority === 'high')).toBe(true);
		expect(body.data.some((i: any) => i.id === taskBacklogHigh)).toBe(true);
		// taskBacklogLow has low priority — must be excluded
		expect(body.data.some((i: any) => i.id === taskBacklogLow)).toBe(false);
	});

	it('combines project scope and status filter', async () => {
		const res = await app.request(`/api/projects/${otherProjectSlug}/tasks?status=in_progress`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(
			body.data.every((i: any) => i.project_id === otherProjectId && i.status === 'in_progress'),
		).toBe(true);
		expect(body.data.some((i: any) => i.id === taskInProgressUrgent)).toBe(true);
	});

	it('combines search with status filter', async () => {
		const body = await listTeamTasks('search=auth&status=backlog');
		expect(body.data.every((i: any) => i.status === 'backlog')).toBe(true);
		expect(body.data.some((i: any) => i.id === taskBacklogHigh)).toBe(true);
	});

	it('combines assignee_id and priority filters', async () => {
		const body = await listTeamTasks(`assignee_id=${memberId}&priority=urgent`);
		expect(body.data.every((i: any) => i.assignee_id === memberId && i.priority === 'urgent')).toBe(
			true,
		);
		expect(body.data.some((i: any) => i.id === taskInProgressUrgent)).toBe(true);
	});
});

describe('tasks list — assignee_type and has_active_run', () => {
	const findTask = (data: any[], id: string) => data.find((i: any) => i.id === id);

	it('returns assignee_type="agent" for an agent member assignee', async () => {
		const body = await listTeamTasks('per_page=50');
		const task = findTask(body.data, taskInProgressUrgent);
		expect(task.assignee_type).toBe('agent');
	});

	it('returns has_active_run=false when no heartbeat_runs row exists', async () => {
		const body = await listTeamTasks('per_page=50');
		const task = findTask(body.data, taskInProgressUrgent);
		expect(task.has_active_run).toBe(false);
	});

	it('returns has_active_run=true when a running heartbeat_runs row exists', async () => {
		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
			 VALUES ($1, $2, $3, 'running', now()) RETURNING id`,
			[memberId, teamId, taskInProgressUrgent],
		);
		try {
			const body = await listTeamTasks('per_page=50');
			const task = findTask(body.data, taskInProgressUrgent);
			expect(task.has_active_run).toBe(true);
		} finally {
			await db.query(`DELETE FROM heartbeat_runs WHERE id = $1`, [run.rows[0].id]);
		}
	});

	it('returns has_active_run=true for a queued run', async () => {
		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
			 VALUES ($1, $2, $3, 'queued', now()) RETURNING id`,
			[memberId, teamId, taskInProgressUrgent],
		);
		try {
			const body = await listTeamTasks('per_page=50');
			const task = findTask(body.data, taskInProgressUrgent);
			expect(task.has_active_run).toBe(true);
		} finally {
			await db.query(`DELETE FROM heartbeat_runs WHERE id = $1`, [run.rows[0].id]);
		}
	});

	it('returns has_active_run=false once the run transitions to a terminal status', async () => {
		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, finished_at)
			 VALUES ($1, $2, $3, 'succeeded', now(), now()) RETURNING id`,
			[memberId, teamId, taskInProgressUrgent],
		);
		try {
			const body = await listTeamTasks('per_page=50');
			const task = findTask(body.data, taskInProgressUrgent);
			expect(task.has_active_run).toBe(false);
		} finally {
			await db.query(`DELETE FROM heartbeat_runs WHERE id = $1`, [run.rows[0].id]);
		}
	});

	it('single-task GET returns assignee_type', async () => {
		const res = await app.request(
			`/api/projects/${otherProjectSlug}/tasks/${taskInProgressUrgent}`,
			{
				headers: authHeader(token),
			},
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.assignee_type).toBe('agent');
	});
});

describe('tasks list — has_unread_admin_mention', () => {
	const findTask = (data: any[], id: string) => data.find((i: any) => i.id === id);

	async function adminUserId(): Promise<string> {
		const row = await db.query<{ user_id: string }>(
			`SELECT mu.user_id FROM member_users mu
			 JOIN members m ON m.id = mu.id
			 WHERE m.team_id = $1 AND mu.role = 'admin' LIMIT 1`,
			[teamId],
		);
		const id = row.rows[0]?.user_id;
		if (!id) throw new Error('no admin user on team');
		return id;
	}

	async function seedMention(taskId: string): Promise<{ commentId: string; mentionId: string }> {
		const userId = await adminUserId();
		const comment = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb) RETURNING id`,
			[taskId, memberId, JSON.stringify({ text: '@admin your call?' })],
		);
		const mention = await db.query<{ id: string }>(
			`INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id)
			 VALUES ($1, $2, $3, $4) RETURNING id`,
			[teamId, taskId, comment.rows[0].id, userId],
		);
		return { commentId: comment.rows[0].id, mentionId: mention.rows[0].id };
	}

	it('flags only the task with an unread admin mention, and clears once read', async () => {
		const { commentId, mentionId } = await seedMention(taskBacklogHigh);
		try {
			let body = await listTeamTasks('per_page=50');
			expect(findTask(body.data, taskBacklogHigh).has_unread_admin_mention).toBe(true);
			// A task without a mention stays false.
			expect(findTask(body.data, taskInProgressUrgent).has_unread_admin_mention).toBe(false);

			// Reading the mention clears the per-task flag.
			await db.query(`UPDATE admin_mentions SET read_at = now() WHERE id = $1`, [mentionId]);
			body = await listTeamTasks('per_page=50');
			expect(findTask(body.data, taskBacklogHigh).has_unread_admin_mention).toBe(false);
		} finally {
			await db.query(`DELETE FROM admin_mentions WHERE id = $1`, [mentionId]);
			await db.query(`DELETE FROM task_comments WHERE id = $1`, [commentId]);
		}
	});

	it('does not flag an archived mention', async () => {
		const { commentId, mentionId } = await seedMention(taskBacklogHigh);
		try {
			await db.query(
				`UPDATE admin_mentions SET read_at = now(), archived_at = now() WHERE id = $1`,
				[mentionId],
			);
			const body = await listTeamTasks('per_page=50');
			expect(findTask(body.data, taskBacklogHigh).has_unread_admin_mention).toBe(false);
		} finally {
			await db.query(`DELETE FROM admin_mentions WHERE id = $1`, [mentionId]);
			await db.query(`DELETE FROM task_comments WHERE id = $1`, [commentId]);
		}
	});
});

describe('tasks PATCH — block assignee change while agent is running', () => {
	let otherMemberId: string;

	beforeAll(async () => {
		const res = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, display_name, member_type)
             VALUES ($1, 'Dev Two', 'agent') RETURNING id`,
			[teamId],
		);
		otherMemberId = res.rows[0].id;
	});

	const insertRun = async (status: 'running' | 'queued' | 'succeeded') => {
		const finished = status === 'succeeded' ? ', now()' : '';
		const finishedCol = status === 'succeeded' ? ', finished_at' : '';
		const r = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at${finishedCol})
             VALUES ($1, $2, $3, $4, now()${finished}) RETURNING id`,
			[memberId, teamId, taskInProgressUrgent, status],
		);
		return r.rows[0].id;
	};

	const deleteRun = async (id: string) => {
		await db.query(`DELETE FROM heartbeat_runs WHERE id = $1`, [id]);
	};

	const getAssignee = async () => {
		const r = await db.query<{ assignee_id: string }>(
			'SELECT assignee_id FROM tasks WHERE id = $1',
			[taskInProgressUrgent],
		);
		return r.rows[0].assignee_id;
	};

	it('returns 409 when changing assignee while a running run exists', async () => {
		const runId = await insertRun('running');
		try {
			const before = await getAssignee();
			const res = await app.request(
				`/api/projects/${otherProjectSlug}/tasks/${taskInProgressUrgent}`,
				{
					method: 'PATCH',
					headers: { ...authHeader(token), 'Content-Type': 'application/json' },
					body: JSON.stringify({ assignee_id: otherMemberId }),
				},
			);
			expect(res.status).toBe(409);
			const body = await res.json();
			expect(body.error.code).toBe('CONFLICT');
			expect(await getAssignee()).toBe(before);
		} finally {
			await deleteRun(runId);
		}
	});

	it('returns 409 when changing assignee while a queued run exists', async () => {
		const runId = await insertRun('queued');
		try {
			const res = await app.request(
				`/api/projects/${otherProjectSlug}/tasks/${taskInProgressUrgent}`,
				{
					method: 'PATCH',
					headers: { ...authHeader(token), 'Content-Type': 'application/json' },
					body: JSON.stringify({ assignee_id: otherMemberId }),
				},
			);
			expect(res.status).toBe(409);
		} finally {
			await deleteRun(runId);
		}
	});

	it('allows assignee change after the run reaches a terminal status', async () => {
		const runId = await insertRun('succeeded');
		try {
			const res = await app.request(
				`/api/projects/${otherProjectSlug}/tasks/${taskInProgressUrgent}`,
				{
					method: 'PATCH',
					headers: { ...authHeader(token), 'Content-Type': 'application/json' },
					body: JSON.stringify({ assignee_id: otherMemberId }),
				},
			);
			expect(res.status).toBe(200);
			expect(await getAssignee()).toBe(otherMemberId);
		} finally {
			await deleteRun(runId);
			await db.query(`UPDATE tasks SET assignee_id = $1 WHERE id = $2`, [
				memberId,
				taskInProgressUrgent,
			]);
		}
	});

	it('allows a no-op assignee PATCH (same value) while a run is active', async () => {
		const runId = await insertRun('running');
		try {
			const current = await getAssignee();
			const res = await app.request(
				`/api/projects/${otherProjectSlug}/tasks/${taskInProgressUrgent}`,
				{
					method: 'PATCH',
					headers: { ...authHeader(token), 'Content-Type': 'application/json' },
					body: JSON.stringify({ assignee_id: current }),
				},
			);
			expect(res.status).toBe(200);
			expect(await getAssignee()).toBe(current);
		} finally {
			await deleteRun(runId);
		}
	});

	it('allows patching non-assignee fields while a run is active', async () => {
		const runId = await insertRun('running');
		try {
			const res = await app.request(
				`/api/projects/${otherProjectSlug}/tasks/${taskInProgressUrgent}`,
				{
					method: 'PATCH',
					headers: { ...authHeader(token), 'Content-Type': 'application/json' },
					body: JSON.stringify({ priority: 'high' }),
				},
			);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.data.priority).toBe('high');
		} finally {
			await deleteRun(runId);
			await db.query(`UPDATE tasks SET priority = 'urgent' WHERE id = $1`, [taskInProgressUrgent]);
		}
	});
});
