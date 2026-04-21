import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let companyId: string;
let projectId: string;
let otherProjectId: string;
let memberId: string;

// Issue IDs created in setup so individual tests can reference them
let issueBacklogLow: string;
let issueBacklogHigh: string;
let issueOpenMedium: string;
let issueInProgressUrgent: string;
let issueDoneHigh: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	// Create company
	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Filter Test Co', issue_prefix: 'FTC' }),
	});
	companyId = (await companyRes.json()).data.id;

	// Create primary project
	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Alpha Project', description: 'Test project.' }),
	});
	projectId = (await projectRes.json()).data.id;

	// Create a second project for project_id filter tests
	const otherProjectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Beta Project', description: 'Test project.' }),
	});
	otherProjectId = (await otherProjectRes.json()).data.id;

	// Create a member to use as assignee
	const memberRes = await db.query<{ id: string }>(
		`INSERT INTO members (company_id, display_name, member_type)
         VALUES ($1, 'Dev One', 'agent') RETURNING id`,
		[companyId],
	);
	memberId = memberRes.rows[0].id;

	// Helper to create an issue
	const createIssue = async (
		title: string,
		priority: string,
		status: string,
		proj: string,
		description = '',
		assigneeId: string | null = memberId,
	) => {
		const createRes = await app.request(`/api/companies/${companyId}/issues`, {
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
			await app.request(`/api/companies/${companyId}/issues/${created.id}`, {
				method: 'PATCH',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ status }),
			});
		}
		return created.id as string;
	};

	// Create 5 issues with varied statuses, priorities, projects, and titles
	issueBacklogLow = await createIssue(
		'Fix login bug',
		'low',
		'backlog',
		projectId,
		'Login page crashes on submit',
	);
	issueBacklogHigh = await createIssue(
		'Refactor auth module',
		'high',
		'backlog',
		projectId,
		'Authentication needs cleanup',
	);
	issueOpenMedium = await createIssue(
		'Add dark mode support',
		'medium',
		'open',
		otherProjectId,
		'Users requested dark theme',
	);
	issueInProgressUrgent = await createIssue(
		'Critical database failure',
		'urgent',
		'in_progress',
		otherProjectId,
		'Database connection dropping',
		memberId,
	);
	issueDoneHigh = await createIssue(
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

describe('issues list — pagination', () => {
	it('returns first page with per_page limit', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues?per_page=2&page=1`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toHaveLength(2);
		expect(body.meta.page).toBe(1);
		expect(body.meta.per_page).toBe(2);
		expect(body.meta.total).toBeGreaterThanOrEqual(5);
	});

	it('returns second page correctly', async () => {
		const page1Res = await app.request(`/api/companies/${companyId}/issues?per_page=2&page=1`, {
			headers: authHeader(token),
		});
		const page2Res = await app.request(`/api/companies/${companyId}/issues?per_page=2&page=2`, {
			headers: authHeader(token),
		});
		expect(page1Res.status).toBe(200);
		expect(page2Res.status).toBe(200);
		const p1 = await page1Res.json();
		const p2 = await page2Res.json();
		// Pages must be disjoint — no shared IDs
		const p1ids = new Set(p1.data.map((i: any) => i.id));
		for (const issue of p2.data) {
			expect(p1ids.has(issue.id)).toBe(false);
		}
	});

	it('returns empty data on out-of-range page', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues?per_page=50&page=999`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toHaveLength(0);
		expect(body.meta.total).toBeGreaterThanOrEqual(5);
	});

	it('meta reflects correct total even when page is limited', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues?per_page=1`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toHaveLength(1);
		expect(body.meta.total).toBeGreaterThanOrEqual(5);
		expect(body.meta.per_page).toBe(1);
	});
});

describe('issues list — search filter', () => {
	it('returns issues whose title matches the search term', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues?search=login`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data.some((i: any) => i.id === issueBacklogLow)).toBe(true);
		// Should not include unrelated issues
		expect(
			body.data.every((i: any) => {
				const title: string = i.title.toLowerCase();
				return title.includes('login');
			}),
		).toBe(true);
	});

	it('search is case-insensitive', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues?search=REFACTOR`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.some((i: any) => i.id === issueBacklogHigh)).toBe(true);
	});

	it('returns empty when search matches nothing', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues?search=zzz_no_match_zzz`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toHaveLength(0);
		expect(body.meta.total).toBe(0);
	});
});

describe('issues list — status filter', () => {
	it('filters to a single status', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues?status=in_progress`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data.every((i: any) => i.status === 'in_progress')).toBe(true);
		expect(body.data.some((i: any) => i.id === issueInProgressUrgent)).toBe(true);
	});

	it('filters using comma-separated multiple statuses', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues?status=open,in_progress`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(2);
		expect(body.data.every((i: any) => ['open', 'in_progress'].includes(i.status))).toBe(true);
		expect(body.data.some((i: any) => i.id === issueOpenMedium)).toBe(true);
		expect(body.data.some((i: any) => i.id === issueInProgressUrgent)).toBe(true);
	});

	it('excludes issues not matching the status filter', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues?status=done`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.some((i: any) => i.status !== 'done')).toBe(false);
		expect(body.data.some((i: any) => i.id === issueDoneHigh)).toBe(true);
	});
});

describe('issues list — priority filter', () => {
	it('filters to a single priority', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues?priority=urgent`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data.every((i: any) => i.priority === 'urgent')).toBe(true);
		expect(body.data.some((i: any) => i.id === issueInProgressUrgent)).toBe(true);
	});

	it('filters using comma-separated multiple priorities', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues?priority=high,urgent`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(2);
		expect(body.data.every((i: any) => ['high', 'urgent'].includes(i.priority))).toBe(true);
		expect(body.data.some((i: any) => i.id === issueBacklogHigh)).toBe(true);
		expect(body.data.some((i: any) => i.id === issueInProgressUrgent)).toBe(true);
	});

	it('excludes issues not matching the priority filter', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues?priority=low`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.every((i: any) => i.priority === 'low')).toBe(true);
		expect(body.data.some((i: any) => i.id === issueBacklogLow)).toBe(true);
	});
});

describe('issues list — project_id filter', () => {
	it('returns only issues belonging to the specified project', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues?project_id=${projectId}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data.every((i: any) => i.project_id === projectId)).toBe(true);
		// Issues from otherProjectId must not appear
		expect(body.data.some((i: any) => i.id === issueOpenMedium)).toBe(false);
		expect(body.data.some((i: any) => i.id === issueInProgressUrgent)).toBe(false);
	});

	it('returns only issues belonging to the other project', async () => {
		const res = await app.request(
			`/api/companies/${companyId}/issues?project_id=${otherProjectId}`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(2);
		expect(body.data.every((i: any) => i.project_id === otherProjectId)).toBe(true);
		expect(body.data.some((i: any) => i.id === issueOpenMedium)).toBe(true);
		expect(body.data.some((i: any) => i.id === issueInProgressUrgent)).toBe(true);
	});

	it('returns empty list for a non-existent project_id', async () => {
		const fakeId = '00000000-0000-0000-0000-000000000000';
		const res = await app.request(`/api/companies/${companyId}/issues?project_id=${fakeId}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toHaveLength(0);
	});
});

describe('issues list — assignee_id filter', () => {
	it('returns only issues assigned to the specified member', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues?assignee_id=${memberId}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data.every((i: any) => i.assignee_id === memberId)).toBe(true);
		expect(body.data.some((i: any) => i.id === issueInProgressUrgent)).toBe(true);
	});

	it('returns empty list when assignee has no issues', async () => {
		const otherMember = await db.query<{ id: string }>(
			`INSERT INTO members (company_id, display_name, member_type)
             VALUES ($1, 'No Issues Member', 'agent') RETURNING id`,
			[companyId],
		);
		const res = await app.request(
			`/api/companies/${companyId}/issues?assignee_id=${otherMember.rows[0].id}`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toHaveLength(0);
	});
});

describe('issues list — sort parameter', () => {
	it('sorts by created_at ascending', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues?sort=created_at:asc`, {
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
		const res = await app.request(`/api/companies/${companyId}/issues?sort=created_at:desc`, {
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
		const res = await app.request(`/api/companies/${companyId}/issues?sort=number:asc`, {
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
		const res = await app.request(`/api/companies/${companyId}/issues?sort=invalid_field:asc`, {
			headers: authHeader(token),
		});
		// Should not error — falls back to created_at desc
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body.data)).toBe(true);
	});
});

describe('issues list — combined filters', () => {
	it('combines status and priority filters', async () => {
		const res = await app.request(
			`/api/companies/${companyId}/issues?status=backlog&priority=high`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.every((i: any) => i.status === 'backlog' && i.priority === 'high')).toBe(true);
		expect(body.data.some((i: any) => i.id === issueBacklogHigh)).toBe(true);
		// issueBacklogLow has low priority — must be excluded
		expect(body.data.some((i: any) => i.id === issueBacklogLow)).toBe(false);
	});

	it('combines project_id and status filters', async () => {
		const res = await app.request(
			`/api/companies/${companyId}/issues?project_id=${otherProjectId}&status=in_progress`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(
			body.data.every((i: any) => i.project_id === otherProjectId && i.status === 'in_progress'),
		).toBe(true);
		expect(body.data.some((i: any) => i.id === issueInProgressUrgent)).toBe(true);
	});

	it('combines search with status filter', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues?search=auth&status=backlog`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.every((i: any) => i.status === 'backlog')).toBe(true);
		expect(body.data.some((i: any) => i.id === issueBacklogHigh)).toBe(true);
	});

	it('combines assignee_id and priority filters', async () => {
		const res = await app.request(
			`/api/companies/${companyId}/issues?assignee_id=${memberId}&priority=urgent`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.every((i: any) => i.assignee_id === memberId && i.priority === 'urgent')).toBe(
			true,
		);
		expect(body.data.some((i: any) => i.id === issueInProgressUrgent)).toBe(true);
	});
});

describe('issues list — assignee_type and has_active_run', () => {
	const findIssue = (data: any[], id: string) => data.find((i: any) => i.id === id);

	it('returns assignee_type="agent" for an agent member assignee', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues?per_page=50`, {
			headers: authHeader(token),
		});
		const body = await res.json();
		const issue = findIssue(body.data, issueInProgressUrgent);
		expect(issue.assignee_type).toBe('agent');
	});

	it('returns has_active_run=false when no heartbeat_runs row exists', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues?per_page=50`, {
			headers: authHeader(token),
		});
		const body = await res.json();
		const issue = findIssue(body.data, issueInProgressUrgent);
		expect(issue.has_active_run).toBe(false);
	});

	it('returns has_active_run=true when a running heartbeat_runs row exists', async () => {
		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, company_id, issue_id, status, started_at)
			 VALUES ($1, $2, $3, 'running', now()) RETURNING id`,
			[memberId, companyId, issueInProgressUrgent],
		);
		try {
			const res = await app.request(`/api/companies/${companyId}/issues?per_page=50`, {
				headers: authHeader(token),
			});
			const body = await res.json();
			const issue = findIssue(body.data, issueInProgressUrgent);
			expect(issue.has_active_run).toBe(true);
		} finally {
			await db.query(`DELETE FROM heartbeat_runs WHERE id = $1`, [run.rows[0].id]);
		}
	});

	it('returns has_active_run=true for a queued run', async () => {
		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, company_id, issue_id, status, started_at)
			 VALUES ($1, $2, $3, 'queued', now()) RETURNING id`,
			[memberId, companyId, issueInProgressUrgent],
		);
		try {
			const res = await app.request(`/api/companies/${companyId}/issues?per_page=50`, {
				headers: authHeader(token),
			});
			const body = await res.json();
			const issue = findIssue(body.data, issueInProgressUrgent);
			expect(issue.has_active_run).toBe(true);
		} finally {
			await db.query(`DELETE FROM heartbeat_runs WHERE id = $1`, [run.rows[0].id]);
		}
	});

	it('returns has_active_run=false once the run transitions to a terminal status', async () => {
		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, company_id, issue_id, status, started_at, finished_at)
			 VALUES ($1, $2, $3, 'succeeded', now(), now()) RETURNING id`,
			[memberId, companyId, issueInProgressUrgent],
		);
		try {
			const res = await app.request(`/api/companies/${companyId}/issues?per_page=50`, {
				headers: authHeader(token),
			});
			const body = await res.json();
			const issue = findIssue(body.data, issueInProgressUrgent);
			expect(issue.has_active_run).toBe(false);
		} finally {
			await db.query(`DELETE FROM heartbeat_runs WHERE id = $1`, [run.rows[0].id]);
		}
	});

	it('single-issue GET returns assignee_type', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues/${issueInProgressUrgent}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.assignee_type).toBe('agent');
	});
});

describe('issues PATCH — block assignee change while agent is running', () => {
	let otherMemberId: string;

	beforeAll(async () => {
		const res = await db.query<{ id: string }>(
			`INSERT INTO members (company_id, display_name, member_type)
             VALUES ($1, 'Dev Two', 'agent') RETURNING id`,
			[companyId],
		);
		otherMemberId = res.rows[0].id;
	});

	const insertRun = async (status: 'running' | 'queued' | 'succeeded') => {
		const finished = status === 'succeeded' ? ', now()' : '';
		const finishedCol = status === 'succeeded' ? ', finished_at' : '';
		const r = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, company_id, issue_id, status, started_at${finishedCol})
             VALUES ($1, $2, $3, $4, now()${finished}) RETURNING id`,
			[memberId, companyId, issueInProgressUrgent, status],
		);
		return r.rows[0].id;
	};

	const deleteRun = async (id: string) => {
		await db.query(`DELETE FROM heartbeat_runs WHERE id = $1`, [id]);
	};

	const getAssignee = async () => {
		const r = await db.query<{ assignee_id: string }>(
			'SELECT assignee_id FROM issues WHERE id = $1',
			[issueInProgressUrgent],
		);
		return r.rows[0].assignee_id;
	};

	it('returns 409 when changing assignee while a running run exists', async () => {
		const runId = await insertRun('running');
		try {
			const before = await getAssignee();
			const res = await app.request(`/api/companies/${companyId}/issues/${issueInProgressUrgent}`, {
				method: 'PATCH',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ assignee_id: otherMemberId }),
			});
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
			const res = await app.request(`/api/companies/${companyId}/issues/${issueInProgressUrgent}`, {
				method: 'PATCH',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ assignee_id: otherMemberId }),
			});
			expect(res.status).toBe(409);
		} finally {
			await deleteRun(runId);
		}
	});

	it('allows assignee change after the run reaches a terminal status', async () => {
		const runId = await insertRun('succeeded');
		try {
			const res = await app.request(`/api/companies/${companyId}/issues/${issueInProgressUrgent}`, {
				method: 'PATCH',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ assignee_id: otherMemberId }),
			});
			expect(res.status).toBe(200);
			expect(await getAssignee()).toBe(otherMemberId);
		} finally {
			await deleteRun(runId);
			await db.query(`UPDATE issues SET assignee_id = $1 WHERE id = $2`, [
				memberId,
				issueInProgressUrgent,
			]);
		}
	});

	it('allows a no-op assignee PATCH (same value) while a run is active', async () => {
		const runId = await insertRun('running');
		try {
			const current = await getAssignee();
			const res = await app.request(`/api/companies/${companyId}/issues/${issueInProgressUrgent}`, {
				method: 'PATCH',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ assignee_id: current }),
			});
			expect(res.status).toBe(200);
			expect(await getAssignee()).toBe(current);
		} finally {
			await deleteRun(runId);
		}
	});

	it('allows patching non-assignee fields while a run is active', async () => {
		const runId = await insertRun('running');
		try {
			const res = await app.request(`/api/companies/${companyId}/issues/${issueInProgressUrgent}`, {
				method: 'PATCH',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ priority: 'high' }),
			});
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.data.priority).toBe('high');
		} finally {
			await deleteRun(runId);
			await db.query(`UPDATE issues SET priority = 'urgent' WHERE id = $1`, [
				issueInProgressUrgent,
			]);
		}
	});
});
