import {
	DEFAULT_TEAM_ID,
	MAX_TASK_SUGGESTIONS_PER_TASK,
	TASK_SUGGESTION_CADENCE_RULES,
	WakeupSource,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { getToolDefs } from '../src/mcp/server';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	instanceCeoId,
	mintAgentToken,
} from './helpers/app';
import { callMcpTool } from './helpers/mcp-call';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let projectSlug: string;
let captainId: string;
let ceoId: string;

interface SuggestResult {
	approval_id?: string;
	status?: string;
	payload?: Record<string, unknown>;
	error?: string;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Task Suggestions Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Stock Watch' });
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;

	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain' LIMIT 1`,
		[teamId],
	);
	captainId = captain.rows[0].id;
	ceoId = await instanceCeoId(db);
});

afterAll(async () => {
	await safeClose(db);
});

async function insertTask(
	title: string,
	opts: { labels?: string[]; status?: string; assigneeId?: string | null } = {},
): Promise<{ id: string; identifier: string }> {
	const meta = await db.query<{ task_prefix: string; number: number }>(
		`SELECT p.task_prefix, next_project_task_number(p.id) AS number FROM projects p WHERE p.id = $1`,
		[projectId],
	);
	const n = meta.rows[0].number;
	const r = await db.query<{ id: string; identifier: string }>(
		`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, status, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::task_status, $8::jsonb)
		 RETURNING id, identifier`,
		[
			teamId,
			projectId,
			opts.assigneeId ?? null,
			n,
			`${meta.rows[0].task_prefix}-${n}`,
			title,
			opts.status ?? 'in_progress',
			JSON.stringify(opts.labels ?? []),
		],
	);
	return r.rows[0];
}

/** The CEO's own suggestions task in the project, open, with a run token scoped to it. */
async function suggestionsTask(): Promise<{ id: string; identifier: string; token: string }> {
	const task = await insertTask('Suggest starter tasks', {
		labels: ['internal', 'task-suggestions'],
		assigneeId: ceoId,
	});
	const minted = await mintAgentToken(db, masterKeyManager, ceoId, teamId, task.id);
	return { ...task, token: minted.token };
}

async function suggest(bearer: string, args: Record<string, unknown>): Promise<SuggestResult> {
	return (await callMcpTool(app, bearer, 'suggest_task', {
		project: projectSlug,
		...args,
	})) as SuggestResult;
}

async function resolve(approvalId: string, status: 'approved' | 'denied'): Promise<void> {
	const res = await app.request(`/api/approvals/${approvalId}/resolve`, {
		method: 'POST',
		headers: { ...authHeader(token), 'content-type': 'application/json' },
		body: JSON.stringify({ status }),
	});
	expect(res.status).toBe(200);
}

async function patchCadence(approvalId: string, cadence: unknown): Promise<Response> {
	return app.request(`/api/approvals/${approvalId}`, {
		method: 'PATCH',
		headers: { ...authHeader(token), 'content-type': 'application/json' },
		body: JSON.stringify({ cadence }),
	});
}

async function card(approvalId: string) {
	const r = await db.query<{
		task_id: string;
		content: Record<string, unknown>;
		chosen_option: Record<string, unknown> | null;
	}>(
		`SELECT task_id, content, chosen_option FROM task_comments
		 WHERE content->>'kind' = 'task_suggestion' AND content->>'approval_id' = $1`,
		[approvalId],
	);
	expect(r.rows).toHaveLength(1);
	return r.rows[0];
}

async function createdTask(identifier: string) {
	const r = await db.query<{
		id: string;
		title: string;
		assignee_id: string;
		rules: string | null;
		status: string;
	}>(
		`SELECT id, title, assignee_id, rules, status::text AS status FROM tasks
		 WHERE project_id = $1 AND identifier = $2`,
		[projectId, identifier],
	);
	expect(r.rows).toHaveLength(1);
	return r.rows[0];
}

describe('suggest_task: who may call it, and where', () => {
	it('is registered with the cadence rule in its description', () => {
		const def = getToolDefs().find((t) => t.name === 'suggest_task');
		expect(def).toBeDefined();
		expect(def?.description).toContain('only for work that repeats by nature');
	});

	it('is refused for a non-agent caller', async () => {
		const result = await suggest(token, { kind: 'report', title: 'x', task_id: 'none' });
		expect(result.error).toMatch(/only callable by agents/);
	});

	it('is refused for the Captain', async () => {
		const { token: captainToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			null,
			{ projectId },
		);
		const result = await suggest(captainToken, {
			kind: 'report',
			title: 'Captain report',
			task_id: 'none',
		});
		expect(result.error).toMatch(/Only the CEO/);
	});

	it('is refused on the HQ project', async () => {
		const { token: hqToken } = await mintAgentToken(
			db,
			masterKeyManager,
			ceoId,
			DEFAULT_TEAM_ID,
			null,
			{ crossProject: true },
		);
		const result = (await callMcpTool(app, hqToken, 'suggest_task', {
			project: 'hq',
			kind: 'report',
			title: 'HQ report',
			task_id: 'none',
		})) as SuggestResult;
		expect(result.error).toMatch(/HQ project/);
	});

	it('is refused on a task that is not an open task-suggestions task', async () => {
		const host = await suggestionsTask();
		const other = await insertTask('Ordinary task');
		const wrong = await suggest(host.token, {
			kind: 'report',
			title: 'On the wrong task',
			task_id: other.identifier,
		});
		expect(wrong.error).toMatch(/open task-suggestions task/);

		const closed = await insertTask('Closed suggestions', {
			labels: ['internal', 'task-suggestions'],
			status: 'done',
		});
		const onClosed = await suggest(host.token, {
			kind: 'report',
			title: 'On a closed task',
			task_id: closed.identifier,
		});
		expect(onClosed.error).toMatch(/open task-suggestions task/);
	});
});

describe('suggest_task: repeat rules per kind', () => {
	it('refuses a cadence on work that does not repeat', async () => {
		const host = await suggestionsTask();
		for (const kind of ['admin_input', 'connection', 'deliverable']) {
			const result = await suggest(host.token, {
				kind,
				title: `No repeat for ${kind}`,
				cadence: 'weekly',
				task_id: host.id,
			});
			expect(result.error).toMatch(/does not repeat/);
		}
	});

	it('refuses repeating work without a cadence', async () => {
		const host = await suggestionsTask();
		const result = await suggest(host.token, {
			kind: 'recurring',
			title: 'News catch-up',
			task_id: host.id,
		});
		expect(result.error).toMatch(/needs a cadence/);
	});

	it('refuses "once" from the CEO: it is only the admin\'s choice', async () => {
		const host = await suggestionsTask();
		const result = await suggest(host.token, {
			kind: 'recurring',
			title: 'News catch-up once',
			cadence: 'once',
			task_id: host.id,
		});
		expect(result.error).toMatch(/daily, weekly or monthly/);
	});

	it('takes a report with or without a cadence', async () => {
		const host = await suggestionsTask();
		const periodic = await suggest(host.token, {
			kind: 'report',
			title: 'Weekly portfolio report',
			cadence: 'weekly',
			task_id: host.id,
		});
		expect(periodic.status).toBe('pending');
		const single = await suggest(host.token, {
			kind: 'report',
			title: 'Visual report on current holdings',
			task_id: host.id,
		});
		expect(single.status).toBe('pending');
		expect(single.payload?.suggested_cadence).toBeNull();
	});
});

describe('suggest_task: no duplicates, at most eight per task', () => {
	it('refuses a title that matches an open task or a pending suggestion, ignoring case', async () => {
		const host = await suggestionsTask();
		await insertTask('Connect the online broker');
		const againstTask = await suggest(host.token, {
			kind: 'connection',
			title: '  connect the ONLINE broker ',
			task_id: host.id,
		});
		expect(againstTask.error).toMatch(/open task in this project/);

		const first = await suggest(host.token, {
			kind: 'admin_input',
			title: 'List the stocks to watch',
			task_id: host.id,
		});
		expect(first.status).toBe('pending');
		const againstSuggestion = await suggest(host.token, {
			kind: 'admin_input',
			title: 'List the stocks to watch',
			task_id: host.id,
		});
		expect(againstSuggestion.error).toMatch(/pending suggestion/);
	});

	it('allows a title that only a closed task carries', async () => {
		const host = await suggestionsTask();
		await insertTask('Draft the first stock report', { status: 'done' });
		const result = await suggest(host.token, {
			kind: 'deliverable',
			title: 'Draft the first stock report',
			task_id: host.id,
		});
		expect(result.status).toBe('pending');
	});

	it(`stops at ${MAX_TASK_SUGGESTIONS_PER_TASK} cards on one task`, async () => {
		const host = await suggestionsTask();
		for (let i = 0; i < MAX_TASK_SUGGESTIONS_PER_TASK; i++) {
			const ok = await suggest(host.token, {
				kind: 'deliverable',
				title: `Cap filler ${i}`,
				task_id: host.id,
			});
			expect(ok.status).toBe('pending');
		}
		const over = await suggest(host.token, {
			kind: 'deliverable',
			title: 'One too many',
			task_id: host.id,
		});
		expect(over.error).toMatch(/already has 8 suggestions/);
	});
});

describe('suggest_task: approve and deny', () => {
	it('files a card on the suggestions task carrying the CEO cadence', async () => {
		const host = await suggestionsTask();
		const result = await suggest(host.token, {
			kind: 'recurring',
			title: 'Catch up on market news',
			description: 'Read the day news and update the analysis.',
			cadence: 'daily',
			task_id: host.identifier,
		});
		expect(result.status).toBe('pending');
		const c = await card(result.approval_id as string);
		expect(c.task_id).toBe(host.id);
		expect(c.content).toMatchObject({
			title: 'Catch up on market news',
			kind: 'task_suggestion',
			suggestion_kind: 'recurring',
			suggested_cadence: 'daily',
			cadence: 'daily',
		});
		expect(c.chosen_option).toBeNull();
	});

	it('approve creates the Captain task, blocked by the open planning task, and wakes the CEO', async () => {
		const host = await suggestionsTask();
		// Project creation filed the Captain's planning task; it is still open.
		const open = await db.query<{ id: string; identifier: string }>(
			`SELECT id, identifier FROM tasks
			 WHERE project_id = $1 AND labels @> '["planning"]'::jsonb
			   AND status NOT IN ('done', 'cancelled')`,
			[projectId],
		);
		expect(open.rows).toHaveLength(1);
		const planning = open.rows[0];
		const result = await suggest(host.token, {
			kind: 'report',
			title: 'Weekly report with charts',
			cadence: 'weekly',
			task_id: host.id,
		});
		await resolve(result.approval_id as string, 'approved');

		const c = await card(result.approval_id as string);
		expect(c.chosen_option?.status).toBe('approved');
		expect(c.chosen_option?.blocked_by_identifier).toBe(planning.identifier);
		const created = await createdTask(c.chosen_option?.created_task_identifier as string);
		expect(created.title).toBe('Weekly report with charts');
		expect(created.assignee_id).toBe(captainId);
		expect(created.rules).toBe(TASK_SUGGESTION_CADENCE_RULES.weekly);
		expect(created.status).toBe('blocked');
		const dep = await db.query(
			'SELECT 1 FROM task_dependencies WHERE task_id = $1 AND blocked_by_task_id = $2',
			[created.id, planning.id],
		);
		expect(dep.rows).toHaveLength(1);

		const wake = await db.query<{ member_id: string; source: string }>(
			`SELECT member_id, source FROM agent_wakeup_requests
			 WHERE payload->>'approval_id' = $1 AND payload->>'reason' = 'task_suggestion_resolved'`,
			[result.approval_id],
		);
		expect(wake.rows[0]?.member_id).toBe(ceoId);
		expect(wake.rows[0]?.source).toBe(WakeupSource.ApprovalResolved);

		// Planning done: later approvals in this file start at once.
		await db.query(`UPDATE tasks SET status = 'done'::task_status WHERE id = $1`, [planning.id]);
	});

	it('approve with no open planning task creates a task that is not blocked', async () => {
		const host = await suggestionsTask();
		const result = await suggest(host.token, {
			kind: 'connection',
			title: 'Connect the broker read-only',
			task_id: host.id,
		});
		await resolve(result.approval_id as string, 'approved');

		const c = await card(result.approval_id as string);
		expect(c.chosen_option?.blocked_by_identifier).toBeNull();
		const created = await createdTask(c.chosen_option?.created_task_identifier as string);
		expect(created.rules).toBeNull();
		expect(created.status).not.toBe('blocked');
	});

	it('deny creates no task, flips the card and wakes the CEO', async () => {
		const host = await suggestionsTask();
		const result = await suggest(host.token, {
			kind: 'deliverable',
			title: 'A denied deliverable',
			task_id: host.id,
		});
		await resolve(result.approval_id as string, 'denied');

		const c = await card(result.approval_id as string);
		expect(c.chosen_option?.status).toBe('denied');
		const tasks = await db.query('SELECT 1 FROM tasks WHERE project_id = $1 AND title = $2', [
			projectId,
			'A denied deliverable',
		]);
		expect(tasks.rows).toHaveLength(0);
		const wake = await db.query<{ member_id: string }>(
			`SELECT member_id FROM agent_wakeup_requests WHERE payload->>'approval_id' = $1`,
			[result.approval_id],
		);
		expect(wake.rows[0]?.member_id).toBe(ceoId);
	});
});

describe('PATCH /approvals/:id - the repeat choice on a card', () => {
	it('switches to another cadence and refreshes the card', async () => {
		const host = await suggestionsTask();
		const result = await suggest(host.token, {
			kind: 'recurring',
			title: 'Rebalance check',
			cadence: 'weekly',
			task_id: host.id,
		});
		const res = await patchCadence(result.approval_id as string, 'monthly');
		expect(res.status).toBe(200);
		const row = (await res.json()).data as { payload: Record<string, unknown> };
		expect(row.payload.cadence).toBe('monthly');
		expect(row.payload.suggested_cadence).toBe('weekly');
		expect((await card(result.approval_id as string)).content.cadence).toBe('monthly');

		await resolve(result.approval_id as string, 'approved');
		const c = await card(result.approval_id as string);
		const created = await createdTask(c.chosen_option?.created_task_identifier as string);
		expect(created.rules).toBe(TASK_SUGGESTION_CADENCE_RULES.monthly);
	});

	it('"just once" makes the approved task a single run with no rules', async () => {
		const host = await suggestionsTask();
		const result = await suggest(host.token, {
			kind: 'recurring',
			title: 'News catch-up, picked once',
			cadence: 'daily',
			task_id: host.id,
		});
		expect((await patchCadence(result.approval_id as string, 'once')).status).toBe(200);
		await resolve(result.approval_id as string, 'approved');

		const c = await card(result.approval_id as string);
		expect(c.content.cadence).toBe('once');
		const created = await createdTask(c.chosen_option?.created_task_identifier as string);
		expect(created.rules).toBeNull();
	});

	it('refuses a cadence on a suggestion that does not repeat, and a bad value', async () => {
		const host = await suggestionsTask();
		const flat = await suggest(host.token, {
			kind: 'admin_input',
			title: 'Give the risk limits',
			task_id: host.id,
		});
		const onFlat = await patchCadence(flat.approval_id as string, 'weekly');
		expect(onFlat.status).toBe(400);
		expect((await onFlat.json()).error.message).toMatch(/does not repeat/);

		const repeating = await suggest(host.token, {
			kind: 'recurring',
			title: 'Dividend calendar sweep',
			cadence: 'monthly',
			task_id: host.id,
		});
		expect((await patchCadence(repeating.approval_id as string, 'hourly')).status).toBe(400);
	});

	it('writes nothing when the choice is unchanged, and refuses once decided', async () => {
		const host = await suggestionsTask();
		const result = await suggest(host.token, {
			kind: 'recurring',
			title: 'Earnings season watch',
			cadence: 'weekly',
			task_id: host.id,
		});
		const id = result.approval_id as string;
		const before = await db.query<{ xmin: string }>(
			'SELECT xmin::text AS xmin FROM approvals WHERE id = $1',
			[id],
		);
		const same = await patchCadence(id, 'weekly');
		expect(same.status).toBe(200);
		const after = await db.query<{ xmin: string }>(
			'SELECT xmin::text AS xmin FROM approvals WHERE id = $1',
			[id],
		);
		expect(after.rows[0].xmin).toBe(before.rows[0].xmin);

		await resolve(id, 'denied');
		expect((await patchCadence(id, 'daily')).status).toBe(409);
	});
});
